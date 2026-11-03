// Embedding parity check — bge-small vector-parity across machines (see README.md).
// Embeds a fixed corpus with the pinned model at multiple dtypes, prints a
// stable SHA-256 of each rounded vector so two machines can be diffed.
//
// The whole point: confirm that @huggingface/transformers produces IDENTICAL
// vectors on every machine that writes memories. If the SHAs differ across
// machines, cosine over the shared DB is garbage -> pivot runtime before any
// schema work. dtype loop tells us WHICH dtype (if any) is parity-stable.
//
// Run:  node scripts/spike/embed-parity.mjs | tee scripts/spike/parity-<host>.txt
import { pipeline } from '@huggingface/transformers';
import { createHash } from 'node:crypto';
import { hostname, arch, platform } from 'node:os';

const MODEL = 'Xenova/bge-small-en-v1.5';
const DTYPES = ['q8', 'fp32'];               // q8 = intended; fp32 = deterministic fallback rung
const SAMPLES = [
  'refresh docs and badges before pushing',
  'avoid shipping broken documentation',
  'Supabase pooler hostname varies by region',
  'the DualSense controller will not bind over bluetooth',
];

console.log(`# host=${hostname()} arch=${arch()} platform=${platform()} node=${process.version}`);

for (const dtype of DTYPES) {
  let extractor;
  try {
    extractor = await pipeline('feature-extraction', MODEL, { dtype });
  } catch (e) {
    console.log(`dtype=${dtype} LOAD_FAILED: ${e.message}`);
    continue;
  }
  for (const text of SAMPLES) {
    const out = await extractor(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(out.data);
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    const rounded = vec.map((x) => x.toFixed(5)).join(',');
    const sha = createHash('sha256').update(rounded).digest('hex').slice(0, 16);
    const head = vec.slice(0, 4).map((x) => x.toFixed(4)).join(', ');
    console.log(`dtype=${dtype} dims=${vec.length} norm=${norm.toFixed(6)} sha=${sha} head=[${head}] :: ${text}`);
  }
}
