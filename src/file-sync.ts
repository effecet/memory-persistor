/**
 * Dual-write sync: mirrors Postgres entities to Claude Code markdown memory files.
 *
 * Path convention:
 *   source "/Users/foo/bar" → ~/.claude/projects/-Users-foo-bar/memory/<type>_<slug>.md
 *
 * File format matches Claude Code's existing memory system:
 *   ---
 *   name: <name>
 *   description: <first DESCRIPTION_MAX chars, word-bounded>
 *   type: <type>
 *   temperature: <0.0-1.0>
 *   tier: <HOT|WARM|COLD>
 *   pg_id: <uuid>
 *   ---
 *   <observations>
 */
import { readFileSync, readdirSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_DIR } from './config.js';

interface MemoryEntity {
  id: string;
  name: string;
  type: string;
  observations: string;
  temperature: number;
  tier: string;
  source: string;
  accessCount?: number;
  importance?: number;
  originHost?: string;
}

export const DESCRIPTION_MAX = 40;

/**
 * Harness line cap for an auto-loaded MEMORY.md is 200; 170 leaves headroom.
 * Output is ['# Memory Index', '', ...entries, ''] joined by '\n', so
 * wc -l === entries + 2, or entries + 3 once a footer is appended.
 *
 * Any additional emitter of this index must share these values verbatim —
 * see the updateMemoryIndex docstring.
 */
export const INDEX_LINE_BUDGET = 170;
export const MAX_ENTRIES_NO_FOOTER = INDEX_LINE_BUDGET - 2;   // 168
export const MAX_ENTRIES_WITH_FOOTER = INDEX_LINE_BUDGET - 3; // 167

/** Retention order when the budget bites. Unknown tier → WARM (never drop blind). */
export const TIER_RANK: Record<string, number> = { HOT: 0, WARM: 1, COLD: 2 };
export const UNKNOWN_TIER_RANK = TIER_RANK.WARM;

/** Types never dropped ahead of others when the budget bites — standing rules and
 *  identity. A PRIORITY tier in the retention sort, not an exemption from the cap:
 *  if protected entries alone exceed the budget they are still cut among
 *  themselves, so the file cannot breach. */
export const PROTECTED_TYPES = new Set(['user', 'feedback']);

/** Overflow footer. '…' is U+2026, '—' is U+2014. Byte-identical across emitters. */
export function indexFooter(n: number): string {
  return `- …and ${n} more — use \`recall\``;
}

/**
 * Truncate a description to DESCRIPTION_MAX code points, preferring a word
 * boundary. Single source of truth for both frontmatter writes (buildMarkdown)
 * and index rebuilds (updateMemoryIndex) — belt-and-suspenders against drift
 * when files are written outside the MCP (imports, manual edits).
 *
 * Uses Array.from to split by Unicode code points so astral-plane emoji
 * (e.g. 🧉) are never cut mid-surrogate. Not grapheme-aware — ZWJ sequences
 * may still split, but the output is always valid UTF-16.
 *
 * @internal — exported for tests; not part of the MCP surface.
 */
export function truncateDescription(input: string | undefined | null, max: number = DESCRIPTION_MAX): string {
  const cleaned = (input ?? '').replace(/\n/g, ' ').trim();
  const codePoints = Array.from(cleaned);
  if (codePoints.length <= max) return cleaned;
  const slice = codePoints.slice(0, max);
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.join('');
}

/**
 * Encode a filesystem path to Claude Code's project directory name.
 * Must mirror the project-path encoder, which replaces BOTH `/` and `.`
 * with `-`. Omitting the dot step caused memories written from
 * `/Users/<user.name>/...` to land in `-Users-<user.name>-...` while other
 * tooling watched the dot-normalized dir, producing silent file-mirror drift.
 *
 * "/Users/foo.bar/baz" → "-Users-foo-bar-baz"
 */
export function encodeProjectPath(source: string): string {
  return source.replace(/\//g, '-').replace(/\./g, '-');
}

/**
 * Slugify a memory name for use as a filename.
 * "User prefers f-strings" → "user-prefers-f-strings"
 *
 * 120-char cap: APFS/ext4 allow 255 bytes; 120 leaves room for the
 * `<type>_` prefix and the `.md` suffix while lifting the ceiling that
 * previously forced very short memory names. Any other implementation of this
 * slug must match exactly, or the two will disagree on a filename.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/**
 * Get the memory directory for a given source path.
 */
function getMemoryDir(source: string): string {
  const encoded = encodeProjectPath(source);
  return join(CLAUDE_DIR, 'projects', encoded, 'memory');
}

/**
 * Get the markdown file path for a memory entity.
 */
function getFilePath(entity: MemoryEntity): string {
  const dir = getMemoryDir(entity.source);
  const slug = slugify(entity.name);
  return join(dir, `${entity.type}_${slug}.md`);
}

/**
 * Build frontmatter + body for a memory file.
 */
function buildMarkdown(entity: MemoryEntity): string {
  const description = truncateDescription(entity.observations);
  return [
    '---',
    `name: ${entity.name}`,
    `description: ${description}`,
    `type: ${entity.type}`,
    `temperature: ${entity.temperature}`,
    `tier: ${entity.tier}`,
    `importance: ${entity.importance ?? 0.5}`,
    `access_count: ${entity.accessCount ?? 0}`,
    `origin_host: ${entity.originHost ?? 'unknown'}`,
    `pg_id: ${entity.id}`,
    '---',
    '',
    entity.observations || '',
    '',
  ].join('\n');
}

/**
 * Delete a file, swallowing "already gone" / unwritable errors.
 *
 * Every caller rebuilds MEMORY.md immediately afterwards, so a failed unlink
 * is reconciled by the index rebuild rather than crashing the sync.
 */
function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Intentionally empty — see docstring.
  }
}

/**
 * Write or update a memory file and update the MEMORY.md index.
 *
 * Deletes any file in the dir carrying this entity's pg_id under a
 * NON-canonical name. A rename (via `update` changing the name) re-slugs the
 * filename; without this the old-slug file survives, leaving two files for one
 * entity and a duplicated MEMORY.md line. `removeFile` already reconciles this
 * way via findFilesByPgId — this closes the same gap on the write path.
 *
 * Order is load-bearing: write FIRST, then sweep. Sweeping first would leave
 * the entity with zero markdown files if writeFileSync then threw, which is
 * strictly worse than the duplicate the sweep exists to prevent. The sweep
 * skips `filePath`, so the freshly-written file is never a candidate.
 */
export async function syncToFile(
  entity: MemoryEntity,
  thermal?: ThermalMap | null,
): Promise<void> {
  const filePath = getFilePath(entity);
  const dir = getMemoryDir(entity.source);

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, buildMarkdown(entity), 'utf-8');

  for (const stale of findFilesByPgId(dir, entity.id)) {
    if (stale !== filePath) {
      unlinkQuietly(stale);
    }
  }

  await updateMemoryIndex(dir, thermal);
}

/**
 * Find all .md files in `dir` whose frontmatter `pg_id:` matches `pgId`.
 *
 * Slug renames (via `update` changing the memory name) leave orphan
 * markdown files on disk under the old slug. The pg_id in frontmatter
 * is the only stable cross-rename anchor, so we glob the dir and read
 * frontmatter to surface every file pointing at this entity.
 *
 * Frontmatter-only match: the regex is anchored to a line so a `pg_id`
 * mention in the body cannot trigger a false delete.
 */
function findFilesByPgId(dir: string, pgId: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const matches: string[] = [];
  const pattern = new RegExp(`^pg_id:[ \\t]*${pgId}\\s*$`, 'm');
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md') || file === 'MEMORY.md') {
      continue;
    }
    const fullPath = join(dir, file);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      if (pattern.test(content)) {
        matches.push(fullPath);
      }
    } catch {
      // Unreadable file — skip silently (dir scan should not crash on a
      // single bad file). Will be caught by `health` orphan check.
    }
  }
  return matches;
}

/**
 * Remove a memory file and update the MEMORY.md index.
 *
 * Deletes the canonical-slug path AND any orphan markdown files under
 * the same memory dir whose frontmatter `pg_id:` matches the entity's
 * id (i.e. files left over from past slug renames). Closes the gap
 * where `forget` only cleared the current-slug variant.
 */
export async function removeFile(entity: MemoryEntity): Promise<void> {
  const dir = getMemoryDir(entity.source);
  const canonical = getFilePath(entity);

  const targets = new Set<string>(findFilesByPgId(dir, entity.id));
  if (existsSync(canonical)) {
    targets.add(canonical);
  }

  for (const target of targets) {
    unlinkQuietly(target);
  }

  if (existsSync(dir)) {
    await updateMemoryIndex(dir);
  }
}

/**
 * Reconcile the markdown mirror after a Postgres merge.
 *
 * `merge` deletes the source entity's PG row but, before this, left the
 * source's slug-derived `.md` file and its MEMORY.md line orphaned whenever
 * source and target slugged to different filenames (issue #15). This deletes
 * the source's file(s) + index line, then (re)writes the surviving target.
 *
 * Ordering is load-bearing: removeFile(source) MUST run before
 * syncToFile(target). When source and target slug to the SAME filename,
 * removeFile deletes the shared file and syncToFile immediately recreates it
 * with merged content — the survivor is the last write, never deleted after.
 * The reversed order would delete the freshly-written survivor.
 *
 * Cross-project merges (source.source !== target.source) are reconciled
 * independently per dir: removeFile cleans the source's memory/ + MEMORY.md,
 * syncToFile writes the survivor under the target's memory/ + MEMORY.md.
 *
 * @param source entity as it existed BEFORE mergeMemories deleted its PG row
 *               (only id/name/type/source are read by removeFile)
 * @param target post-merge surviving entity
 */
export async function syncMerge(source: MemoryEntity, target: MemoryEntity): Promise<void> {
  await removeFile(source);
  await syncToFile(target);
}

/**
 * Read a frontmatter scalar, whether it sits at the top level or indented
 * under a parent key such as `metadata:`.
 *
 * Memories written by buildMarkdown() always use the flat shape, but files
 * produced by other tools may store `type` under `metadata:`. A
 * top-level-only match would render those as `unknown:` in the index.
 *
 * When a frontmatter block is present, matching is scoped to it, so an
 * indented `key:` inside the body (a YAML snippet in a fenced code block, say)
 * cannot win. A leading BOM or blank lines before the opening `---` are
 * tolerated: without that, the anchor fails and the whole read silently drops
 * to the 800-char fallback, where the scoping guarantee does not hold and a
 * top-level key in the BODY outranks a nested one in the frontmatter. Files
 * with NO frontmatter block at all still take that fallback — they are
 * malformed for this purpose anyway, and it only ever feeds display fields.
 *
 *
 * @internal — exported for tests; not part of the MCP surface.
 */
export function readFrontmatterField(content: string, key: string): string {
  const block = content.match(/^\uFEFF?\s*---\n([\s\S]*?)\n---/)?.[1] ?? content.slice(0, 800);
  const flat = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'));
  const nested = flat ? null : block.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(.*)$`, 'm'));
  const raw = (flat?.[1] ?? nested?.[1] ?? '').trim();
  return raw.replace(/^["']|["']$/g, '');
}

export type ThermalRow = { tier: string; temperature: number };
export type ThermalMap = Map<string, ThermalRow>;

/**
 * Batch-resolve live thermal state for the entities an index rebuild is about
 * to rank. ONE query per rebuild, never one per file.
 *
 * Returns `null` when there is no Postgres information to rank on — the caller
 * must then rank the WHOLE index on frontmatter. A partial fallback would rank
 * fresh values against stale ones, the exact defect this lookup removes.
 *
 * An empty id list also returns `null`: a directory where no file carries a
 * `pg_id` is the no-information case. Returning an empty map instead would
 * classify every legacy file as an orphan and re-cut the index on filename
 * alone. The orphan rule below targets an individual missing row, not a whole
 * directory. Every emitter of this index implements the same contract.
 *
 * The `./db.js` import is deliberately dynamic: db.ts builds a pg.Pool at
 * module scope, and a static import would open an idle pool in every consumer
 * of file-sync — including the parity test's `node -e` subprocess, which would
 * then never exit.
 */
export async function fetchThermalByPgId(pgIds: string[]): Promise<ThermalMap | null> {
  const ids = pgIds.filter(id => /^[0-9a-fA-F-]{36}$/.test(id));
  if (ids.length === 0) return null;
  try {
    // db.js MUST be imported before the DATABASE_URL check: importing it is what
    // runs dotenv.config(), so checking process.env first reads an unpopulated
    // env and falls back on every call.
    const { db } = await import('./db.js');
    const { sql } = await import('drizzle-orm');
    if (!process.env.DATABASE_URL) {
      process.stderr.write('[file-sync] no DATABASE_URL; ranking MEMORY.md on frontmatter\n');
      return null;
    }
    // One comma-joined string parameter expanded by Postgres, NOT `= ANY(${ids})`:
    // drizzle's sql template flattens a JS array into separate placeholders, so
    // that form emits `ANY(($1))` with a scalar and fails at execution. This also
    // keeps one SQL contract across every emitter.
    const result = await db.execute(
      sql`SELECT id, tier, temperature FROM public.entities
          WHERE id = ANY(string_to_array(${ids.join(',')}, ',')::uuid[])`,
    );
    const map: ThermalMap = new Map();
    for (const row of result.rows as Array<Record<string, unknown>>) {
      map.set(String(row.id), {
        tier: String(row.tier ?? ''),
        temperature: Number(row.temperature ?? 0),
      });
    }
    return map;
  } catch (err) {
    process.stderr.write(
      `[file-sync] thermal lookup failed (${(err as Error).message}); ` +
        'ranking MEMORY.md on frontmatter\n',
    );
    return null;
  }
}

/**
 * Rebuild the MEMORY.md index by scanning all .md files in the directory.
 * Empty or missing `description:` fields fall back to the filename so the
 * index never shows bare bullets.
 *
 * Line format is `- <type>: <name> — <description>`, NOT a markdown link and
 * NOT the filename. The name is what a human recognises and what `recall`
 * matches on; the filename is a slug nobody reads. Dropping the link cut the
 * primary index from 26.7 KB to 16.8 KB; switching filename → name is
 * roughly byte-neutral (-1.4% measured on 209 entries, 2026-08-08).
 *
 * If you add another emitter of this file, it MUST stay in sync with this one
 * — whichever runs last wins, so a partial change silently flaps the format.
 * This one fires on every remember/update/forget/merge.
 *
 * Budget rule (identical in every emitter): emit everything while entries
 * <= MAX_ENTRIES_NO_FOOTER. Over that, rank PROTECTED_TYPES entries first, then
 * by tier (HOT > WARM > COLD), then temperature descending, then filename;
 * keep MAX_ENTRIES_WITH_FOOTER and append indexFooter(dropped). Unknown tier
 * ranks as WARM — never drop what could not be classified. Protected types are
 * a priority tier, not an exemption — if they alone exceed the budget they are
 * still cut among themselves, so the file cannot breach it.
 *
 * Temperature and tier are read from POSTGRES, not from frontmatter: the
 * nightly pg_cron decay updates the database only (Postgres cannot reach any
 * machine's filesystem), so frontmatter goes stale between writes and ranking
 * on it made the cut effectively alphabetical. `thermal` is `undefined` to
 * fetch internally, an explicit map to use as-is, or explicit `null` to rank on
 * frontmatter without attempting a lookup.
 *
 * @internal — exported for tests; not part of the MCP surface.
 */
export async function updateMemoryIndex(
  dir: string,
  thermal?: ThermalMap | null,
): Promise<void> {
  const indexPath = join(dir, 'MEMORY.md');

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    .sort();

  // Parse every file once: display order is alphabetical, retention order is tiered.
  const entries = files.map(file => {
    const content = readFileSync(join(dir, file), 'utf-8');
    // description deliberately does NOT go through readFrontmatterField: that
    // helper strips surrounding quotes, and other emitters do not. Keep the
    // raw match so every emitter produces byte-identical lines.
    const descMatch = content.match(/^description:[ \t]*(.*)$/m);
    const raw = descMatch?.[1]?.trim() ?? '';
    const desc = raw ? truncateDescription(raw) : file;
    const name = readFrontmatterField(content, 'name') || file.replace(/\.md$/, '');
    const type = readFrontmatterField(content, 'type') || 'unknown';
    const tier = (readFrontmatterField(content, 'tier') || '').toUpperCase();
    const temp = Number.parseFloat(readFrontmatterField(content, 'temperature') || '');
    return {
      file,
      pgId: readFrontmatterField(content, 'pg_id') || '',
      line: `- ${type}: ${name} — ${desc}`,
      rank: tier in TIER_RANK ? TIER_RANK[tier] : UNKNOWN_TIER_RANK,
      temp: Number.isFinite(temp) ? temp : 0,
      prot: PROTECTED_TYPES.has(type) ? 0 : 1,
    };
  });

  // `undefined` = resolve our own; explicit `null` = rank on frontmatter with
  // no lookup (tests and the golden-fixture parity harness).
  const resolved =
    thermal === undefined
      ? await fetchThermalByPgId(entries.map(e => e.pgId).filter(Boolean))
      : thermal;

  if (resolved) {
    let orphans = 0;
    for (const e of entries) {
      const row = e.pgId ? resolved.get(e.pgId) : undefined;
      if (row) {
        const t = row.tier.toUpperCase();
        e.rank = t in TIER_RANK ? TIER_RANK[t] : UNKNOWN_TIER_RANK;
        e.temp = Number.isFinite(row.temperature) ? row.temperature : 0;
      } else {
        // Reachable but no row: an orphan. Orphans must not outrank live
        // memories, and per-entry frontmatter fallback is forbidden here — it
        // would rank a stale value against fresh ones.
        e.rank = UNKNOWN_TIER_RANK;
        e.temp = 0;
        orphans++;
      }
    }
    if (orphans > 0) {
      process.stderr.write(
        `[file-sync] ${orphans} file(s) in ${dir} have no matching entity; ranked at temperature 0\n`,
      );
    }
  }

  let kept = entries;
  let dropped = 0;
  if (entries.length > MAX_ENTRIES_NO_FOOTER) {
    const survivors = new Set(
      [...entries]
        // Codepoint comparison, NOT localeCompare: display order above comes
        // from readdirSync().sort(), which is codepoint order. localeCompare
        // disagrees with that (e.g. 'Z-tie.md' sorts before 'a-tie.md' by
        // codepoint — uppercase precedes lowercase in ASCII — but AFTER it
        // under locale-aware collation), so a localeCompare tie-break here
        // could pick a different survivor than this same file's own display
        // sort, and disagrees with a plain string comparison too.
        .sort((a, b) => a.prot - b.prot || a.rank - b.rank || b.temp - a.temp ||
                        (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
        .slice(0, MAX_ENTRIES_WITH_FOOTER)
        .map(e => e.file),
    );
    kept = entries.filter(e => survivors.has(e.file));
    dropped = entries.length - kept.length;
  }

  const lines = ['# Memory Index', '', ...kept.map(e => e.line)];
  if (dropped > 0) lines.push(indexFooter(dropped));
  lines.push('');
  writeFileSync(indexPath, lines.join('\n'), 'utf-8');
}
