/**
 * Minimised repros of what the fuzz suites found. A known, unfixed bug is `it.fails`: it passes
 * while the bug is there and fails once it is fixed, which is the cue to turn it into `it` and
 * to clear the matching KNOWN_BUG flag in fuzz-hook.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { MAX_CONCURRENT_FORKS, scoreWithClaude, type ForkFn, type ForkReply, type ToolCall } from '../src/index.js';

function call(id: string): ToolCall {
  return { id, tool_use_id: `u-${id}`, tool: 'Bash', input: { command: `echo ${id}` }, callIndex: 1, resultIndex: 2, resultChars: 5000, isError: false, pinned: false };
}

async function unhandledDuring(run: () => Promise<unknown>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const trap = (reason: unknown) => { seen.push(reason); };
  process.on('unhandledRejection', trap);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off('unhandledRejection', trap);
  }
  return seen;
}

describe('fuzz regressions', () => {
  // Found by fuzz-hook seeds 46, 76, 84 (FUZZ_SEEDS=300): `$.model.fork` absent, or throwing
  // synchronously, while the clock rejects (the engine's `$.clock.sleep` rejects when the hook's
  // `finally { cancelSleep.abort() }` fires). scoreWithClaude's shared deadline promise
  // (claude-scorer.ts:208) is only ever observed through forkWithin's race (:73), and forkWithin
  // calls fork() (:71) before it subscribes; when every fork throws synchronously nobody
  // observes the deadline, and its rejection is unhandled.
  it('a clock rejection stays handled when every fork throws synchronously', async () => {
    const fork = (() => { throw new Error('no fork'); }) as unknown as ForkFn;
    const leaked = await unhandledDuring(async () => {
      const controller = new AbortController();
      const sleep = () => new Promise<void>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      const out = await scoreWithClaude(fork, [call('t1'), call('t2')], {
        maxCandidates: 400, keepThreshold: 0.5, chunkSize: 60, context: { messageCount: 3 }, timeout: { timeoutMs: 1000, sleep },
      });
      expect(out.status).toBe('error');
      controller.abort();
    });
    expect(leaked).toEqual([]);
  });

  // Found by fuzz-integrity seeds 163 and 212 (FUZZ_SEEDS=300, after merging optimize 184a24d).
  // Chunking caps the FIRST wave at MAX_CONCURRENT_FORKS, but a chunk whose fork and whole re-ask
  // both failed splits into two halves (claude-scorer.ts:170, scoreChunkWithRetry's Promise.all over
  // the halves) while the other chunks' forks are still running: 7 slow + 2 halves = 9. Worst
  // case is 2 × the cap (every chunk splitting at once).
  it.fails('KNOWN BUG: half retries push concurrent forks past MAX_CONCURRENT_FORKS', async () => {
    const calls = Array.from({ length: 2 * MAX_CONCURRENT_FORKS }, (_, i) => call(`t${i + 1}`));
    const last = `t${2 * MAX_CONCURRENT_FORKS}`;
    let inFlight = 0;
    let most = 0;
    const fork: ForkFn = ({ prompt }) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      const done = () => { inFlight -= 1; };
      // The last chunk is refused at once (first ask and whole re-ask); every other fork is slow.
      const reply: Promise<ForkReply> = prompt.includes(`\n${last} `) && prompt.includes(`\nt${2 * MAX_CONCURRENT_FORKS - 1} `)
        ? Promise.resolve({ isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request' })
        : new Promise((resolve) => setTimeout(() => resolve({ isAnswered: false, reason: 'aborted' }), 20));
      reply.then(done, done);
      return reply;
    };
    await scoreWithClaude(fork, calls, { maxCandidates: 400, keepThreshold: 0.5, chunkSize: 2, context: { messageCount: 3 } });
    expect(most).toBeLessThanOrEqual(MAX_CONCURRENT_FORKS);
  });
});
