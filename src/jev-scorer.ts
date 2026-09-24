import type { ToolCall } from './types.js';

/**
 * The Jev-style question set, asked of a session fork instead of TypeSafe's
 * System One: for every candidate call two keep scores, one for the call and
 * one for its result, decided against `keepThreshold` exactly as Jev's
 * `decideCall` does. Pure functions only; running the forks lives in
 * claude-scorer.ts.
 */

/** Most characters of a call's input shown on its candidate line. */
export const INPUT_CHARS = 400;
/** Most characters of a result's head shown on its candidate line. */
export const PREVIEW_CHARS = 80;
/** Most candidates asked about in one fork; more are split over concurrent forks. */
export const DEFAULT_CHUNK_SIZE = 60;
/** The line that must close a reply, so a cut-off reply can be told from a complete one. */
export const SENTINEL = 'END';

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

/** Keep scores for one call, each a digit 0..9 (9 = certainly keep). */
export interface JevScore {
  call: number;
  result: number;
}

export type JevParse =
  | { ok: true; scores: Map<string, JevScore> }
  | { ok: false; reason: 'no-sentinel' };

export type JevAction = 'keep' | 'drop_result' | 'drop_call';

/** Cuts to at most `limit` chars with a trailing `…`, never splitting a surrogate pair. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
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
    'This conversation is about to be compacted. Below are earlier tool calls from it, one per line:',
    'id, tool, position (msg i/N), input, outcome and output size, ref-later:n when values its output introduced are used later, then the start of its output.',
    'For every call give two digits from 0 (certainly no longer needed) to 9 (certainly still needed):',
    '- first, the CALL: knowing this call was made, with its input, still matters for what comes next;',
    '- second, the RESULT: its full output must stay verbatim because its exact text is still needed and re-running would not do.',
    'Keep the call when its input still matters. Keep the result verbatim only when its exact text is still needed and re-running would not do. Prefer truncate over drop unless a later call superseded it.',
    'A high first digit with a low second one truncates the output; two low digits remove the call and its output.',
    `Reply with one line per call, exactly "<id> <call digit><result digit>", for example "t12 93", then a last line "${SENTINEL}". No other text. A call you leave out is kept.`,
    '',
    ...calls.map((call) => jevCandidateLine(call, ctx)),
  ].join('\n');
}

const SCORE_LINE = /^\s*(t\d+)\s+([0-9])\s?([0-9])\s*$/;

/**
 * Reads `<id> <call><result>` lines up to the `END` sentinel. Unknown ids and
 * malformed lines are ignored; a repeated id keeps the higher of each digit
 * (the safer reading). Without the sentinel the reply may have been cut off,
 * so it is rejected unless it scored every id asked about; a partial reply is
 * never applied partially.
 */
export function parseJevReply(text: string, ids: ReadonlySet<string>): JevParse {
  const scores = new Map<string, JevScore>();
  let sentinel = false;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === SENTINEL) {
      sentinel = true;
      break;
    }
    const match = SCORE_LINE.exec(raw);
    if (!match || !ids.has(match[1]!)) continue;
    const score = { call: Number(match[2]), result: Number(match[3]) };
    const prior = scores.get(match[1]!);
    scores.set(
      match[1]!,
      prior ? { call: Math.max(prior.call, score.call), result: Math.max(prior.result, score.result) } : score,
    );
  }
  if (!sentinel && (ids.size === 0 || scores.size < ids.size)) return { ok: false, reason: 'no-sentinel' };
  return { ok: true, scores };
}

/** Jev's decision: result ≥ threshold keeps; else call ≥ threshold truncates; else drops. A digit d reads as d/9. */
export function decide(score: JevScore, keepThreshold: number): JevAction {
  if (score.result / 9 >= keepThreshold) return 'keep';
  if (score.call / 9 >= keepThreshold) return 'drop_result';
  return 'drop_call';
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
