/**
 * The MCP error contract. A LEAF module — zero imports, on purpose:
 * pending.ts, file-sync.ts and intelligence.ts throw CategorizedError, and
 * anything a leaf imports is evaluated before its importer's body (see the
 * config.ts / db.ts load-order note in CLAUDE.md).
 *
 * Wire shape on failure: isError: true, text = {error, errorCategory, isRetryable}.
 * A superset of the common {error, status} shape: a reader that checks for a
 * top-level `error` key works on servers using either.
 */

export type ErrorCategory = 'validation' | 'business' | 'transient' | 'permission' | 'internal';

export class CategorizedError extends Error {
  readonly category: ErrorCategory;

  constructor(category: ErrorCategory, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CategorizedError';
    this.category = category;
  }
}

export type ClassifiedError = { category: ErrorCategory; message: string };

export type ErrorResult = { content: [{ type: 'text'; text: string }]; isError: true };

export type NonFatalWarning = { step: string; errorCategory: ErrorCategory; error: string };

// Postgres SQLSTATEs that mean "the same call may succeed later". Class 08
// (connection exception) is matched by prefix below; classes 40/53/57 are
// ENUMERATED on purpose — not every member is safe to retry (53100 disk_full,
// 53200 out_of_memory, 57014 query_canceled). Do not "simplify" to prefixes.
const TRANSIENT_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300', '40001', '40P01']);
const TRANSIENT_ERRNOS = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED']);

// Only the SQLSTATEs a CALLER can cause with bad input. Classes 22/23 are NOT
// matched by prefix: 22003 (the float4 underflow that aborted recall, the hub-ranking bug) and
// 22012 (division by zero) are server-side faults the caller cannot fix.
const VALIDATION_SQLSTATES = new Set(['22P02', '22001', '23502', '23503', '23505', '23514']);

// pg / pg-pool raise these with NO `code` — and they are the commonest
// Supavisor failures. Matched on exact driver-owned prefixes only; this is not
// a general message sniffer.
const TRANSIENT_DRIVER_MESSAGES = [
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
];

// Cause chains are short; the cap only exists so a cyclic chain terminates.
const MAX_CAUSE_DEPTH = 8;

/** The error and its causes, outermost first, cycle-safe. */
function causeChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let cur: unknown = err;
  while (cur !== undefined && cur !== null && chain.length < MAX_CAUSE_DEPTH && !chain.includes(cur)) {
    chain.push(cur);
    cur = cur instanceof Error ? (cur as Error & { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function codeOf(chain: unknown[]): string | undefined {
  for (const e of chain) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** A drizzle DrizzleQueryError: its message is the full SQL plus params. */
function isQueryError(e: Error): boolean {
  return 'query' in e && 'params' in e;
}

/**
 * The innermost Error's message. drizzle 0.45 wraps driver errors in a
 * DrizzleQueryError whose own message is the full SQL plus params — memory
 * content — so that message must never reach a caller, even when drizzle had
 * no Error to wrap. An AggregateError (connect refused on every address) has an
 * empty message of its own; report its first member's instead.
 */
function messageOf(err: unknown, chain: unknown[]): string {
  const errors = chain.filter((e): e is Error => e instanceof Error);
  if (errors.length === 0) return err === undefined || err === null ? 'Unknown error' : String(err);
  const innermost = errors[errors.length - 1];
  if (isQueryError(innermost)) return 'Database query failed';
  if (innermost.message) return innermost.message;
  const first = innermost instanceof AggregateError ? innermost.errors.find((e) => e instanceof Error) : undefined;
  return first?.message || innermost.name || 'Unknown error';
}

function categoryOf(chain: unknown[]): ErrorCategory {
  const code = codeOf(chain);
  if (code !== undefined) {
    if (code.startsWith('08') || TRANSIENT_SQLSTATES.has(code) || TRANSIENT_ERRNOS.has(code)) return 'transient';
    if (VALIDATION_SQLSTATES.has(code)) return 'validation';
  }
  // Any error in the chain, not just the innermost: pg-pool wraps its
  // connection-timeout error AROUND the socket cause.
  const driverTransient = chain.some(
    (e) => e instanceof Error && TRANSIENT_DRIVER_MESSAGES.some((m) => e.message.startsWith(m)),
  );
  return driverTransient ? 'transient' : 'internal';
}

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof CategorizedError) return { category: err.category, message: err.message };
  const chain = causeChain(err);
  return { category: categoryOf(chain), message: messageOf(err, chain) };
}

export function isRetryable(category: ErrorCategory): boolean {
  return category === 'transient';
}

export function toErrorResult(c: ClassifiedError): ErrorResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: c.message, errorCategory: c.category, isRetryable: isRetryable(c.category) }),
      },
    ],
    isError: true,
  };
}

/**
 * Run a step whose failure must NOT fail the tool call (the write already
 * landed; failing would invite a duplicating retry). The failure is not
 * swallowed: it goes to stderr and into `warnings`, which the caller returns.
 */
export async function runNonFatal<T>(
  step: string,
  fn: () => Promise<T>,
  warnings: NonFatalWarning[],
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const c = classifyError(err);
    console.error(`[memory-persistor] non-fatal step ${step} failed (${c.category}): ${c.message}`);
    warnings.push({ step, errorCategory: c.category, error: c.message });
    return undefined;
  }
}
