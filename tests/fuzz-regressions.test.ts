/**
 * Minimised repros of what the fuzz suites found. A known, unfixed bug is `it.fails`: it passes
 * while the bug is there and fails once it is fixed, which is the cue to turn it into `it` and
 * to clear the matching KNOWN_BUG flag in fuzz-hook.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { scoreWithClaude, type ForkFn, type ToolCall } from '../src/index.js';

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
});
