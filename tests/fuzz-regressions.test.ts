/**
 * Minimised repros of what the fuzz suites found. A known, unfixed bug is `it.fails`: it passes
 * while the bug is there and fails once it is fixed, which is the cue to turn it into `it` and
 * to clear the matching KNOWN_BUG flag in fuzz-hook.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { fingerprint, runCase } from './fuzz-check.ts';
import { genTranscript } from './fuzz-gen.ts';
import { annotateCalls, collectToolCalls, compact, compactUserRows, gateRatio, makeScorer, MAX_CONCURRENT_FORKS, resolveOptions, rulesGate, scoreWithClaude, type ForkFn, type ForkReply, type Message, type ToolCall } from '../src/index.js';

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
  it('half retries never push concurrent forks past MAX_CONCURRENT_FORKS', async () => {
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

describe('review 2 regressions', () => {
  it('a fork queued behind the cap never starts after the deadline has passed', async () => {
    const calls = Array.from({ length: 2 * MAX_CONCURRENT_FORKS }, (_, i) => call(`t${i + 1}`));
    const last = `t${2 * MAX_CONCURRENT_FORKS}`;
    let deadlinePassedAt = Infinity;
    const lateStarts: number[] = [];
    const fork: ForkFn = ({ prompt }) => {
      const at = Date.now();
      if (at >= deadlinePassedAt) lateStarts.push(at);
      // The last chunk is refused at once, so its halves queue behind seven forks that outlive the deadline.
      if (prompt.includes(`\n${last} `)) {
        return Promise.resolve({ isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request' });
      }
      return new Promise((resolve) => setTimeout(() => resolve({ isAnswered: false, reason: 'aborted' }), 60));
    };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(() => { deadlinePassedAt = Date.now(); resolve(); }, ms));
    await scoreWithClaude(fork, calls, {
      maxCandidates: 400, keepThreshold: 0.5, chunkSize: 2, context: { messageCount: 3 },
      timeout: { timeoutMs: 15, sleep },
    });
    // Let every fork that is still queued or running settle before judging.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lateStarts).toEqual([]);
  });

  // Found by review of c6815d5: the repeat check tokenized an idle notification's raw JSON, where
  // `\ndeadbeef12345678` reads as `ndeadbeef12345678`, so the quote between the two copies was
  // missed and the older copy was stubbed: the token was gone before the quote.
  it('an idle token quoted between two identical copies survives', () => {
    const m = (role: Message['role'], text: string): Message => ({ role, text, toolUses: [] });
    const idle = (result: string) => m('user', `Another Claude session sent a message:\n<teammate-message teammate_id="x" color="blue">\n${JSON.stringify({ type: 'idle_notification', from: 'x', result })}\n</teammate-message>`);
    const result = `${'p'.repeat(500)}\ndeadbeef12345678 is the commit`;
    const input = [m('user', 'Start'), m('assistant', 'go'), idle(result), m('assistant', 'use deadbeef12345678'), idle(result),
      ...Array.from({ length: 10 }, (_, i) => m(i % 2 ? 'assistant' : 'user', `f${i}`))];
    const out = compactUserRows(input, resolveOptions({ preserveRecentMessages: 2, dedupePeerNotice: false }));
    expect(out.messages.slice(0, 3).map((x) => x.text).join('\n')).toContain('deadbeef12345678');
  });

  // Found by fuzz-integrity seed 4680 (FUZZ_SEEDS=5000) under CPU load: "a second run gave a
  // different output". The fake's 'late' fork settled on a 5 ms timer and the timed deadline on
  // setImmediate; a loop held up past 5 ms runs the timer first, so "late" arrived in time. The
  // harness now settles a late fork only after the deadline has fired. A loop slowed on purpose
  // (every setImmediate held 10 ms) must not change any seed's output.
  it('a slow event loop does not change a timed seed\'s output', async () => {
    const real = globalThis.setImmediate;
    const slow = ((fn: (...a: unknown[]) => void, ...args: unknown[]) => setTimeout(() => fn(...args), 10)) as unknown as typeof setImmediate;
    const changed: number[] = [];
    for (const seed of [4680, ...Array.from({ length: 60 }, (_, k) => k + 1)]) {
      const normal = fingerprint(await runCase(seed, genTranscript(seed)));
      globalThis.setImmediate = slow;
      let held: string;
      try {
        held = fingerprint(await runCase(seed, genTranscript(seed)));
      } finally {
        globalThis.setImmediate = real;
      }
      if (held !== normal) changed.push(seed);
    }
    expect(changed).toEqual([]);
  }, 60_000);

describe('review of cee10e7 (exact repros)', () => {
  const heredoc = ['cat > /tmp/s.py <<EOF', ...Array.from({ length: 200 }, (_, i) => `print("line ${i} of the script body")`), 'EOF', 'python3 /tmp/s.py'].join('\n');
  const m = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({ role, text, toolUses: [], ...extra });
  const use = (id: string, command: string) => m('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command } }] });
  const res = (id: string, text: string) => m('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] });
  const filler = Array.from({ length: 30 }, (_, i) => m(i % 2 === 0 ? 'user' : 'assistant', `filler ${i}`));
  const keepAll = async () => ({ verdicts: new Map(), claude: 'skipped' as const });
  const OPTS = { preserveRecentMessages: 6, staleAfterMessages: 20 };

  /** Claude Code's merge: every row of one reply (`reply`) in its first row's place; rebuilt rows their own. */
  function unpaired(input: Message[], output: Message[], reply: Map<Message, string>): string[] {
    const api: Array<{ role: string; uses: string[]; results: Set<string> }> = [];
    const byReply = new Map<string, (typeof api)[number]>();
    output.forEach((row, k) => {
      const last = api[api.length - 1];
      if (row.role === 'assistant') {
        const key = (input.includes(row) && reply.get(row)) || `rebuilt${k}`;
        const earlier = byReply.get(key);
        if (earlier) earlier.uses.push(...row.toolUses.map((u) => u.tool_use_id));
        else { const made = { role: 'assistant', uses: row.toolUses.map((u) => u.tool_use_id), results: new Set<string>() }; byReply.set(key, made); api.push(made); }
      } else if (last?.role === 'user') for (const r of row.toolResults ?? []) last.results.add(r.tool_use_id);
      else api.push({ role: 'user', uses: [], results: new Set((row.toolResults ?? []).map((r) => r.tool_use_id)) });
    });
    return api.flatMap((a, k) => a.uses.filter((id) => !api[k + 1]?.results.has(id)));
  }

  it('HIGH 1: text, use A, result, text, use B, result (one reply) keeps every call paired', async () => {
    const input = [m('user', 'go'), m('assistant', 'Checking.'), use('a', heredoc), res('a', 'one'), m('assistant', 'Also this.'), use('b', 'echo b'), res('b', 'two'), ...filler];
    const reply = new Map(input.slice(1, 7).filter((r) => r.role === 'assistant').map((r) => [r, 'S']));
    const out = (await compact(input, keepAll, OPTS)).messages;
    expect(out[2]).not.toBe(input[2]);
    expect(unpaired(input, out, reply)).toEqual([]);
  });

  it('HIGH 2: a turn-end reply (then a Stop-hook continuation) is never rebuilt with the next call', async () => {
    const turnEnd = Array.from({ length: 60 }, (_, k) => `Line ${k} of the report that ended the turn.`).join('\n');
    const input = [m('user', 'go'), use('x', 'ls'), res('x', 'ok'), m('assistant', turnEnd), use('y', heredoc), res('y', 'ok'), ...filler];
    const out = (await compact(input, keepAll, OPTS)).messages;
    expect(out[3]).toBe(input[3]);
    expect(out[4]!.text).toBe('');
  });

  it('LOW 2: the gate the scorer projects counts the input shrink as gateRatio does', async () => {
    const input = [m('user', 'go'), use('a', heredoc), res('a', 'x'.repeat(2000)), ...filler];
    const resolved = resolveOptions(OPTS);
    const calls = annotateCalls(collectToolCalls(input, resolved.preserveRecentMessages), input, resolved);
    const actual = await compact(input, makeScorer({ useClaudeScorer: false, maxCandidates: 400, keepThreshold: 0.5, messageCount: input.length }), OPTS);
    expect(gateRatio(actual)).toBeGreaterThanOrEqual(0.25);
    expect(rulesGate(input, resolved.truncateHeadChars, 0.25, resolved)(calls, new Map())).toBe(true);
  });
});

});
