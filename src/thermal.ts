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
  CUTOFF_MAX_AGE_HOURS,
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

/**
 * Tier from an absolute temperature, using the seed thresholds.
 *
 * Boundaries are INCLUSIVE (>=), matching bump()'s SQL and the decay
 * migration: pass 3 of the decay function (0015 at the time of writing; see
 * tests/test_thermal_decay_migration.py::_decay_definers for the one that
 * actually runs) derives each cutoff as the MIN temperature
 * within a band, so the row that defines a boundary belongs to the band above
 * it. An exclusive `>` here put this helper one row out of step with bump() at
 * exactly TIER_HOT and TIER_WARM.
 */
export function computeTier(temperature: number): 'HOT' | 'WARM' | 'COLD' {
  if (temperature >= TIER_HOT) return 'HOT';
  if (temperature >= TIER_WARM) return 'WARM';
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

  // One statement: cutoff resolution + primary bump + cascade. Kept as one
  // query because recall fires bump() for several results concurrently and
  // separate round-trips exhaust the pool.
  //
  // The cutoffs CTE mirrors resolveCutoffs() in src/thermal-cutoffs.ts: a
  // missing, stale, seed (corpus_size = 0), degenerate or non-finite row
  // degrades to the TIER_HOT / TIER_WARM seeds rather than mis-tiering.
  // Degenerate is TWO conditions — `hot <= warm`, and `warm <= 0`, which
  // the first does not imply: at warm_cutoff = 0 the comparisons below are
  // `temperature >= 0` and every row in the corpus clears the WARM arm, so COLD
  // is unreachable from here.
  //
  // tests/integration/isolated/bump-cutoffs.test.ts covers each arm with its
  // own behavioural case. It does NOT import resolveCutoffs, so nothing
  // structurally compares the two implementations — keeping them in step is a
  // manual obligation, and adding an arm here means adding a case there. An
  // earlier version of this comment claimed the suite enforced the mirror
  // automatically; it never did, and the `Number.isFinite` arms had already
  // drifted out of the SQL by the time anyone checked.
  //
  // `NOT (c.hot_cutoff < 'Infinity'::real)` is the SQL mirror of the
  // Number.isFinite() pair, in one term rather than six. Postgres orders NaN
  // ABOVE every other real, so NaN and +Infinity both fail `< 'Infinity'` and
  // are caught here; -Infinity is already caught by `hot <= warm`, and any
  // non-finite WARM value is caught by `warm <= 0` or by `hot <= warm` for the
  // same ordering reason. Without it, `hot_cutoff = NaN` left `invalid` false
  // and nothing in the corpus could ever tier HOT through bump().
  //
  // The comparisons are >=, not >. Pass 3 of the decay migration derives
  // hot_cutoff as MIN(temperature) WHERE tier = 'HOT' — so the row that DEFINES
  // the cutoff is HOT by decay's own assignment. With a strict > that same row
  // is WARM the next time bump() touches it, and likewise at the WARM boundary.
  // The cutoffs exist precisely so the two paths agree; an off-by-one at the
  // boundary is the one way they can silently disagree.
  await db.execute(sql`
    WITH raw_cutoffs AS (
      -- The "this row cannot be trusted" predicate is stated ONCE, here, and
      -- consumed twice below. It used to be written out verbatim in both CASE
      -- arms; the two must always agree, because falling back on one and not
      -- the other produces a MIXED row — a measured hot paired with a seeded
      -- warm — which is exactly the shape pass 3 of the decay migration
      -- refuses to write, for the same reason.
      SELECT
        c.hot_cutoff  AS hot_cutoff,
        c.warm_cutoff AS warm_cutoff,
        (c.id IS NULL
         OR c.corpus_size <= 0
         OR c.warm_cutoff <= 0
         OR NOT (c.hot_cutoff < 'Infinity'::real)
         OR c.hot_cutoff <= c.warm_cutoff
         OR c.computed_at < NOW() - (INTERVAL '1 hour' * ${CUTOFF_MAX_AGE_HOURS})) AS invalid
      FROM (SELECT 1) AS one
      LEFT JOIN public.thermal_cutoffs c ON c.id = 1
    ),
    cutoffs AS (
      SELECT
        CASE WHEN rc.invalid THEN ${TIER_HOT}::real  ELSE rc.hot_cutoff  END AS hot,
        CASE WHEN rc.invalid THEN ${TIER_WARM}::real ELSE rc.warm_cutoff END AS warm
      FROM raw_cutoffs rc
    ),
    primary_bump AS (
      UPDATE public.entities e
      SET
        temperature = LEAST(1.0::real, e.temperature + ${BUMP_AMOUNT}::real),
        tier = CASE
          WHEN LEAST(1.0::real, e.temperature + ${BUMP_AMOUNT}::real) >= cutoffs.hot THEN 'HOT'
          WHEN LEAST(1.0::real, e.temperature + ${BUMP_AMOUNT}::real) >= cutoffs.warm THEN 'WARM'
          ELSE 'COLD'
        END,
        access_count = COALESCE(e.access_count, 0) + 1,
        access_bitmap = COALESCE(e.access_bitmap, 0) | ${dayBit},
        last_accessed_at = NOW()
      FROM cutoffs
      WHERE e.id = ${id}
      RETURNING e.id
    ),
    degree AS (
      -- Total degree of the bumped row. GREATEST(...,1) guards the zero-edge
      -- case; the cascade UPDATE would match no rows anyway, but a division by
      -- zero in the SET expression would abort the statement.
      -- A RAW count, deliberately not provenance-weighted like recall's
      -- centrality: it splits heat across the edges that exist, and an
      -- inferred edge carries heat as much as an asserted one.
      SELECT GREATEST(COUNT(*), 1)::real AS d
      FROM public.memory_relations r, primary_bump p
      WHERE r.from_id = p.id OR r.to_id = p.id
    )
    UPDATE public.entities e
    SET
      temperature = LEAST(1.0::real, e.temperature + ${BUMP_AMOUNT}::real * ${CASCADE_FACTOR}::real * r.weight / degree.d),
      tier = CASE
        WHEN LEAST(1.0::real, e.temperature + ${BUMP_AMOUNT}::real * ${CASCADE_FACTOR}::real * r.weight / degree.d) >= cutoffs.hot THEN 'HOT'
        WHEN LEAST(1.0::real, e.temperature + ${BUMP_AMOUNT}::real * ${CASCADE_FACTOR}::real * r.weight / degree.d) >= cutoffs.warm THEN 'WARM'
        ELSE 'COLD'
      END
    FROM public.memory_relations r, primary_bump p, cutoffs, degree
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
  // The decay contract lives in ONE place: the LAST drizzle migration that
  // defines public.memory_thermal_decay() — 0010 originally, superseded by
  // 0013, 0014 and now 0015_thermal_decay_floor_is_cold.sql. It is pinned
  // against src/config.ts by tests/test_thermal_decay_migration.py, which
  // DISCOVERS that migration rather than naming one: hardcoding a path is how
  // the guard spent a week validating 0013 while 0014 was what ran. The cron
  // SCHEDULE still lives only in 0010. The contract used to exist twice — here,
  // and hand-transcribed into a live cron.job row on Supabase that was in no
  // migration and no script.
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
        // Passed through UNCONVERTED, including NULL. buildMarkdown already
        // renders the `unknown` placeholder for a missing host, so coalescing
        // here would make a row that genuinely has no origin_host
        // indistinguishable from one whose host we dropped — which is the bug
        // this line fixes, one layer down.
        originHost: row.origin_host,
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
