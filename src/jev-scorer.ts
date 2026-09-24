import { sliceWhole } from './text.js';
import type { ToolCall } from './types.js';

/**
 * The Jev-style question set, asked of a session fork instead of TypeSafe's
 * System One: for every candidate call Jev's two questions, whether the call
 * still matters and whether its result must stay verbatim, decided as Jev's
 * `decideCall` does (result → keep, else call → truncate, else drop).
 *
 * The answers come back as three JSON id lists, not as per-call scores. Live
 * on 2.1.281 the API rejected every fork asked for one line per call (`t12 93`
 * digit scores and `t12 K|T|D` letters alike: `api-error`, `invalid_request`,
 * no status, 0 output tokens) once there were 10 or more candidates, while the
 * same candidates under a JSON-lists reply passed at 10, 30 and 60. So Jev's
 * probabilities cannot be asked for; `keepThreshold` survives only as the
 * mapping of the `unsure` list (see `decide`). Pure functions only; running
 * the forks lives in claude-scorer.ts.
 */

/** Most characters of a call's input shown on its candidate line. */
export const INPUT_CHARS = 400;
/** Most characters of a result's head shown on its candidate line. */
export const PREVIEW_CHARS = 80;
/** Most candidates asked about in one fork; more are split over concurrent forks. */
export const DEFAULT_CHUNK_SIZE = 60;

export interface JevContext {
  /** Messages in the transcript, for the `msg i/N` position. */
  messageCount: number;
  /**
   * How often values a call's result introduced are referenced later, keyed by
   * `ToolCall.id`. Filled from the referenced-later pin (pin.ts) once it lands;
   * absent or missing an id, the field is left off the line.
   */
  refLater?: ReadonlyMap<string, number>;
}

/** The fork's answer: which calls fall in each list. A call in none of them is dropped. */
export interface JevAnswer {
  resultNeeded: Set<string>;
  callMatters: Set<string>;
  unsure: Set<string>;
}

export type JevAction = 'keep' | 'drop_result' | 'drop_call';

/** Cuts to at most `limit` chars with a trailing `…`, never splitting a surrogate pair. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${sliceWhole(text, limit - 1)}…`;
}

const CD_PREFIX = /^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/;

/** A Bash command without its leading `cd <dir> &&` / `cd <dir>;` hops, which carry no meaning for the scorer. */
export function stripCdPrefix(command: string): string {
  let rest = command;
  for (let match = CD_PREFIX.exec(rest); match; match = CD_PREFIX.exec(rest)) {
    rest = rest.slice(match[0].length);
  }
  return rest.length > 0 ? rest : command;
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable input]';
  }
}

/** The call's input as `key=value` pairs; a Bash call shows its command alone (description dropped). */
function inputText(call: ToolCall): string {
  let entries: Array<[string, unknown]>;
  try {
    JSON.stringify(call.input);
    entries = Object.entries(call.input);
  } catch {
    return '[unserializable input]';
  }
  if (call.tool === 'Bash' && typeof call.input['command'] === 'string') {
    const others = entries.filter(([k]) => k !== 'command' && k !== 'description');
    const rest = others.map(([k, v]) => `${k}=${valueText(v)}`).join(' ');
    const command = stripCdPrefix(call.input['command']);
    return rest ? `${command} ${rest}` : command;
  }
  return entries.map(([k, v]) => `${k}=${valueText(v)}`).join(' ');
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, '⏎').replace(/\s+/g, ' ').trim();
}

/** `t12 Bash msg 16/189 npm test → ok 4213ch ref-later:2 | PASS src/a.test.ts…` */
export function jevCandidateLine(call: ToolCall, ctx: JevContext): string {
  const parts = [
    `${call.id} ${call.tool} msg ${call.callIndex + 1}/${ctx.messageCount}`,
    clip(oneLine(inputText(call)), INPUT_CHARS),
    `→ ${call.isError ? 'error' : 'ok'} ${call.resultChars}ch`,
  ];
  const refs = ctx.refLater?.get(call.id);
  if (typeof refs === 'number' && refs > 0) parts.push(`ref-later:${refs}`);
  let line = parts.join(' ');
  const head = call.resultHead === undefined ? '' : oneLine(call.resultHead);
  if (head.length > 0) line += ` | ${clip(head, PREVIEW_CHARS)}`;
  return line;
}

export function buildJevPrompt(calls: readonly ToolCall[], ctx: JevContext): string {
  return [
    'Context maintenance request. Do not continue the task and do not call tools.',
    'This conversation is about to be compacted. Below are earlier tool calls from it, one per line: id, tool, position (msg i/N), input, outcome and output size, ref-later:n when values its output introduced are used later, then the start of its output.',
    'Keep the call when its input still matters. Keep the result verbatim only when its exact text is still needed and re-running would not do. Prefer truncate over drop unless a later call superseded it.',
    'For every call answer two questions: must its RESULT stay verbatim, and does the CALL itself (knowing it was made, with its input) still matter? If you cannot tell, put it in unsure.',
    'Reply with JSON only, exactly this shape: {"result_needed":[],"call_matters":[],"unsure":[]}',
    'A call in result_needed is kept whole; one only in call_matters or in unsure keeps the call but its output is truncated; one in none of them is removed with its output.',
    '',
    ...calls.map((call) => jevCandidateLine(call, ctx)),
  ].join('\n');
}

function idList(value: unknown, ids: ReadonlySet<string>): Set<string> | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) return undefined;
  return new Set((value as string[]).filter((id) => ids.has(id)));
}

/**
 * Parses the reply's JSON object (first `{` to last `}`). `result_needed` and
 * `call_matters` must both be string arrays and `unsure` one when present;
 * anything else, a cut-off reply included, is undefined and decides nothing,
 * since an absent id means "drop". Unknown ids are ignored.
 */
export function parseJevReply(text: string, ids: ReadonlySet<string>): JevAnswer | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  const resultNeeded = idList(record['result_needed'], ids);
  const callMatters = idList(record['call_matters'], ids);
  const unsure = record['unsure'] === undefined ? new Set<string>() : idList(record['unsure'], ids);
  if (!resultNeeded || !callMatters || !unsure) return undefined;
  return { resultNeeded, callMatters, unsure };
}

/**
 * What `unsure` becomes: `keepThreshold` is how sure a call must be to stay,
 * so a low one keeps the doubtful whole (< 0.5), the default truncates them
 * (0.5–0.75), a high one removes them (> 0.75).
 */
export function unsureAction(keepThreshold: number): JevAction {
  if (keepThreshold < 0.5) return 'keep';
  return keepThreshold <= 0.75 ? 'drop_result' : 'drop_call';
}

/** Jev's decision per call; when lists overlap the one that keeps more wins. */
export function decide(id: string, answer: JevAnswer, keepThreshold: number): JevAction {
  if (answer.resultNeeded.has(id)) return 'keep';
  const unsure = answer.unsure.has(id) ? unsureAction(keepThreshold) : 'drop_call';
  if (unsure === 'keep') return 'keep';
  return answer.callMatters.has(id) ? 'drop_result' : unsure;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
