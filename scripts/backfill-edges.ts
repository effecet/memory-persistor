/**
 * One-time backfill: create auto-relate edges for all existing memories.
 *
 * For each entity, runs recall with its name + observations (same logic as
 * the auto-relate block in remember), inserts `related_to` edges for top-3
 * matches above threshold 0.3, skipping self-links and existing edges.
 *
 * Usage: npx tsx scripts/backfill-edges.ts [--dry-run]
 * Delete this file after running.
 */
import { db, closeDb } from '../src/db.js';
import { sql } from 'drizzle-orm';
import { recall } from '../src/retrieve.js';
import { memoryRelations } from '../src/schema.js';
import { AUTO_RELATE_THRESHOLD, AUTO_RELATE_LIMIT } from '../src/config.js';

const DRY_RUN = process.argv.includes('--dry-run');

interface Entity {
  id: string;
  name: string;
  observations: string;
}

async function main(): Promise<void> {
  // Fetch all entities
  const result = await db.execute(sql`
    SELECT id, name, COALESCE(observations, '') AS observations
    FROM public.entities
    ORDER BY created_at
  `);
  const entities = result.rows as unknown as Entity[];
  console.log(`Found ${entities.length} entities to process`);

  // Fetch existing edges into a Set for O(1) dedup
  const existingEdges = new Set<string>();
  const edgeResult = await db.execute(sql`
    SELECT from_id, to_id FROM public.memory_relations
  `);
  for (const row of edgeResult.rows as unknown as { from_id: string; to_id: string }[]) {
    existingEdges.add(`${row.from_id}:${row.to_id}`);
    existingEdges.add(`${row.to_id}:${row.from_id}`); // bidirectional check
  }
  console.log(`Existing edges: ${edgeResult.rows.length}`);

  let created = 0;
  let skipped = 0;

  for (const entity of entities) {
    const query = `${entity.name} ${entity.observations.slice(0, 200)}`;

    try {
      const matches = await recall({ query, limit: AUTO_RELATE_LIMIT });

      for (const match of matches) {
        if (match.id === entity.id) continue;
        if (match.score < AUTO_RELATE_THRESHOLD) continue;
        if (existingEdges.has(`${entity.id}:${match.id}`)) {
          skipped++;
          continue;
        }

        if (DRY_RUN) {
          console.log(`  [dry-run] ${entity.name} -> ${match.name} (score: ${match.score.toFixed(3)})`);
        } else {
          await db.insert(memoryRelations).values({
            fromId: entity.id,
            toId: match.id,
            relationType: 'related_to',
          });
          // Track both directions to avoid duplicates within this run
          existingEdges.add(`${entity.id}:${match.id}`);
          existingEdges.add(`${match.id}:${entity.id}`);
        }
        created++;
      }
    } catch (err) {
      console.warn(`  [warn] Failed for "${entity.name}": ${err}`);
    }
  }

  console.log(`\nDone${DRY_RUN ? ' (dry run)' : ''}: ${created} edges created, ${skipped} duplicates skipped`);
  await closeDb();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
