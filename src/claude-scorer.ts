import { buildJevPrompt, chunk, decide, parseJevReply, type JevContext } from './jev-scorer.js';
import type { ClaudeStatus, ForkRun, ToolCall, Verdict } from './types.js';

/**
 * What `$.model.fork` resolves to. Claude Code 2.1.281 always answers with a result:
 * `isAnswered: true` and the text, or `isAnswered: false` and why not. Older engines
 * resolved `{ text }` or null; both are still read so a downgrade degrades gracefully.
 */
export type ForkReply =
  | { isAnswered: true; text: string }
  | { isAnswered: false; reason: string; status?: number | null; error?: string }
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

/** At most `max` calls, preferring the largest results, returned in transcript order. */
export function selectCandidates(calls: readonly ToolCall[], max: number): ToolCall[] {
  if (calls.length <= max) return [...calls];
  const chosen = new Set(
    [...calls].sort((a, b) => b.resultChars - a.resultChars).slice(0, Math.max(0, max)).map((x) => x.id),
  );
  return calls.filter((x) => chosen.has(x.id));
}

/**
 * Names why an unanswered fork has no text, so a toast says `api-error 529` rather
 * than `unparseable` (a reply that never arrived was never parsed).
 */
function unansweredStatus(reply: { reason: string; status?: number | null; error?: string }): ClaudeStatus {
  switch (reply.reason) {
    case 'nothing-to-fork':
      return 'no-fork';
    case 'api-error':
      if (typeof reply.status === 'number') return `api-error ${reply.status}`;
      // 2.1.281 builds a status-less invalid_request frame for a safeguard refusal (lQe on
      // stop_reason "refusal"); the only other status-less invalid_request is a client-side
      // oversized-image error, which a text-only fork prompt cannot trigger.
      return reply.error === 'invalid_request' ? 'refused' : 'api-error';
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

/**
 * Runs one fork and reduces every outcome to its text or the status naming why there is none:
 * a throw is `error`, the timeout `timeout`, an unanswered reply its engine reason.
 */
export async function runFork(
  fork: ForkFn,
  prompt: string,
  timeout?: ForkTimeout,
): Promise<{ text: string } | { status: ClaudeStatus }> {
  let reply: ForkReply | typeof TIMED_OUT;
  try {
    reply = await forkWithin(fork, prompt, timeout);
  } catch {
    return { status: 'error' };
  }
  return reply === TIMED_OUT ? { status: 'timeout' } : replyText(reply);
}

export interface ClaudeScoreOptions {
  /** Most calls asked about in total, largest results first. */
  maxCandidates: number;
  /** Maps the fork's `unsure` list (jev-scorer.ts `unsureAction`). */
  keepThreshold: number;
  /** Most calls per fork; more run as concurrent forks. */
  chunkSize: number;
  context: JevContext;
  timeout?: ForkTimeout;
  /** Milliseconds clock for the per-fork timings. */
  now?: () => number;
}

type ChunkResult = { verdicts: Map<string, Verdict>; runs: ForkRun[] };

/**
 * Failures worth a re-ask: a safeguard refusal (2.1.281 reports it as a status-less `api-error`,
 * or, when it lands mid-reply, as cut-off text that does not parse), an empty reply, or a lazy
 * one under the coverage gate. Refusals are probabilistic per request, so the same chunk is asked
 * once more whole, and only then split. A timeout, an abort or a missing fork would fail the same
 * way again.
 */
function retryable(status: ClaudeStatus): boolean {
  return status === 'refused' || status === 'api-error' || status === 'unparseable' || status === 'empty';
}

/** Most forks one compaction runs at once; past it, chunks grow instead. */
export const MAX_CONCURRENT_FORKS = 8;

async function scoreChunk(
  fork: ForkFn,
  calls: readonly ToolCall[],
  options: ClaudeScoreOptions,
  timeout: ForkTimeout | undefined,
  now: () => number,
  retry?: 'whole' | 'half',
): Promise<ChunkResult> {
  const started = now();
  const answer = await runFork(fork, buildJevPrompt(calls, options.context), timeout);
  const run = (status: ClaudeStatus): ForkRun => ({
    candidates: calls.length, ms: now() - started, status, ...(retry ? { retry } : {}),
  });
  const verdicts = new Map<string, Verdict>();
  if ('status' in answer) return { verdicts, runs: [run(answer.status)] };
  const parsed = parseJevReply(answer.text, new Set(calls.map((x) => x.id)));
  if (!parsed) return { verdicts, runs: [run('unparseable')] };
  for (const call of calls) {
    const action = decide(call.id, parsed, options.keepThreshold);
    if (action !== 'keep') verdicts.set(call.id, { action, source: 'claude' });
  }
  return { verdicts, runs: [run('ran')] };
}

/**
 * One chunk; when its fork failed in a retryable way, the same chunk once more whole, and when
 * that fails too, its two halves once, concurrently. Nothing is re-asked past the deadline.
 */
async function scoreChunkWithRetry(
  fork: ForkFn,
  calls: readonly ToolCall[],
  options: ClaudeScoreOptions,
  timeout: ForkTimeout | undefined,
  now: () => number,
  expired: () => boolean,
): Promise<ChunkResult> {
  const first = await scoreChunk(fork, calls, options, timeout, now);
  if (!retryable(first.runs[0]!.status) || expired()) return first;
  const whole = await scoreChunk(fork, calls, options, timeout, now, 'whole');
  const runs = [...first.runs, ...whole.runs];
  if (!retryable(whole.runs[0]!.status) || calls.length < 2 || expired()) return { verdicts: whole.verdicts, runs };
  const half = Math.ceil(calls.length / 2);
  const halves = await Promise.all(
    [calls.slice(0, half), calls.slice(half)].map((part) => scoreChunk(fork, part, options, timeout, now, 'half')),
  );
  const verdicts = new Map<string, Verdict>();
  for (const h of halves) for (const [id, verdict] of h.verdicts) verdicts.set(id, verdict);
  return { verdicts, runs: [...runs, ...halves.flatMap((h) => h.runs)] };
}

/**
 * Per chunk: answered when its fork, its whole re-ask, or both halves ran. `ran` when every
 * chunk answered, the first failure when no fork ran, `partial` in between.
 */
function overallStatus(chunks: readonly ChunkResult[]): ClaudeStatus {
  const answered = (c: ChunkResult) => {
    if (c.runs.some((r) => r.status === 'ran' && r.retry !== 'half')) return true;
    const halves = c.runs.filter((r) => r.retry === 'half');
    return halves.length > 0 && halves.every((r) => r.status === 'ran');
  };
  if (chunks.every(answered)) return 'ran';
  const anyRan = chunks.some((c) => c.runs.some((r) => r.status === 'ran'));
  return anyRan ? 'partial' : chunks[0]!.runs[0]!.status;
}

/**
 * Asks Jev's two questions about each call through session forks: candidates
 * are split into chunks of `chunkSize`, one `runFork` per chunk, all
 * concurrent (at most MAX_CONCURRENT_FORKS: past it chunks grow) and all racing
 * ONE shared deadline (a single sleep). A failed chunk is re-asked whole once,
 * then as two halves. Answers are merged; whatever
 * still failed decides nothing (its calls are kept).
 */
export async function scoreWithClaude(
  fork: ForkFn,
  calls: readonly ToolCall[],
  options: ClaudeScoreOptions,
): Promise<{ verdicts: Map<string, Verdict>; status: ClaudeStatus; forks: ForkRun[] }> {
  const candidates = selectCandidates(calls, options.maxCandidates);
  if (candidates.length === 0) return { verdicts: new Map(), status: 'skipped', forks: [] };
  const now = options.now ?? Date.now;
  let shared: ForkTimeout | undefined;
  let expired = false;
  if (options.timeout) {
    const expiry = options.timeout.sleep(options.timeout.timeoutMs).then(() => { expired = true; });
    shared = { timeoutMs: options.timeout.timeoutMs, sleep: () => expiry };
  }
  const results = await Promise.all(
    chunk(candidates, Math.max(options.chunkSize, Math.ceil(candidates.length / MAX_CONCURRENT_FORKS))).map((part) =>
      scoreChunkWithRetry(fork, part, options, shared, now, () => expired)),
  );
  const verdicts = new Map<string, Verdict>();
  for (const result of results) for (const [id, verdict] of result.verdicts) verdicts.set(id, verdict);
  return { verdicts, status: overallStatus(results), forks: results.flatMap((r) => r.runs) };
}
