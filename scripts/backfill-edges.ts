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
import { recall, shouldAutoRelate } from '../src/retrieve.js';
import { memoryRelations } from '../src/schema.js';
import { AUTO_RELATE_LIMIT } from '../src/config.js';

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
      // recall() returns a RecallResponse wrapper (since the recall-cap change), not an array.
      // `for...of` over the wrapper threw TypeError at runtime and TS2488 under
      // tsc -- invisible because tsconfig's include was ["src"], so scripts/ was
      // never typechecked. See the typecheck-scripts npm script.
      const { results: matches } = await recall({ query, limit: AUTO_RELATE_LIMIT });

      for (const match of matches) {
        if (match.id === entity.id) continue;
        if (!shouldAutoRelate(match)) continue;
        if (existingEdges.has(`${entity.id}:${match.id}`)) {
          skipped++;
          continue;
        }

        if (DRY_RUN) {
          console.log(`  [dry-run] ${entity.name} -> ${match.name} (score: ${match.score.toFixed(3)})`);
        } else {
          const inserted = await db.insert(memoryRelations).values({
            fromId: entity.id,
            toId: match.id,
            relationType: 'related_to',
            // A similarity guess, same as remember's auto-relate.
            provenance: 'inferred',
          }).onConflictDoNothing().returning({ id: memoryRelations.id });
          // Track both directions to avoid duplicates within this run
          existingEdges.add(`${entity.id}:${match.id}`);
          existingEdges.add(`${match.id}:${entity.id}`);
          if (inserted.length === 0) {
            skipped++;
            continue;
          }
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
