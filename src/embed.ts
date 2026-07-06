/**
 * Local semantic embeddings via bge-small (ONNX, in-process).
 *
 * Vectors are ADDITIVE — stored in entities.embedding vector(384) beside the
 * raw observations text, and used as a 9th retrieval signal (retrieve.ts) +
 * cosine dedup (intelligence.ts). No text ever leaves the machine.
 *
 * Model + quantization are PINNED in config.ts (EMBED_MODEL / EMBED_QUANTIZATION)
 * — see there for why dtype is fp32 and the full re-embed hazard on any change.
 *
 * The `@huggingface/transformers` import is DYNAMIC (inside getExtractor) on
 * purpose: importing this module must be free of side effects. Write-disabled
 * machines never WRITE a vector (embedForWrite stays gated on
 * EMBED_ON_WRITE_ENABLED), but they DO load the runtime for query-time
 * embedding (embedForQuery, deliberately ungated) when a caller explicitly
 * asks to search. remember's internal auto-relate lookup opts out via
 * `skipSemantic` specifically so a plain write never forces this load — see
 * RecallOptions.skipSemantic.
 */
import { EMBED_MODEL, EMBED_QUANTIZATION, EMBED_DIMS, EMBED_ON_WRITE_ENABLED } from './config.js';

// Narrow view of the feature-extraction pipeline — the only surface embed() uses.
type Extractor = (
  input: string,
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

// Cached singleton pipeline promise (first call pays ~1-2s load; then ~10-30ms).
let extractorPromise: Promise<Extractor> | null = null;

function getExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      const p = await pipeline('feature-extraction', EMBED_MODEL, { dtype: EMBED_QUANTIZATION });
      return p as unknown as Extractor;
    })().catch((e) => {
      // Never cache a REJECTED load: a transient first-load failure (network blip
      // fetching the model, momentary OOM) would otherwise be cached forever and
      // permanently disable embedding for the whole process — every later embed()
      // would re-throw the same error and all writes would silently go NULL until
      // a restart. Reset so the next call retries the load.
      extractorPromise = null;
      throw e;
    });
  }
  return extractorPromise;
}

/**
 * Embed text into an EMBED_DIMS-length, mean-pooled, L2-normalized vector.
 * Throws on model-load failure — callers on the write path guard it (a memory
 * must never be lost to an embed hiccup; store NULL and let the canary catch it).
 */
export async function embed(text: string): Promise<number[]> {
  const extractor = await getExtractor();
  // Cap input length — bge-small truncates at 512 tokens anyway; guards pathological inputs.
  const out = await extractor((text ?? '').slice(0, 8000), { pooling: 'mean', normalize: true });
  const vec = Array.from(out.data);
  if (vec.length !== EMBED_DIMS) {
    throw new Error(`embed: expected ${EMBED_DIMS} dims, got ${vec.length}`);
  }
  return vec;
}

/**
 * Shared non-fatal embed wrapper: try embed(text), log + degrade to null on
 * failure. `context` labels the caller in the log line and, where relevant,
 * the fallback behavior (e.g. "storing NULL", "lexical-only fallback").
 */
async function tryEmbed(text: string, context: string): Promise<number[] | null> {
  try {
    return await embed(text);
  } catch (e) {
    console.error(`[embed] ${context}:`, e);
    return null;
  }
}

/**
 * Warm the singleton at boot so the first recall isn't slow. Unconditional —
 * every machine calls embedForQuery() via recall() regardless of
 * EMBED_ON_WRITE_ENABLED (query-time embedding is deliberately ungated), so
 * every machine needs the model preloaded, not just write-enabled ones.
 * Non-fatal.
 */
export async function warmEmbed(): Promise<void> {
  await tryEmbed('warmup', 'warm-load failed (non-fatal)');
}

/** Format a JS number[] as a pgvector literal: '[0.1,0.2,...]'. */
export function toPgVector(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/** Text embedded for the write path: name + observations. */
export function embedText(name: string, observations: string | null | undefined): string {
  return `${name}\n${observations ?? ''}`;
}

/**
 * Write-path embedding: gated by EMBED_ON_WRITE_ENABLED (dev-only-embed) and
 * non-fatal on failure — a memory must never be lost to an embed hiccup.
 * Returns null when embedding is disabled or the model call fails; an optional
 * coverage monitor catches persistent NULLs from primary-origin machines.
 */
export async function embedForWrite(
  name: string,
  observations: string | null | undefined,
): Promise<number[] | null> {
  if (!EMBED_ON_WRITE_ENABLED) return null;
  return tryEmbed(embedText(name, observations), 'write-path embed failed (non-fatal, storing NULL)');
}

/**
 * Query-time embedding for recall's semantic signal. Deliberately
 * NOT gated by EMBED_ON_WRITE_ENABLED — that flag scopes whether a machine
 * writes vectors into entities, not whether it can embed a query to search
 * vectors a primary already wrote. An ad-hoc machine with no writes of its own
 * still benefits from semantic recall over the shared brain. Non-fatal: a
 * model-load failure degrades that recall to lexical-only (score contributes 0)
 * rather than failing the whole query.
 */
export async function embedForQuery(text: string): Promise<number[] | null> {
  return tryEmbed(text, 'query-time embed failed (non-fatal, lexical-only fallback)');
}

/**
 * Decide what an update/merge should do with an existing row's embedding when
 * its name/observations text just changed. Shared by mcp-server.ts's `update`
 * handler and intelligence.ts's `mergeMemories` — both mutate already-embedded
 * rows and need the same policy:
 *   - disabled machine → `null` (invalidate — a stale non-NULL
 *     vector looks trustworthy but is invisible to the NULL-based coverage
 *     canary, so force it to the always-safe NULL state instead)
 *   - enabled + embed succeeds → the new vector
 *   - enabled + embed fails (transient) → `undefined` (leave the column
 *     untouched — the existing vector, though now slightly stale, still gives
 *     partial semantic credit; clobbering it with NULL would give none until
 *     a future write or backfill)
 *
 * Callers: only assign `updates.embedding`/`.set({embedding: ...})` when the
 * result is not `undefined`.
 */
export async function resolveEmbeddingForTextChange(
  name: string,
  observations: string | null | undefined,
): Promise<number[] | null | undefined> {
  if (!EMBED_ON_WRITE_ENABLED) return null;
  // The gate is already known true here, so embedForWrite's own internal gate
  // check can't be why it returns null — a null at this point can only mean
  // its try/catch caught a real failure. If embedForWrite ever gains another
  // reason to return null while enabled (e.g. "skip embedding empty text"),
  // this mapping would need to distinguish that case explicitly instead of
  // treating it as "transient, preserve existing."
  const embedding = await embedForWrite(name, observations);
  return embedding === null ? undefined : embedding;
}
