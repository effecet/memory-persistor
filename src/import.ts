/**
 * One-shot import: seed Postgres from existing Claude Code markdown memories.
 *
 * Scans ~/.claude/projects/{project}/memory/{file}.md (skips MEMORY.md index files),
 * parses frontmatter, and inserts into Postgres with WARM defaults.
 *
 * Usage: npx tsx src/import.ts
 */
import 'dotenv/config';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { db, closeDb } from './db.js';
import { entities } from './schema.js';
import { eq, and } from 'drizzle-orm';
import { CLAUDE_DIR } from './config.js';
import { isFilenameStyleName, collectProjectSources, listMemoryFiles } from './file-sync.js';
import { prepareImportRow } from './claim-contract.js';

const STOP_TAGS = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'not', 'has', 'are', 'was']);

interface ParsedMemory {
  name: string;
  type: string;
  description: string;
  body: string;
  source: string;
  filePath: string;
}

/**
 * Parse a markdown memory file with frontmatter.
 */
function parseMemoryFile(filePath: string, source: string): ParsedMemory | null {
  const content = readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  const nameMatch = frontmatter.match(/^name:\s*(.+)$/m);
  const typeMatch = frontmatter.match(/^type:\s*(.+)$/m);
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);

  if (!nameMatch || !typeMatch) return null;

  return {
    name: nameMatch[1].trim(),
    type: typeMatch[1].trim(),
    description: descMatch ? descMatch[1].trim() : '',
    body,
    source,
    filePath,
  };
}

async function main() {
  const projectsDir = join(CLAUDE_DIR, 'projects');
  if (!existsSync(projectsDir)) {
    console.log('No projects directory found at', projectsDir);
    return;
  }

  // Sources are resolved against the filesystem, never decoded: the encoding
  // is lossy and the old string decode seeded mangled sources. A dir
  // that does not resolve on THIS machine (another host's path, a deleted or
  // moved checkout) is skipped and reported, never imported under a guess.
  const { resolved, skipped: skippedDirs } = collectProjectSources(projectsDir);

  let imported = 0;
  let skipped = 0;

  for (const { dir, source } of resolved) {
    const memoryDir = join(projectsDir, dir, 'memory');
    const files = listMemoryFiles(memoryDir);

    for (const file of files) {
      const filePath = join(memoryDir, file);
      const parsed = parseMemoryFile(filePath, source);

      if (!parsed) {
        console.log(`  skip: ${file} (no frontmatter)`);
        skipped++;
        continue;
      }

      // Map existing types to our schema types (preserve feedback + reference)
      const validTypes = ['user', 'project', 'decision', 'fact', 'pattern', 'feedback', 'reference'];
      const type = validTypes.includes(parsed.type) ? parsed.type : 'fact';

      // Extract tags from filename, filtering type prefix and stopwords
      const fileBaseName = basename(file, '.md');
      const tags = fileBaseName
        .split(/[_-]/)
        .filter(t => t.length > 2 && t !== type && !STOP_TAGS.has(t));

      // Dedup: skip if entity with same name+source already exists
      const existing = await db
        .select({ id: entities.id })
        .from(entities)
        .where(and(eq(entities.name, parsed.name), eq(entities.source, parsed.source)))
        .limit(1);

      if (existing.length > 0) {
        console.log(`  skip: ${parsed.name} (already exists)`);
        skipped++;
        continue;
      }

      // Third write path to entities.name, and the one that most likely created
      // the nine filename-stem names in the first place: it takes `name:` verbatim
      // from frontmatter that was itself filename-derived. Guarding only
      // remember/update would leave `make seed` free to reintroduce them — which is
      // structurally the defect that retired memory_name_guard.py on 2026-08-08
      // (it fired on remember but never on update, so the corpus drifted in through
      // the unguarded path). Skips rather than aborts, so one bad file cannot
      // stop a whole import.
      if (isFilenameStyleName(parsed.name)) {
        console.error(
          `  skip: ${parsed.name} (filename-stem name, not a title — see an earlier issue)`,
        );
        skipped++;
        continue;
      }

      // Same claim contract as remember/update, for the same reason as the
      // name guard above: a rule on some write paths is not a rule. The decision
      // is prepareImportRow (tested); this module runs main() on load.
      const row = prepareImportRow(parsed.body, parsed.description, tags);
      if ('skip' in row) {
        console.error(`  skip: ${parsed.name} (${row.skip})`);
        skipped++;
        continue;
      }

      try {
        await db.insert(entities).values({
          name: parsed.name,
          type,
          observations: row.observations,
          tags: row.tags,
          source: parsed.source,
          importance: 0.5,
          temperature: 0.5,
          tier: 'WARM',
          accessCount: 0,
        });
        imported++;
        console.log(`  imported: ${parsed.name} [${type}] from ${dir}`);
      } catch (err) {
        console.error(`  error importing ${file}:`, err);
        skipped++;
      }
    }
  }

  console.log(`\nDone: ${imported} imported, ${skipped} skipped`);
  if (skippedDirs.length > 0) {
    const total = skippedDirs.reduce((n, s) => n + s.files, 0);
    console.log(`Not imported: ${skippedDirs.length} project dir(s), ${total} memory file(s) — no unique local path:`);
    for (const s of skippedDirs) console.log(`  ${s.reason.padEnd(10)} ${s.dir} (${s.files} files)`);
  }
  await closeDb();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
