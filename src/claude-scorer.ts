import type { ClaudeStatus, ToolCall, Verdict } from './types.js';

/** The shape of `$.model.fork`: one prompt appended to the session's own transcript. */
export type ForkFn = (request: { prompt: string }) => Promise<{ text: string } | null>;

/** Resolves after `ms` milliseconds; injected so this module needs no engine or timer global. */
export type SleepFn = (ms: number) => Promise<void>;

/** Bounds the fork: past `timeoutMs` the Claude stage gives up and decides nothing. */
export interface ForkTimeout {
  timeoutMs: number;
  sleep: SleepFn;
}

const TIMED_OUT = Symbol('timeout');

const INPUT_CHARS = 120;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function candidateLine(call: ToolCall): string {
  let input: string;
  try {
    input = JSON.stringify(call.input);
  } catch {
    input = '[unserializable input]';
  }
  return `${call.id} ${call.tool} ${clip(input, INPUT_CHARS)} → ${call.isError ? 'error' : 'ok'} ${call.resultChars}ch`;
}

/** At most `max` calls, preferring the largest results, returned in transcript order. */
export function selectCandidates(calls: readonly ToolCall[], max: number): ToolCall[] {
  if (calls.length <= max) return [...calls];
  const chosen = new Set(
    [...calls].sort((a, b) => b.resultChars - a.resultChars).slice(0, Math.max(0, max)).map((x) => x.id),
  );
  return calls.filter((x) => chosen.has(x.id));
}

export function buildPrompt(calls: readonly ToolCall[]): string {
  return [
    'Context maintenance request. Do not continue the task and do not call tools.',
    'Below are earlier tool calls from this conversation, one per line: id, tool, input, outcome, output size.',
    'Decide which are no longer needed to continue the current work.',
    '- "drop": neither the call nor its output matters any more (superseded, irrelevant, or a dead end).',
    '- "truncate": it matters that the call happened, but its full output is no longer needed.',
    'Anything you do not list is kept verbatim. When unsure, leave it out.',
    'Reply with JSON only, exactly this shape: {"drop":[],"truncate":[]}',
    '',
    ...calls.map(candidateLine),
  ].join('\n');
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/**
 * Parses the reply's JSON object (from the first `{` to the last `}`).
 * Unknown ids are ignored; an id in both lists becomes `truncate`.
 * Returns undefined when there is no valid object of the expected shape.
 */
export function parseReply(text: string, ids: ReadonlySet<string>): Map<string, Verdict> | undefined {
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
  const drop = stringArray((parsed as Record<string, unknown>)['drop']);
  const truncate = stringArray((parsed as Record<string, unknown>)['truncate']);
  if (!drop || !truncate) return undefined;
  const verdicts = new Map<string, Verdict>();
  for (const id of drop) if (ids.has(id)) verdicts.set(id, { action: 'drop_call', source: 'claude' });
  for (const id of truncate) if (ids.has(id)) verdicts.set(id, { action: 'drop_result', source: 'claude' });
  return verdicts;
}

/** The fork's reply, or TIMED_OUT when `timeout` elapses first. The fork itself cannot be cancelled. */
function forkWithin(
  fork: ForkFn,
  prompt: string,
  timeout: ForkTimeout | undefined,
): Promise<{ text: string } | null | typeof TIMED_OUT> {
  const reply = fork({ prompt });
  if (!timeout) return reply;
  const expiry = timeout.sleep(timeout.timeoutMs).then((): typeof TIMED_OUT => TIMED_OUT);
  return Promise.race([reply, expiry]);
}

export async function scoreWithClaude(
  fork: ForkFn,
  calls: readonly ToolCall[],
  maxCandidates: number,
  timeout?: ForkTimeout,
): Promise<{ verdicts: Map<string, Verdict>; status: ClaudeStatus }> {
  const candidates = selectCandidates(calls, maxCandidates);
  if (candidates.length === 0) return { verdicts: new Map(), status: 'skipped' };
  let reply: { text: string } | null | typeof TIMED_OUT;
  try {
    reply = await forkWithin(fork, buildPrompt(candidates), timeout);
  } catch {
    return { verdicts: new Map(), status: 'error' };
  }
  if (reply === TIMED_OUT) return { verdicts: new Map(), status: 'timeout' };
  if (reply === null) return { verdicts: new Map(), status: 'null' };
  if (typeof reply.text !== 'string') return { verdicts: new Map(), status: 'unparseable' };
  const verdicts = parseReply(reply.text, new Set(candidates.map((x) => x.id)));
  return verdicts ? { verdicts, status: 'ran' } : { verdicts: new Map(), status: 'unparseable' };
}
