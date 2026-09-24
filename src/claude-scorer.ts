import { sliceWhole } from './text.js';
import type { ClaudeStatus, ToolCall, Verdict } from './types.js';

/**
 * What `$.model.fork` resolves to. Claude Code 2.1.281 always answers with a result:
 * `isAnswered: true` and the text, or `isAnswered: false` and why not. Older engines
 * resolved `{ text }` or null; both are still read so a downgrade degrades gracefully.
 */
export type ForkReply =
  | { isAnswered: true; text: string }
  | { isAnswered: false; reason: string; status?: number | null }
  | { text: string }
  | null;

/** The shape of `$.model.fork`: one prompt appended to the session's own transcript. */
export type ForkFn = (request: { prompt: string }) => Promise<ForkReply>;

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
  return text.length <= limit ? text : `${sliceWhole(text, limit - 1)}…`;
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

/**
 * Names why an unanswered fork has no text, so a toast says `api-error 529` rather
 * than `unparseable` (a reply that never arrived was never parsed).
 */
function unansweredStatus(reply: { reason: string; status?: number | null }): ClaudeStatus {
  switch (reply.reason) {
    case 'nothing-to-fork':
      return 'no-fork';
    case 'api-error':
      return typeof reply.status === 'number' ? `api-error ${reply.status}` : 'api-error';
    case 'aborted':
      return 'aborted';
    case 'empty-reply':
      return 'empty';
    default:
      return 'error';
  }
}

/** The reply's text, or the status that explains its absence. */
function replyText(reply: ForkReply): { text: string } | { status: ClaudeStatus } {
  if (reply === null) return { status: 'null' };
  if ('isAnswered' in reply && reply.isAnswered === false) return { status: unansweredStatus(reply) };
  const text = (reply as { text?: unknown }).text;
  return typeof text === 'string' ? { text } : { status: 'empty' };
}

/** The fork's reply, or TIMED_OUT when `timeout` elapses first. The fork itself cannot be cancelled. */
function forkWithin(
  fork: ForkFn,
  prompt: string,
  timeout: ForkTimeout | undefined,
): Promise<ForkReply | typeof TIMED_OUT> {
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
  let reply: ForkReply | typeof TIMED_OUT;
  try {
    reply = await forkWithin(fork, buildPrompt(candidates), timeout);
  } catch {
    return { verdicts: new Map(), status: 'error' };
  }
  if (reply === TIMED_OUT) return { verdicts: new Map(), status: 'timeout' };
  const answer = replyText(reply);
  if ('status' in answer) return { verdicts: new Map(), status: answer.status };
  const verdicts = parseReply(answer.text, new Set(candidates.map((x) => x.id)));
  return verdicts ? { verdicts, status: 'ran' } : { verdicts: new Map(), status: 'unparseable' };
}
