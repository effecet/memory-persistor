# Embedding parity check — bge-small across machines

**Purpose:** prove `@huggingface/transformers` + `Xenova/bge-small-en-v1.5` produces
**identical** vectors on every machine that WRITES memories. Vectors that differ
across machines make cosine similarity over a shared database meaningless.

Only machines with `MEMORY_EMBED_ENABLED=true` write vectors; the rest store NULL
and a primary backfills them, so only the writers need to agree.

## Run (on each machine that writes vectors)

```bash
npm install
node scripts/spike/embed-parity.mjs | tee scripts/spike/parity-<host>.txt
```

The first run downloads the ONNX weights from huggingface.co (q8 ~30 MB + fp32 ~130 MB).

## Gate criteria

Diff the captures from two machines:

```bash
diff scripts/spike/parity-<host-a>.txt scripts/spike/parity-<host-b>.txt
```

- **PASS** — for the chosen dtype, every per-sample `sha=` matches (norm≈1.0, dims=384).
  That dtype is the one pinned in `src/config.ts` (`EMBED_QUANTIZATION`).
- **FAIL for q8, PASS for fp32** → pin **fp32** (bigger and slower, but deterministic).
- **FAIL for both** → do not share vectors between these machines.

## Recorded result: **fp32**

Two arm64 machines, one on macOS and one on Linux (different Node and ONNX runtime builds):

| dtype | samples matching | outcome |
|---|---|---|
| **q8** | **2/4** | ❌ FAIL — two samples quantized differently |
| **fp32** | **4/4** | ✅ PASS |

Same CPU architecture; the only difference is the OS and the ONNX runtime build under it,
which is enough for **int8 quantization to round differently** on half the samples. fp32
has no quantization step, so it stays bit-identical. Hence `EMBED_QUANTIZATION = 'fp32'`.
Re-run this check before adding a writer on a new platform.
