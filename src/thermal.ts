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
  DECAY_RATE,
  DECAY_THRESHOLD_HOURS,
  STALE_THRESHOLD_DAYS,
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
  // Use a CTE to pre-compute the effective decay rate per entity.
  // bit_count returns bigint, so cast to real for float arithmetic.
  const result = await db.execute(sql`
    WITH decay_rates AS (
      SELECT
        e.id,
        CASE
          WHEN bit_count(COALESCE(e.access_bitmap, 0)::bit(7))::real >= ${PATTERN_THRESHOLD_BITS}::real
          THEN LEAST(1.0::real, ${DECAY_RATE}::real + (1.0::real - ${DECAY_RATE}::real) * (
            ${PATTERN_MULTIPLIER_BASE}::real - 1.0::real
            + (bit_count(COALESCE(e.access_bitmap, 0)::bit(7))::real - ${PATTERN_THRESHOLD_BITS}::real)
              * ${PATTERN_MULTIPLIER_PER_BIT}::real
          ))
          ELSE ${DECAY_RATE}::real
        END AS effective_rate
      FROM public.entities e
      WHERE e.last_accessed_at < NOW() - (INTERVAL '1 hour' * ${DECAY_THRESHOLD_HOURS})
    )
    UPDATE public.entities e
    SET
      temperature = GREATEST(0.0, e.temperature * dr.effective_rate),
      tier = CASE
        WHEN GREATEST(0.0, e.temperature * dr.effective_rate) > ${TIER_HOT} THEN 'HOT'
        WHEN GREATEST(0.0, e.temperature * dr.effective_rate) > ${TIER_WARM} THEN 'WARM'
        ELSE 'COLD'
      END,
      importance = CASE
        WHEN e.access_count >= ${IMPORTANCE_DRIFT_ACCESS_MIN}
          THEN LEAST(${IMPORTANCE_CAP}::real, e.importance + ${IMPORTANCE_DRIFT_UP}::real)
        WHEN e.last_accessed_at < NOW() - (INTERVAL '1 day' * ${IMPORTANCE_DRIFT_NEGLECT_DAYS})
          THEN GREATEST(${IMPORTANCE_FLOOR}::real, e.importance - ${IMPORTANCE_DRIFT_DOWN}::real)
        ELSE e.importance
      END
    FROM decay_rates dr
    WHERE e.id = dr.id
    RETURNING e.id, e.name, e.type, e.observations, e.temperature, e.tier, e.source, e.importance, e.access_count
  `);

  let synced = 0;
  for (const row of result.rows as any[]) {
    try {
      syncToFile({
        id: row.id,
        name: row.name,
        type: row.type,
        observations: (row.observations as string) || '',
        temperature: row.temperature ?? 0,
        tier: row.tier ?? 'COLD',
        source: row.source,
        importance: row.importance ?? 0.5,
        accessCount: row.access_count ?? 0,
      });
      synced++;
    } catch {
      // Non-fatal: Postgres is the source of truth
    }
  }

  // Flag memories COLD for 30+ days as stale
  await db.execute(sql`
    UPDATE public.entities
    SET stale = true
    WHERE tier = 'COLD'
      AND last_accessed_at < NOW() - (INTERVAL '1 day' * ${STALE_THRESHOLD_DAYS})
      AND stale = false
  `);

  return { count: result.rows.length, synced };
}
