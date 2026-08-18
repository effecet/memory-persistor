/**
 * CI helper — download + cache the bge-small embedding model.
 *
 * transformers.js caches under node_modules/@huggingface/transformers/.cache,
 * which `npm ci` wipes on every run, so a fresh runner has no model. The
 * offline unit tests (embed.test.ts / embed-write.test.ts force
 * env.allowRemoteModels=false) would throw, and the timed integration tests
 * (recall-semantic, embed-write, backfill-embeddings) could exceed their 30s
 * budget downloading ~127MB mid-test. Running this once after `npm ci`, in an
 * untimed step, pre-populates the shared cache.
 *
 * embed() throws on model-load failure (and on a wrong dim count), so this
 * exits non-zero on any problem — a real CI signal, not a silent skip.
 * Run: `node --import tsx scripts/precache-embed-model.ts`
 */
import { embed } from '../src/embed.js';

await embed('ci precache warmup');
console.log('[precache] bge-small model cached ✓');
