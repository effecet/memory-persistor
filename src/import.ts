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
 * Decode a Claude Code project directory name back to a filesystem path.
 * "-Users-foo-bar" → "/Users/foo/bar"
 *
 * Note: this inverse is best-effort only — encoding is many-to-one by design.
 * `encodeProjectPath` in file-sync.ts replaces BOTH `/` and `.` with `-`, so
 * both `/Users/foo.bar` and `/Users/foo-bar` encode to `-Users-foo-bar` and
 * decoding can't tell them apart. The returned `source` is used as a stable
 * key for dedup during seed; downstream writes re-encode it consistently.
 */
function decodeProjectPath(encoded: string): string {
  return '/' + encoded.replace(/^-/, '').replace(/-/g, '/');
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

  const projectDirs = readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory());

  let imported = 0;
  let skipped = 0;

  for (const dir of projectDirs) {
    const memoryDir = join(projectsDir, dir.name, 'memory');
    if (!existsSync(memoryDir)) continue;

    const source = decodeProjectPath(dir.name);
    const files = readdirSync(memoryDir)
      .filter(f => f.endsWith('.md') && f !== 'MEMORY.md');

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

      try {
        await db.insert(entities).values({
          name: parsed.name,
          type,
          observations: parsed.body || parsed.description,
          tags,
          source: parsed.source,
          importance: 0.5,
          temperature: 0.5,
          tier: 'WARM',
          accessCount: 0,
        });
        imported++;
        console.log(`  imported: ${parsed.name} [${type}] from ${dir.name}`);
      } catch (err) {
        console.error(`  error importing ${file}:`, err);
        skipped++;
      }
    }
  }

  console.log(`\nDone: ${imported} imported, ${skipped} skipped`);
  await closeDb();
}

main().catch((err) => {
  console.error('Import failed:', err);
  process.exit(1);
});
