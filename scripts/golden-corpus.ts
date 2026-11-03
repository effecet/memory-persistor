/**
 * Fixture contract for the CI ranking-regression guard.
 *
 * WHAT THIS GUARDS, AND WHAT IT DOES NOT
 *
 * A regression guard, never a quality bar. It answers "did this change move
 * ranking against a fixed reference", and says nothing about whether retrieval
 * is good. It is also NOT
 * outage detection — that belongs to a separate liveness check.
 *
 * WHY A FROZEN SNAPSHOT RATHER THAN A SEEDED HANDFUL
 *
 * Measured on a production corpus 2026-09-08, the golden set's entire
 * discriminating power comes from the power-law shape (names illustrative):
 *
 *   distractor  API token scopes per account      HOT   temp 1.0000  degree 291
 *   target      API merge 405 means merged        WARM  temp 0.3784  degree 1
 *   target      Close an issue from a commit      COLD  temp 0.0303  degree 3
 *   target      Tracker closes one per line       COLD  temp 0.0293  degree 2
 *
 * A fresh CI database has no hub, no thermal spread and no degree
 * distribution, so every golden query passes trivially and proves nothing.
 * The fixture therefore holds real rows, real edges and real embeddings,
 * which is why this repository does not ship one: snapshot your own with
 * scripts/snapshot-golden-corpus.ts (README § Ranking guard).
 *
 * DETERMINISM — the two things that would make this rot silently
 *
 * 1. RECENCY IS COMPUTED FROM NOW(). `RECENCY_EXPR` in src/retrieve.ts is
 *    `EXTRACT(EPOCH FROM (NOW() - COALESCE(last_accessed_at, created_at)))`.
 *    Storing absolute timestamps means the recency signal changes every day
 *    the fixture ages, so a baseline recorded today fails next month with no
 *    code change. Timestamps are therefore stored as OFFSETS IN DAYS and
 *    rebuilt relative to seed time.
 * 2. QUERY EMBEDDINGS ARE FROZEN. Row embeddings ship in the fixture, but the
 *    query vector would otherwise be computed at run time — on a laptop when
 *    the baseline is recorded, on the CI runner. bge-small
 *    fp32 is pinned, but cross-platform float agreement is not guaranteed and
 *    a near-tie only needs one ulp to flip. Freezing them removes the class.
 */

export interface CorpusEntity {
  id: string;
  name: string;
  entityType: string;
  observations: string;
  tags: string[];
  tier: string;
  temperature: number;
  importance: number;
  accessCount: number;
  /** Days before seed time. null means the column was NULL upstream. */
  lastAccessedDaysAgo: number | null;
  /** Days before seed time. Never null — created_at is NOT NULL. */
  createdDaysAgo: number;
  /** 384-d bge-small vector, or null for an unembedded row. */
  embedding: number[] | null;
}

export interface CorpusRelation {
  fromId: string;
  toId: string;
  relationType: string;
  /**
   * Absent in snapshots taken before 2026-10-15, which the guard seeds as
   * 'inferred' (the DB default). Recorded since then because recall reads it
   * twice: centrality weights it and only an asserted `supersedes` edge
   * sinks a memory. Without it the guard cannot see either.
   *
   * Mirrors EdgeProvenance (src/config.ts), written out because this file must
   * stay import-free (tests/ranking-guard-readonly.test.ts).
   */
  provenance?: 'asserted' | 'inferred';
}

export interface GoldenCorpus {
  generatedAt: string;
  sourceCommit: string | null;
  /** Live-corpus figures at snapshot time, so drift is visible later. */
  liveShape: {
    entities: number;
    edges: number;
    maxDegree: number;
  };
  entities: CorpusEntity[];
  relations: CorpusRelation[];
  /** query text -> frozen 384-d embedding. See determinism note 2 above. */
  queryEmbeddings: Record<string, number[]>;
}

/** Rank of each interesting name for one query. null = absent from the top-N. */
export interface BaselineQuery {
  query: string;
  ranks: Record<string, number | null>;
}

export interface Baseline {
  recordedAt: string;
  sourceCommit: string | null;
  alpha: number;
  limit: number;
  /** Guards against a baseline being compared to a different fixture. */
  corpusDigest: string;
  queries: BaselineQuery[];
}

/**
 * Absolute timestamp for a stored day-offset, relative to `seedNow`.
 *
 * Kept as a named function rather than inlined so the tests can pin the
 * property that matters: two seeds at different wall-clock times must produce
 * the same AGE, which is what RECENCY_EXPR actually reads.
 */
export function timestampForOffset(daysAgo: number, seedNow: Date): Date {
  return new Date(seedNow.getTime() - daysAgo * 86_400_000);
}

/**
 * FNV-1a, 64-bit, as hex. A cryptographic hash is not needed — this detects
 * accidental mismatch between recorded and current material, not tampering.
 * Exported so callers hashing OTHER ranking-relevant material (e.g. the
 * seeding procedure itself, see ranking-guard.ts) use the same primitive
 * rather than a second hand-rolled hash drifting out of sync with this one.
 */
export function fnv1aHex(material: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < material.length; i++) {
    hash = (hash ^ BigInt(material.charCodeAt(i) & 0xff)) & mask;
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Stable digest of the fixture's ranking-relevant content.
 *
 * Deliberately EXCLUDES generatedAt and sourceCommit: re-snapshotting an
 * unchanged corpus must not invalidate a baseline. Includes embeddings,
 * because a changed vector changes ranking.
 *
 * This covers the FIXTURE only. It says nothing about the procedure that
 * turns the fixture into database rows — see ranking-guard.ts's combined
 * digest, which also hashes seedCorpus()'s own source for that reason.
 */
export function corpusDigest(corpus: GoldenCorpus): string {
  const material = JSON.stringify({
    entities: [...corpus.entities]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((e) => [
        e.id,
        e.name,
        e.entityType,
        e.observations,
        [...e.tags].sort(),
        e.tier,
        e.temperature,
        e.importance,
        e.accessCount,
        e.lastAccessedDaysAgo,
        e.createdDaysAgo,
        e.embedding,
      ]),
    relations: [...corpus.relations]
      .map((r) => [r.fromId, r.toId, r.relationType] as const)
      .sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1)),
    queryEmbeddings: Object.keys(corpus.queryEmbeddings)
      .sort()
      .map((k) => [k, corpus.queryEmbeddings[k]]),
  });
  return fnv1aHex(material);
}

export interface RankChange {
  query: string;
  name: string;
  role: 'expect_top' | 'expect_not_top';
  baseline: number | null;
  current: number | null;
}

export interface ComparisonResult {
  regressions: RankChange[];
  improvements: RankChange[];
  unchanged: number;
  /** Names present in the baseline but absent from the current golden set. */
  missingFromCurrent: string[];
}

/**
 * Compare current ranks to the baseline.
 *
 * DIRECTION IS ROLE-DEPENDENT, and getting it backwards would produce a guard
 * that passes on the exact failure the hub-ranking bug documented:
 *   - expect_top    lower rank is better. Rising number = regression.
 *   - expect_not_top a distractor climbing = regression. Falling = improvement.
 *
 * ABSENCE IS RANKED WORSE THAN ANY PRESENT RANK. A target that drops out of
 * the top-N entirely is the worst case, not an unknown — treating null as
 * "no data" would let a total retrieval failure pass silently, which is the
 * failure mode this whole issue exists to catch.
 *
 * Improvements never fail the build. A guard that blocks a genuine ranking win
 * trains you to bypass it.
 */
export function compareToBaseline(
  baseline: BaselineQuery[],
  current: BaselineQuery[],
  roles: Record<string, Record<string, 'expect_top' | 'expect_not_top'>>,
): ComparisonResult {
  const out: ComparisonResult = {
    regressions: [],
    improvements: [],
    unchanged: 0,
    missingFromCurrent: [],
  };
  const currentByQuery = new Map(current.map((q) => [q.query, q]));

  // Absent = worse than any real rank. Using Infinity keeps the comparison a
  // plain numeric one in both directions.
  const asNumber = (r: number | null): number => (r === null ? Number.POSITIVE_INFINITY : r);

  for (const base of baseline) {
    const cur = currentByQuery.get(base.query);
    if (!cur) {
      out.missingFromCurrent.push(base.query);
      continue;
    }
    for (const [name, baseRank] of Object.entries(base.ranks)) {
      const role = roles[base.query]?.[name];
      if (!role) {
        // The golden set no longer mentions this name. Report rather than
        // silently drop it: a renamed target is how a guard starts measuring
        // nothing (see the entity rename, which renamed nine entities).
        out.missingFromCurrent.push(`${base.query} :: ${name}`);
        continue;
      }
      const curRank = name in cur.ranks ? cur.ranks[name] : null;
      const b = asNumber(baseRank);
      const c = asNumber(curRank);
      if (b === c) {
        out.unchanged++;
        continue;
      }
      const change: RankChange = { query: base.query, name, role, baseline: baseRank, current: curRank };
      const worse = role === 'expect_top' ? c > b : c < b;
      if (worse) out.regressions.push(change);
      else out.improvements.push(change);
    }
  }
  return out;
}

/**
 * Extracts seedCorpus()'s own TypeScript source text from this file, by name,
 * via balanced-brace scanning from its opening `{` to the matching `}`.
 *
 * Lives HERE, in the import-free module, rather than beside seedCorpus() in
 * ranking-guard.ts. Two reasons, and the second is not obvious: that file
 * imports ../src/db.js, which builds a pg Pool and loads dotenv at module
 * scope, so testing a string scanner from there dragged a database client into
 * the unit suite. And SEED_PROCEDURE_MARKER's own source position was
 * load-bearing while it lived in the scanned file — the marker matched the
 * function only because the constant was declared BELOW it, so hoisting the
 * constant would have silently made the digest hash the wrong function body.
 * Keeping the constant out of the file it scans removes that trap entirely.
 *
 * Ruling R12: corpusDigest() only ever hashed the FIXTURE, so a change
 * to the seeding PROCEDURE — like the temperature_rank UPDATE added just
 * above — silently redefines what a recorded baseline means, with no mismatch
 * ever firing. This closes that gap by folding the procedure into the digest
 * ranking-guard.ts actually compares against.
 *
 * Deliberately scoped to seedCorpus() alone rather than the whole file:
 * hashing the whole file would invalidate the baseline on any edit to
 * main()/renderTable()/comments elsewhere in this file, which is unrelated to
 * what gets written to the database — that would train operators to treat a
 * mismatch as routine and `--update-baseline` past it without reading the
 * diff, which is the opposite of what a loud mismatch is for.
 *
 * Deliberately reads raw source text rather than `seedCorpus.toString()`:
 * tsx transpiles TS to JS at import time, so `.toString()` returns
 * transpiler OUTPUT, not the source as written — brittle across tsx/Node
 * versions in a way that would produce spurious mismatches unrelated to any
 * actual change to the procedure. Raw source text has neither failure mode.
 */
export const SEED_PROCEDURE_MARKER = 'export async function seedCorpus(';

/**
 * The balanced-brace scan, split out so it can be exercised against synthetic
 * source. Both throws are load-bearing: the failure mode this whole
 * mechanism has to avoid is returning *something* — a stable digest over no
 * content looks exactly like a healthy one.
 *
 * ⚠️ Counts every brace, including those inside strings, comments and template
 * substitutions. `${...}` is self-balancing so today's body scans correctly,
 * but an unmatched brace inside a string literal in seedCorpus() would
 * terminate the scan early and silently shrink what is hashed. If that becomes
 * reachable, this needs a real tokenizer, not a wider regex.
 */
export function extractSeedCorpusBody(text: string): string {
  const start = text.indexOf(SEED_PROCEDURE_MARKER);
  if (start === -1) {
    throw new Error('extractSeedCorpusBody: could not locate the seedCorpus() marker in the given source');
  }
  const braceStart = text.indexOf('{', start);
  if (braceStart === -1) {
    // Distinct from the unbalanced-braces message below ON PURPOSE. With both
    // spelled the same, deleting this guard still produced that message from
    // the loop's own failure, so the test covering it passed either way —
    // verified vacuous by mutation, 2026-09-18.
    throw new Error('extractSeedCorpusBody: no opening brace after the seedCorpus() marker');
  }
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error('extractSeedCorpusBody: unbalanced braces scanning seedCorpus() body');
  }
  return text.slice(start, end);
}

/**
 * @param sourceText ranking-guard.ts's source, supplied by the caller rather
 * than read here — this module is deliberately import-free, and a required
 * parameter keeps the self-hashing visible at the single call site that does
 * it. It is also what lets a test drive the digest with synthetic source: a
 * test cannot edit ranking-guard.ts to prove that editing it matters.
 */
export function seedProcedureDigest(sourceText: string): string {
  return fnv1aHex(extractSeedCorpusBody(sourceText));
}

/**
 * Hard stop when the recorded baseline describes a different corpus or a
 * different seeding procedure. Extracted so the throw is directly testable and
 * so `main()` can run it BEFORE touching the database.
 */
export function assertDigestMatches(baselineDigest: string, currentDigest: string): void {
  if (baselineDigest === currentDigest) return;
  throw new Error(
    `fixture/baseline mismatch: baseline was recorded against digest ` +
      `${baselineDigest} (fixture:seedProcedure), current is ${currentDigest}. Either ` +
      `the fixture or seedCorpus() itself changed, so the baseline's ranks describe a ` +
      `different corpus or a different seeding procedure. Re-record it with ` +
      `--update-baseline and review the diff.`,
  );
}
