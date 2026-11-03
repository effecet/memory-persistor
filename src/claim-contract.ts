/**
 * Write-time claim contract: rules about what a memory body CLAIMS, as
 * opposed to its shape (zod) or its name (`assertMemoryNameIsTitle`).
 *
 * Pure, and its only import is the zero-import `errors.ts` leaf, so it
 * unit-tests without a database and every write path (`remember`, `update`,
 * `merge`, `make seed`) can call the same functions — a rule enforced on one
 * path lets the corpus drift in through the others (the lesson of the retired
 * `memory_name_guard.py`).
 *
 * Two rules, each measured against a production corpus before it was built
 * (2026-10-15, 1,125 memories; see the design doc):
 *
 *   transcript        REJECT  — 0 live hits. A log is not a memory.
 *   undated-volatile  FLAG    — tags, never blocks.
 *
 * Both rules ignore fenced code blocks: a memory that DOCUMENTS a chat format
 * or a `sleep 5s` command is not a transcript and not a stale claim. A false
 * rejection destroys knowledge the session had; a false flag costs one tag.
 *
 * A third rule, `recurrence` ("always", "every time"), was measured and
 * DROPPED: it hit 20% of the corpus and ~90% of those were instructions
 * ("Always use docker-compose.yml"), not generalisations. Do not re-add it
 * without re-measuring.
 *
 * Flags are reported in their own `flags` field, NOT in `warnings`: `warnings`
 * means a step FAILED after the write, and a call carrying any is logged as a
 * `tool_warning` event that analytics counts as a failure.
 */
import { CategorizedError } from './errors.js';

/** The tag a flagged body carries. Server-managed: set and cleared only by this contract. */
export const VOLATILE_TAG = 'volatile';

/** Either a rejection, or an accepted body with its flag — never both. */
export type ClaimCheck =
  | { reject: string; volatile?: never }
  | { reject: null; volatile: boolean };

/** One entry of a write response's `flags`: the write succeeded, but says something worth fixing. */
export interface ClaimFlag {
  rule: 'undated-volatile';
  message: string;
}

const VOLATILE_FLAG: ClaimFlag = {
  rule: 'undated-volatile',
  message:
    `observations state a volatile figure (a size, percentage, duration or count) with no date, ` +
    `so it will read as current after it goes stale. Tagged '${VOLATILE_TAG}'. Add the date it was ` +
    `true (e.g. "2026-10-15", "Oct 2026" or "as of ...") to clear the flag.`,
};

/**
 * A line that opens or closes a fence: optional indent, then 3+ backticks or
 * tildes. A backtick run followed later on the line by another backtick is
 * inline code (```x``` is inline), not a fence — CommonMark forbids a backtick
 * in a backtick fence's info string — so it must not swallow the rest of the body.
 */
const FENCE_LINE = /^[ \t]*(`{3,}(?!.*`)|~{3,})/;

/**
 * The body with fenced code removed, line by line. Errs toward stripping,
 * because what is stripped can only cause a missed flag, while what is not can
 * cause a false REJECT: any indent opens a fence (a fence inside a list item is
 * still code), a fence closes only on the same character at least as long, and
 * an unclosed fence runs to the end of the body, as CommonMark has it.
 */
export function stripFencedCode(body: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const marker = line.match(FENCE_LINE)?.[1];
    if (fence === null) {
      if (marker) fence = marker;
      else kept.push(line);
    } else if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) {
      fence = null;
    }
  }
  return kept.join('\n');
}

/**
 * A line that opens with a speaker label, as a chat transcript writes it:
 * capitalised, line-leading. Prose that mentions "User:" mid-sentence does not
 * count, and `[ \t]` keeps the match on one line.
 */
const SPEAKER_TURN = /^[ \t]*(?:User|Assistant|Human)[ \t]*:/gm;
const TRANSCRIPT_MIN_TURNS = 4;

/**
 * A number followed by a unit whose value goes stale: a percentage, a size, a
 * duration, or a count of things in this brain. The lookbehind keeps it from
 * starting mid-identifier; the lookahead keeps `5min` from matching `5minutes`
 * as `5m`.
 */
const VOLATILE_FIGURE =
  /(?<![\w.])(\d+(?:[.,]\d+)?)(\s?)(%|[kKMG]i?B|ms|s|min|h|entities|rows|edges|files|tokens|lines)(?![A-Za-z])/g;

/**
 * Anything that dates the body: an ISO or slashed date, a capitalised month and
 * a 19xx/20xx year, or an explicit "as of". Read over the WHOLE body, code
 * blocks included, on purpose: a dated log excerpt does date the memory.
 *
 * Kept tight because a false anchor hides a stale figure: the bare word
 * "measured" ("measured in ms") and a case-insensitive month prefix ("may 2000
 * rows", "Market 2025") both counted once and dated nothing.
 */
const DATE_ANCHOR = new RegExp(
  [
    // No trailing \b: an ISO timestamp (2026-10-15T10:00) continues with a word char.
    String.raw`\b\d{4}[-/]\d{2}[-/]\d{2}(?!\d)`,
    String.raw`\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.? (?:19|20)\d{2}\b`,
    String.raw`\b[Aa]s of\b`,
  ].join('|'),
);

/**
 * Status codes that show up pluralised in prose ("causing 401s", "it 409s").
 * A fixed list, not the 100-599 range: that range also swallowed real
 * durations such as "timeout is 300s".
 */
const HTTP_STATUSES = new Set([
  '200', '201', '204', '301', '302', '304', '400', '401', '403', '404', '405',
  '409', '410', '422', '429', '500', '502', '503', '504',
]);

/** A match of VOLATILE_FIGURE that is not a stale-prone figure after all. */
function isNotAFigure(value: string, space: string, unit: string): boolean {
  if (unit !== 's') return false;
  return (
    space !== '' ||                                   // "a 5 s pause": too loose to trust
    HTTP_STATUSES.has(value) ||                       // "401s"
    (/^(?:19|20)\d0$/.test(value))                    // "the 1990s"
  );
}

function hasVolatileFigure(body: string): boolean {
  for (const m of body.matchAll(VOLATILE_FIGURE)) {
    if (!isNotAFigure(m[1], m[2], m[3])) return true;
  }
  return false;
}

/** Counts speaker turns, stopping as soon as the threshold is reached. */
function speakerTurns(body: string): number {
  let turns = 0;
  for (const _ of body.matchAll(SPEAKER_TURN)) {
    if (++turns >= TRANSCRIPT_MIN_TURNS) break;
  }
  return turns;
}

export function checkClaims(observations: string): ClaimCheck {
  const prose = stripFencedCode(observations);
  if (speakerTurns(prose) >= TRANSCRIPT_MIN_TURNS) {
    return {
      reject:
        `observations read as a conversation transcript (${TRANSCRIPT_MIN_TURNS}+ speaker-turn lines ` +
        `outside code blocks). Record the conclusion, not the log: what was learned, decided or measured.`,
    };
  }
  return { reject: null, volatile: hasVolatileFigure(prose) && !DATE_ANCHOR.test(observations) };
}

/**
 * checkClaims for a write that must not proceed on a rejection: throws the
 * canonical `validation` error. Single source of that error, so `remember` and
 * `update` cannot drift apart on it (the `assertMemoryNameIsTitle` pattern).
 */
export function assertClaimsAccepted(observations: string): { reject: null; volatile: boolean } {
  const check = checkClaims(observations);
  if (check.reject !== null) throw new CategorizedError('validation', check.reject);
  return check;
}

/** The `flags` a write response carries for an accepted body; empty when there is nothing to report. */
export function claimFlags(volatile: boolean): ClaimFlag[] {
  return volatile ? [VOLATILE_FLAG] : [];
}

/** True when the flag is accepted-and-volatile; a rejected or unreadable body is not. */
export function isVolatile(observations: string): boolean {
  const check = checkClaims(observations);
  return check.reject === null && check.volatile;
}

/**
 * `tags` with VOLATILE_TAG present exactly when `volatile` is true. Every other
 * tag, and their order, is the caller's and is left alone — so an update that
 * dates a body clears the flag without touching anything else, and a caller
 * cannot add or drop the flag by hand.
 */
export function withVolatileTag(tags: string[], volatile: boolean): string[] {
  const rest = tags.filter((t) => t !== VOLATILE_TAG);
  return volatile ? [...rest, VOLATILE_TAG] : rest;
}

/**
 * The `make seed` row decision, pure so it can be tested (`src/import.ts` runs
 * `main()` on load and cannot be imported by a test). An empty body falls back
 * to the frontmatter description, as the importer always did.
 */
export function prepareImportRow(
  body: string,
  description: string,
  tags: string[],
): { skip: string } | { observations: string; tags: string[] } {
  const observations = body || description;
  const check = checkClaims(observations);
  if (check.reject !== null) return { skip: check.reject };
  return { observations, tags: withVolatileTag(tags, check.volatile) };
}
