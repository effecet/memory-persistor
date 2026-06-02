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
 * Must mirror the project-path encoder,
 * which replaces BOTH `/` and `.` with `-`. Omitting the dot step caused
 * memories written from `/Users/<user.name>/...` to land in
 * `-Users-<user.name>-...` while the backup hook watched the dot-normalized
 * dir, producing silent file-mirror drift.
 *
 * "/Users/foo.bar/baz" → "-Users-foo-bar-baz"
 */
export function encodeProjectPath(source: string): string {
  return source.replace(/\//g, '-').replace(/\./g, '-');
}

/**
 * Slugify a memory name for use as a filename.
 * "User prefers f-strings" → "user-prefers-f-strings"
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
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
 * Write or update a memory file and update the MEMORY.md index.
 */
export function syncToFile(entity: MemoryEntity): void {
  const filePath = getFilePath(entity);
  const dir = getMemoryDir(entity.source);

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, buildMarkdown(entity), 'utf-8');
  updateMemoryIndex(dir);
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
export function removeFile(entity: MemoryEntity): void {
  const dir = getMemoryDir(entity.source);
  const canonical = getFilePath(entity);

  const targets = new Set<string>(findFilesByPgId(dir, entity.id));
  if (existsSync(canonical)) {
    targets.add(canonical);
  }

  for (const target of targets) {
    try {
      unlinkSync(target);
    } catch {
      // Already gone or unwritable — fall through to index rebuild.
    }
  }

  if (existsSync(dir)) {
    updateMemoryIndex(dir);
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
export function syncMerge(source: MemoryEntity, target: MemoryEntity): void {
  removeFile(source);
  syncToFile(target);
}

/**
 * Rebuild the MEMORY.md index by scanning all .md files in the directory.
 * Empty or missing `description:` fields fall back to the filename so the
 * index never shows bare bullets.
 *
 * @internal — exported for tests; not part of the MCP surface.
 */
export function updateMemoryIndex(dir: string): void {
  const indexPath = join(dir, 'MEMORY.md');

  const files = readdirSync(dir)
    .filter(f => f.endsWith('.md') && f !== 'MEMORY.md')
    .sort();

  const lines = ['# Memory Index', ''];

  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    const descMatch = content.match(/^description:[ \t]*(.*)$/m);
    const raw = descMatch?.[1]?.trim() ?? '';
    const desc = raw ? truncateDescription(raw) : file;
    lines.push(`- [${file}](${file}) — ${desc}`);
  }

  lines.push('');
  writeFileSync(indexPath, lines.join('\n'), 'utf-8');
}
