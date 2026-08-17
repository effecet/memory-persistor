/**
 * Thermal decay and temperature bump logic (v3: adaptive model).
 *
 * Temperature range: 0.0 (cold) → 1.0 (hot)
 * Tier boundaries: HOT > 0.7, WARM 0.3–0.7, COLD < 0.3
 *
 * v3 enhancements:
 * - Cascade bumps: bumping a memory also bumps direct neighbors
 * - Access bitmap: 7-bit integer tracking day-of-week access patterns
 * - Pattern-aware decay: regular access patterns slow decay
 * - Auto-importance drift: importance increases/decreases based on usage
 */
import { db } from './db.js';
import { entities } from './schema.js';
import { eq, sql } from 'drizzle-orm';
import {
  BUMP_AMOUNT,
  CASCADE_FACTOR,
  TIER_HOT,
  TIER_WARM,
  PATTERN_THRESHOLD_BITS,
  PATTERN_MULTIPLIER_BASE,
  PATTERN_MULTIPLIER_PER_BIT,
  IMPORTANCE_DRIFT_UP,
  IMPORTANCE_DRIFT_DOWN,
  IMPORTANCE_DRIFT_ACCESS_MIN,
  IMPORTANCE_DRIFT_NEGLECT_DAYS,
  IMPORTANCE_CAP,
  IMPORTANCE_FLOOR,
} from './config.js';
import { syncToFile } from './file-sync.js';

export function computeTier(temperature: number): 'HOT' | 'WARM' | 'COLD' {
  if (temperature > TIER_HOT) return 'HOT';
  if (temperature > TIER_WARM) return 'WARM';
  return 'COLD';
}

// ── Pattern multiplier (pure function, exported for unit tests) ──────────

/**
 * Compute decay multiplier based on access bitmap.
 * If 3+ day-of-week bits are set, the memory has a regular pattern
 * and decays slower (multiplier > 1.0 means slower decay).
 */
export function computePatternMultiplier(bitmap: number): number {
  const bitCount = popcount(bitmap & 0b1111111);
  if (bitCount < PATTERN_THRESHOLD_BITS) return 1.0;
  return PATTERN_MULTIPLIER_BASE + (bitCount - PATTERN_THRESHOLD_BITS) * PATTERN_MULTIPLIER_PER_BIT;
}

/** Count set bits in a 7-bit integer. */
function popcount(n: number): number {
  let count = 0;
  let v = n;
  while (v) {
    count += v & 1;
    v >>= 1;
  }
  return count;
}

// ── Auto-importance drift (pure function, exported for unit tests) ───────

interface ImportanceDriftInput {
  accessCount: number;
  importance: number;
  daysSinceAccess: number;
}

/**
 * Compute new importance after drift.
 * - access_count >= 5 → importance += DRIFT_UP (cap 0.9)
 * - 60+ days no access → importance -= DRIFT_DOWN (floor 0.1)
 * - Otherwise → no change
 */
export function computeImportanceDrift(input: ImportanceDriftInput): number {
  let imp = input.importance;

  if (input.accessCount >= IMPORTANCE_DRIFT_ACCESS_MIN) {
    imp = Math.min(IMPORTANCE_CAP, imp + IMPORTANCE_DRIFT_UP);
  } else if (input.daysSinceAccess >= IMPORTANCE_DRIFT_NEGLECT_DAYS) {
    imp = Math.max(IMPORTANCE_FLOOR, imp - IMPORTANCE_DRIFT_DOWN);
  }

  return imp;
}

// ── Bump (with cascade) ─────────────────────────────────────────────────

/**
 * Bump a memory's temperature on access.
 * Increments access_count, sets day-of-week bit in access_bitmap,
 * updates last_accessed_at, and recomputes tier.
 * Then cascades a reduced bump to direct neighbors.
 */
export async function bump(id: string): Promise<void> {
  // Day-of-week bit: 0=Sun, 1=Mon, ... 6=Sat
  const dayBit = 1 << new Date().getDay();

  // Single statement: primary bump + cascade bump via CTE.
  // Combining into one query avoids connection pool exhaustion when
  // recall fires bump() for multiple results concurrently.
  await db.execute(sql`
    WITH primary_bump AS (
      UPDATE public.entities
      SET
        temperature = LEAST(1.0, temperature + ${BUMP_AMOUNT}::real),
        tier = CASE
          WHEN LEAST(1.0, temperature + ${BUMP_AMOUNT}::real) > ${TIER_HOT}::real THEN 'HOT'
          WHEN LEAST(1.0, temperature + ${BUMP_AMOUNT}::real) > ${TIER_WARM}::real THEN 'WARM'
          ELSE 'COLD'
        END,
        access_count = COALESCE(access_count, 0) + 1,
        access_bitmap = COALESCE(access_bitmap, 0) | ${dayBit},
        last_accessed_at = NOW()
      WHERE id = ${id}
      RETURNING id
    )
    UPDATE public.entities e
    SET
      temperature = LEAST(1.0::real, e.temperature + ${BUMP_AMOUNT}::real * ${CASCADE_FACTOR}::real * r.weight),
      tier = CASE
        WHEN LEAST(1.0::real, e.temperature + ${BUMP_AMOUNT}::real * ${CASCADE_FACTOR}::real * r.weight) > ${TIER_HOT}::real THEN 'HOT'
        WHEN LEAST(1.0::real, e.temperature + ${BUMP_AMOUNT}::real * ${CASCADE_FACTOR}::real * r.weight) > ${TIER_WARM}::real THEN 'WARM'
        ELSE 'COLD'
      END
    FROM public.memory_relations r, primary_bump p
    WHERE (
      (r.from_id = p.id AND r.to_id = e.id)
      OR (r.to_id = p.id AND r.from_id = e.id)
    )
    AND e.id != p.id
  `);
}

// ── Decay all (pattern-aware + importance drift) ─────────────────────────

/**
 * Decay all memories not accessed within the threshold window.
 * Pattern-aware: memories with regular access patterns decay slower.
 * Also drifts importance up/down based on usage.
 * Syncs updated temperature/tier to markdown files.
 */
export async function decayAll(): Promise<{ count: number; synced: number }> {
  // The decay contract lives in ONE place: drizzle/0010_thermal_decay_function.sql,
  // pinned against src/config.ts by tests/test_thermal_decay_migration.py. It used
  // to exist twice — here, and hand-transcribed into a live cron.job row on the
  // managed instance that was in no migration and no script.
  //
  // TypeScript keeps only the file-sync half below, which SQL structurally cannot
  // own: Postgres has no access to any machine's filesystem, which is exactly why
  // the scheduled pg_cron path leaves markdown frontmatter stale.
  const result = await db.execute(sql`SELECT * FROM public.memory_thermal_decay()`);

  const rows = result.rows as any[];

  // Rank the index once per directory, on the LAST write into that directory.
  // Earlier writes to the same dir skip the thermal lookup entirely (null); the
  // final one fetches (undefined) and therefore sees every file in the dir,
  // decayed or not.
  //
  // Passing a map built from `rows` instead would be wrong: it covers only the
  // entities that decayed, so every non-decayed neighbour in the same directory
  // would resolve as an orphan and be ranked at temperature 0 — a single decay
  // run would evict them all from the index.
  const lastIndexInDir = new Map<string, number>();
  rows.forEach((row, i) => lastIndexInDir.set(String(row.source), i));

  let synced = 0;
  for (const [i, row] of rows.entries()) {
    try {
      await syncToFile({
        id: row.id,
        name: row.name,
        type: row.type,
        observations: (row.observations as string) || '',
        temperature: row.temperature ?? 0,
        tier: row.tier ?? 'COLD',
        source: row.source,
        importance: row.importance ?? 0.5,
        accessCount: row.access_count ?? 0,
      }, lastIndexInDir.get(String(row.source)) === i ? undefined : null);
      synced++;
    } catch {
      // Non-fatal: Postgres is the source of truth
    }
  }

  // The stale-flag pass is NOT repeated here: memory_thermal_decay() already
  // runs it as its second statement, after the decay pass, so it sees the tiers
  // that pass just wrote. Re-running it would be a second copy of the same
  // contract — the exact duplication this refactor removed.

  return { count: result.rows.length, synced };
}
