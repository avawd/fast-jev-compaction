import { describe, expect, it } from 'vitest';
import { compactSession, resolveHookConfig, summarize, toSessionMessages } from '../hooks/verbatim.ts';
import type { Message } from '../src/index.js';
import { dropAll, harness, NEXT_RESULT } from './harness.ts';

type SessionMessage = Message & { handle?: string };
const big = 'y'.repeat(3000);
function m(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}
function transcript(): SessionMessage[] {
  return [
    m('user', 'Refactor the parser.', { handle: 'h0' }),
    m('assistant', '', { toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'src/p.ts' } }], handle: 'h1' }),
    m('user', '', { toolResults: [{ tool_use_id: 'u1', text: big }], handle: 'h2' }),
    m('assistant', '', { toolUses: [{ tool_use_id: 'u2', tool: 'Edit', input: { file_path: 'src/p.ts' } }], handle: 'h3' }),
    m('user', '', { toolResults: [{ tool_use_id: 'u2', text: 'ok' }], handle: 'h4' }),
    m('assistant', 'Running the tests.', { toolUses: [{ tool_use_id: 'u3', tool: 'Bash', input: { command: 'npm test' } }], handle: 'h5' }),
    m('user', '', { toolResults: [{ tool_use_id: 'u3', text: big }], handle: 'h6' }),
    ...Array.from({ length: 6 }, (_, i) => m(i % 2 ? 'user' : 'assistant', `turn ${i}`, { handle: `r${i}` })),
  ];
}

describe('resolveHookConfig', () => {
  it('clamps keepThreshold to [0, 1] and forkChunkSize to a whole number in [1, 400]', () => {
    expect(resolveHookConfig({ keepThreshold: 0.7 }).keepThreshold).toBe(0.7);
    expect(resolveHookConfig({ keepThreshold: -1 }).keepThreshold).toBe(0);
    expect(resolveHookConfig({ keepThreshold: 3 }).keepThreshold).toBe(1);
    expect(resolveHookConfig({ forkChunkSize: 0 }).forkChunkSize).toBe(1);
    expect(resolveHookConfig({ forkChunkSize: 1000 }).forkChunkSize).toBe(400);
    expect(resolveHookConfig({ forkChunkSize: 25.7 }).forkChunkSize).toBe(25);
  });

  it('reads userConfig and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60, compactAtTokens: 300000, minReductionRatio: 0.25, preserveRecentMessages: 6,
      truncateHeadChars: 300, maxCandidates: 400, useClaudeScorer: true, claudeTimeoutMs: 30000,
      truncateTailChars: 1000, staleAfterMessages: 100, pinReferenced: true, stripMcpFurniture: true,
      keepThreshold: 0.5, forkChunkSize: 60,
    });
    expect(resolveHookConfig({ claudeTimeoutMs: 2500 }).claudeTimeoutMs).toBe(2500);
    expect(resolveHookConfig({ useClaudeScorer: false, maxCandidates: 50 })).toMatchObject({
      useClaudeScorer: false, maxCandidates: 50,
    });
  });

  it('clamps claudeTimeoutMs to [500, 45000]', () => {
    expect(resolveHookConfig({ claudeTimeoutMs: -5 }).claudeTimeoutMs).toBe(500);
    expect(resolveHookConfig({ claudeTimeoutMs: 0 }).claudeTimeoutMs).toBe(500);
    expect(resolveHookConfig({ claudeTimeoutMs: 499 }).claudeTimeoutMs).toBe(500);
    expect(resolveHookConfig({ claudeTimeoutMs: 500 }).claudeTimeoutMs).toBe(500);
    expect(resolveHookConfig({ claudeTimeoutMs: 45_000 }).claudeTimeoutMs).toBe(45_000);
    expect(resolveHookConfig({ claudeTimeoutMs: 50_000 }).claudeTimeoutMs).toBe(45_000);
    expect(resolveHookConfig({ claudeTimeoutMs: Number.NaN }).claudeTimeoutMs).toBe(30_000);
    expect(resolveHookConfig({ claudeTimeoutMs: Infinity }).claudeTimeoutMs).toBe(30_000);
    expect(resolveHookConfig({ claudeTimeoutMs: '3000' as unknown as number }).claudeTimeoutMs).toBe(30_000);
    expect(resolveHookConfig({ claudeTimeoutMs: 1234.5 }).claudeTimeoutMs).toBe(1234.5);
  });
});

describe('compactSession', () => {
  it('prunes by rules and Claude and keeps untouched engine objects', async () => {
    const input = transcript();
    const { result, messages } = await compactSession(input, resolveHookConfig({}), async ({ prompt }) => ({
      text: dropAll(prompt),
    }));
    expect(result.stats).toMatchObject({ byRule: 1, byClaude: 1, claude: 'ran' });
    expect(messages[0]).toBe(input[0]);
    expect(messages.some((x) => x.toolUses.some((t) => t.tool_use_id === 'u3'))).toBe(false);
    expect(summarize(result)).toMatch(/rules 1, claude 1 \(ran \d+\.\ds\)/);
    // "kept 10/10 messages … kept 0" read as "nothing changed": the per-call figure is named for what it is.
    expect(summarize(result)).toMatch(/untouched \d+, pinned \d+/);
    expect(summarize(result)).not.toMatch(/kept \d+, pinned/);
  });

  it('is rules-only without a fork', async () => {
    const { result } = await compactSession(transcript(), resolveHookConfig({}));
    expect(result.stats.claude).toBe('skipped');
    expect(result.stats.byRule).toBe(1);
  });

  it('toSessionMessages returns originals when nothing changed', () => {
    const input = transcript();
    expect(toSessionMessages(input, input).every((x, i) => x === input[i])).toBe(true);
  });
});

describe('register', () => {
  const prunable = () => ({ trigger: 'auto', messages: transcript() });
  // Only Claude can prune this one: no rule applies to a single Bash call.
  const claudeOnly = (): SessionMessage[] => [
    m('user', 'Run the tests.'),
    m('assistant', '', { toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'npm test' } }] }),
    m('user', '', { toolResults: [{ tool_use_id: 'u1', text: big }] }),
    ...Array.from({ length: 6 }, (_, i) => m(i % 2 ? 'user' : 'assistant', `turn ${i}`)),
  ];

  describe('session.compact', () => {
    it('falls back to next(event) when the reduction is too small', async () => {
      const h = harness();
      const event = { trigger: 'auto', messages: claudeOnly() };
      expect(await h.compact(event)).toBe(NEXT_RESULT);
      expect(h.nextCalls).toEqual([event]);
      expect(h.forkCalls).toHaveLength(1);
    });

    it('reports a thrown fork as claude 0 (error) but still prunes when rules alone clear the threshold', async () => {
      const h = harness({ fork: async () => { throw new Error('api down'); } });
      const out = (await h.compact(prunable())) as { messages: SessionMessage[] };
      expect(out.messages).toBeDefined();
      expect(h.nextCalls).toHaveLength(0);
      expect(h.forkCalls).toHaveLength(1);
      expect(h.toasts.join('\n')).toMatch(/rules 1, claude 0 \(error \d+\.\ds\)/);
    });

    it('falls back to next(event) on an unexpected error', async () => {
      const h = harness();
      const event = { trigger: 'auto', get messages(): never { throw new Error('bad transcript'); } };
      expect(await h.compact(event)).toBe(NEXT_RESULT);
      expect(h.toasts.join('\n')).toMatch(/bad transcript/);
    });

    it('returns the pruned messages and toasts on success', async () => {
      const h = harness({ fork: async ({ prompt }) => ({ text: dropAll(prompt) }) });
      const out = (await h.compact(prunable())) as { messages: SessionMessage[] };
      expect(h.nextCalls).toHaveLength(0);
      expect(out.messages.some((x) => x.toolUses.some((t) => t.tool_use_id === 'u3'))).toBe(false);
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0]).toMatch(/rules 1, claude 1 \(ran \d+\.\ds\)/);
    });

    it('keeps rule verdicts when the fork outlasts claudeTimeoutMs', async () => {
      const h = harness({ fork: () => new Promise(() => {}), sleep: async () => {} });
      const out = (await h.compact(prunable())) as { messages: SessionMessage[] };
      expect(out.messages).toBeDefined();
      expect(h.toasts[0]).toMatch(/rules 1, claude 0 \(timeout \d+\.\ds\)/);
      expect(h.sleeps).toHaveLength(1);
      expect(h.sleeps[0]?.ms).toBe(30000);
    });

    it('cancels the pending timeout sleep once a fast fork wins the race', async () => {
      let sleepSignal: AbortSignal | undefined;
      const h = harness({
        fork: async ({ prompt }) => ({ text: dropAll(prompt) }),
        sleep: (_ms, opts) => { sleepSignal = opts?.signal; return new Promise(() => {}); },
      });
      await h.compact(prunable());
      expect(sleepSignal).toBeDefined();
      expect(sleepSignal?.aborted).toBe(true);
      // The dispatch's own signal (next.signal) must stay untouched: cancellation is local.
      expect(h.signal.aborted).toBe(false);
    });

    it('honours a configured claudeTimeoutMs', async () => {
      const h = harness({
        fork: () => new Promise(() => {}), sleep: async () => {}, userConfig: { claudeTimeoutMs: 2500 },
      });
      await h.compact(prunable());
      expect(h.sleeps[0]?.ms).toBe(2500);
    });

    it('runs rules only for a subagent transcript', async () => {
      const h = harness();
      const out = (await h.compact({ ...prunable(), agentId: 'a1' })) as { messages: SessionMessage[] };
      expect(h.forkCalls).toHaveLength(0);
      expect(out.messages).toBeDefined();
      expect(h.toasts[0]).toMatch(/claude 0 \(skipped\)/);
    });

    it('answers precompute with the real pipeline: pruned messages, fork run, log but no toast', async () => {
      const h = harness({ fork: async ({ prompt }) => ({ text: dropAll(prompt) }) });
      const out = (await h.compact({ ...prunable(), trigger: 'precompute' })) as { messages: SessionMessage[] };
      expect(out.messages).toBeDefined();
      expect(out.messages.some((x) => x.toolUses.some((t) => t.tool_use_id === 'u3'))).toBe(false);
      expect(h.forkCalls).toHaveLength(1);
      expect(h.nextCalls).toHaveLength(0);
      expect(h.toasts).toHaveLength(0);
      expect(h.logs.join('\n')).toMatch(/^precompute: kept /m);
    });

    it('hands a precompute below the threshold to next(event), so core precomputes its summary', async () => {
      const h = harness();
      const event = { trigger: 'precompute', messages: claudeOnly() };
      expect(await h.compact(event)).toBe(NEXT_RESULT);
      expect(h.nextCalls).toEqual([event]);
      expect(h.toasts).toHaveLength(0);
    });

    it('never races the short timeout on precompute: nobody is waiting, so the forks get the ceiling', async () => {
      const h = harness({ fork: () => new Promise(() => {}), sleep: async () => {} });
      await h.compact({ ...prunable(), trigger: 'precompute' });
      expect(h.sleeps.map((x) => x.ms)).toEqual([45_000]);
    });

    it('races claudeTimeoutMs when rules alone clear the gate, awaits the ceiling when they do not', async () => {
      const racing = harness({ fork: () => new Promise(() => {}), sleep: async () => {} });
      await racing.compact(prunable());
      expect(racing.sleeps.map((x) => x.ms)).toEqual([30_000]);
      const awaiting = harness({ fork: () => new Promise(() => {}), sleep: async () => {} });
      await awaiting.compact({ trigger: 'auto', messages: claudeOnly() });
      expect(awaiting.sleeps.map((x) => x.ms)).toEqual([45_000]);
    });

    it('logs per-fork timings and the wait mode to the debug log', async () => {
      const h = harness({ fork: async ({ prompt }) => ({ text: dropAll(prompt) }) });
      await h.compact(prunable());
      expect(h.debugLogs.join('\n')).toMatch(/scorer: wait race; 1 fork \[1 calls \d+ms ran\]; claude \d+ms; total \d+ms/);
    });

    it('asks the fork about the undecided calls with their position and a preview', async () => {
      const h = harness();
      await h.compact(prunable());
      expect(h.forkCalls[0]).toMatch(/^t3 Bash msg 6\/13 npm test → ok 3000ch \| y{79}…/m);
      expect(h.forkCalls[0]).not.toMatch(/^t2 /m); // t1's stale_read evidence
    });

    it('logs the effective config to the debug log once per load', async () => {
      const h = harness({ userConfig: { claudeTimeoutMs: 30000 } });
      await h.compact(prunable());
      await h.compact(prunable());
      await h.turnComplete({ reason: 'answer', answer: 'x', durationMs: 1, isAborted: false, turnId: 'x' });
      const lines = h.debugLogs.filter((line) => line.startsWith('config '));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"claudeTimeoutMs":30000');
      expect(lines[0]).toContain('"compactAtPercent":60');
      expect(h.logs.some((line) => line.startsWith('config '))).toBe(false);
    });

    it('reports a skipped Claude stage without a duration', async () => {
      const h = harness();
      await h.compact({ ...prunable(), agentId: 'a1' });
      expect(h.toasts[0]).toMatch(/claude 0 \(skipped\)/);
    });

    it('prefixes only the toast; the engine already names the plugin on log lines', async () => {
      const h = harness({ fork: async ({ prompt }) => ({ text: dropAll(prompt) }) });
      await h.compact(prunable());
      expect(h.toasts[0]).toMatch(/^verbatim-compaction: /);
      expect(h.logs.every((line) => !line.startsWith('verbatim-compaction'))).toBe(true);
    });

    it('never calls next() twice: a throw from the handed-off next() is rethrown, not retried', async () => {
      for (const extra of [{ nextThrows: new Error('core compaction failed') }, { nextThrowsSync: new Error('bad argument') }]) {
        const h = harness(extra);
        await expect(h.compact({ trigger: 'auto', messages: claudeOnly() })).rejects.toThrow();
        expect(h.nextCalls).toHaveLength(1);
      }
    });

    it('still falls back to next() once when the pipeline itself throws', async () => {
      const h = harness();
      const event = { trigger: 'auto', get messages(): never { throw new Error('bad transcript'); } };
      expect(await h.compact(event)).toBe(NEXT_RESULT);
      expect(h.nextCalls).toHaveLength(1);
    });

    it('works when next() carries no signal', async () => {
      const h = harness({ noSignal: true, fork: async ({ prompt }) => ({ text: dropAll(prompt) }) });
      const out = (await h.compact(prunable())) as { messages: SessionMessage[] };
      expect(out.messages).toBeDefined();
    });

    it('hands a transcript of 4096 messages or more straight to next(), with a log line', async () => {
      const h = harness();
      const many = Array.from({ length: 4096 }, (_, i) => m(i % 2 ? 'assistant' : 'user', `m${i}`));
      const event = { trigger: 'auto', messages: many };
      expect(await h.compact(event)).toBe(NEXT_RESULT);
      expect(h.nextCalls).toEqual([event]);
      expect(h.forkCalls).toHaveLength(0);
      expect(h.logs.join('\n')).toMatch(/4096 messages/);
    });

    it('leaves "0 dropped" out of the summary', async () => {
      const h = harness();
      await h.compact(prunable());
      expect(h.toasts[0]).toMatch(/1 truncated/);
      expect(h.toasts[0]).not.toMatch(/dropped/);
    });

    it('skips an empty transcript itself instead of passing empty messages to next', async () => {
      for (const extra of [{}, { instructions: 'keep the plan' }]) {
        const h = harness();
        const out = await h.compact({ trigger: 'manual', messages: [], ...extra });
        expect(out).toMatchObject({ skip: expect.any(String) });
        expect(h.nextCalls).toHaveLength(0);
        expect(h.forkCalls).toHaveLength(0);
        expect(h.toasts).toHaveLength(0);
      }
    });

    it('hands /compact <instructions> to the built-in summary', async () => {
      const h = harness();
      const event = { ...prunable(), trigger: 'manual', instructions: 'keep the plan' };
      expect(await h.compact(event)).toBe(NEXT_RESULT);
      expect(h.nextCalls).toEqual([event]);
      expect(h.forkCalls).toHaveLength(0);
    });

    it('prunes a manual /compact without instructions', async () => {
      const h = harness();
      const out = await h.compact({ ...prunable(), trigger: 'manual', instructions: '  ' });
      expect(out).not.toBe(NEXT_RESULT);
    });

    it('survives a throwing toast and log', async () => {
      const boom = () => { throw new Error('ui gone'); };
      const h = harness({ toast: boom, log: boom });
      const out = (await h.compact(prunable())) as { messages: SessionMessage[] };
      expect(out.messages).toBeDefined();
      const low = harness({ toast: boom, log: boom });
      expect(await low.compact({ trigger: 'auto', messages: claudeOnly() })).toBe(NEXT_RESULT);
    });
  });

  describe('turn.complete', () => {
    const answered = { reason: 'answer', answer: 'done', durationMs: 1, isAborted: false, turnId: 'x' };

    it('does not compact below the threshold', async () => {
      const h = harness({ percent: 59 });
      expect(await h.turnComplete(answered)).toBe(NEXT_RESULT);
      expect(h.compactCalls).toBe(0);
    });

    it('logs the context percent against the threshold at debug level', async () => {
      const h = harness({ percent: 59 });
      await h.turnComplete(answered);
      expect(h.debugLogs).toContain('context 59% (compacts at 60% or 300k tokens)');
      expect(h.logs).toHaveLength(0);
    });

    it('compacts once at or above the threshold', async () => {
      const h = harness({ percent: 60 });
      expect(await h.turnComplete(answered)).toBe(NEXT_RESULT);
      expect(h.compactCalls).toBe(1);
    });

    it('does not start a second compaction while usage is still pending', async () => {
      let release: (p: number) => void = () => {};
      const pending = new Promise<number>((resolve) => { release = resolve; });
      const h = harness({ percent: () => pending });
      const first = h.turnComplete(answered);
      const second = h.turnComplete(answered);
      release(90);
      await Promise.all([first, second]);
      expect(h.usageCalls).toBe(1);
      expect(h.compactCalls).toBe(1);
    });

    it('does not compact again until usage has dropped back under the threshold (hysteresis)', async () => {
      // A verbatim prune can leave context above the threshold; compacting again on the very next turn
      // finds little left to prune and falls back to a full summary (seen live, interactive run i2).
      let percent = 90;
      const h = harness({ percent: async () => percent });
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(1);
      await h.turnComplete(answered);
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(1);
      expect(h.debugLogs.some((line) => /waiting for context to drop under the threshold/.test(line))).toBe(true);
      percent = 30;
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(1);
      percent = 75;
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(2);
      expect(h.nextCalls).toHaveLength(5);
    });

    it('stops asking after $.session.compact rejects (headless), and says so once', async () => {
      const headless = new Error('$.session.compact: not available in a headless (-p / SDK) session yet');
      const h = harness({ percent: 90, sessionCompact: async () => { throw headless; } });
      for (let i = 0; i < 3; i += 1) expect(await h.turnComplete(answered)).toBe(NEXT_RESULT);
      expect(h.compactCalls).toBe(1);
      expect(h.usageCalls).toBe(1);
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0]).toMatch(/auto-compact off for this session/);
      expect(h.toasts[0]).toMatch(/headless/);
      expect(h.logs.filter((line) => /auto-compact off/.test(line))).toHaveLength(1);
      expect(h.nextCalls).toHaveLength(3);
    });

    it('keeps asking after a rejection that is not the headless one (e.g. a turn is running)', async () => {
      let calls = 0;
      const busy = new Error('$.session.compact: rejected while a turn runs');
      const h = harness({ percent: 90, sessionCompact: async () => { calls += 1; throw busy; } });
      expect(await h.turnComplete(answered)).toBe(NEXT_RESULT);
      await h.fireTimers();
      await h.fireTimers();
      expect(calls).toBe(3);
      expect(h.toasts.some((t) => /auto-compact off/.test(t))).toBe(false);
      // Refusals for now go to the debug log only: a retry every few seconds must not fill the transcript.
      expect(h.logs).toHaveLength(0);
      expect(h.debugLogs.filter((line) => /rejected while a turn runs/.test(line))).toHaveLength(3);
    });

    it('compacts once the context holds compactAtTokens, whatever the percent reads', async () => {
      // A 1M window at 60% is 600k tokens: seen live, that is far too late to prune verbatim in time.
      const h = harness({ percent: 31, tokens: 310_000 });
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(1);
    });

    it('does not compact under both compactAtTokens and compactAtPercent', async () => {
      const h = harness({ percent: 29, tokens: 290_000 });
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(0);
    });

    it('honours a configured compactAtTokens', async () => {
      const h = harness({ percent: 15, tokens: 150_000, userConfig: { compactAtTokens: 120_000 } });
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(1);
    });

    it('retries on a timer when a queued turn is already running, until it compacts', async () => {
      // Seen live: in a busy session (teammate messages, task notices) the next turn starts before the
      // plugin asks, the engine rejects with "a turn is running", and every turn end hits the same wall.
      let busy = 2;
      const h = harness({
        percent: 90,
        sessionCompact: async () => {
          if (busy > 0) { busy -= 1; throw new Error('$.session.compact: a turn is running (t1); the conversation compacts between turns'); }
          return { messages: [] };
        },
      });
      expect(await h.turnComplete(answered)).toBe(NEXT_RESULT);
      expect(h.compactCalls).toBe(1);
      expect(h.timers).toHaveLength(1);
      await h.fireTimers();
      expect(h.compactCalls).toBe(2);
      expect(h.timers).toHaveLength(1);
      await h.fireTimers();
      expect(h.compactCalls).toBe(3);
      expect(h.timers).toHaveLength(0);
      // Compacted: hysteresis holds until usage drops.
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(3);
    });

    it('keeps one retry timer at a time, and a turn end while one is pending does not ask again', async () => {
      const h = harness({ percent: 90, sessionCompact: async () => { throw new Error('a turn is running (t2)'); } });
      await h.turnComplete(answered);
      await h.turnComplete(answered);
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(1);
      expect(h.timers).toHaveLength(1);
    });

    it('gives up retrying after a bounded number of attempts and waits for the next turn end', async () => {
      const h = harness({ percent: 90, sessionCompact: async () => { throw new Error('a turn is running (t3)'); } });
      await h.turnComplete(answered);
      for (let i = 0; i < 100 && h.timers.length > 0; i += 1) await h.fireTimers();
      expect(h.timers).toHaveLength(0);
      const attempts = h.compactCalls;
      expect(attempts).toBeGreaterThan(5);
      expect(attempts).toBeLessThan(40);
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(attempts + 1);
    });

    it('a retry that finds context already under the threshold does not compact', async () => {
      let percent = 90;
      const h = harness({ percent: async () => percent, sessionCompact: async () => { throw new Error('a turn is running (t4)'); } });
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(1);
      percent = 10;
      await h.fireTimers();
      expect(h.compactCalls).toBe(1);
      expect(h.timers).toHaveLength(0);
    });

    it('ignores subagent turns and turns that did not end in an answer', async () => {
      const h = harness({ percent: 99 });
      await h.turnComplete({ ...answered, agentId: 'a1' });
      await h.turnComplete({ ...answered, reason: 'aborted', isAborted: true });
      await h.turnComplete({ ...answered, reason: 'error' });
      expect(h.usageCalls).toBe(0);
      expect(h.compactCalls).toBe(0);
      expect(h.nextCalls).toHaveLength(3);
    });
  });
});

describe('resolveHookConfig clamps (review 2)', () => {
  it('keeps minReductionRatio inside (0, 1): a gate of 0 or less would bill a fork and change nothing', () => {
    expect(resolveHookConfig({ minReductionRatio: 0 }).minReductionRatio).toBeGreaterThan(0);
    expect(resolveHookConfig({ minReductionRatio: -1 }).minReductionRatio).toBeGreaterThan(0);
    expect(resolveHookConfig({ minReductionRatio: 5 }).minReductionRatio).toBeLessThan(1);
    expect(resolveHookConfig({ minReductionRatio: 0.3 }).minReductionRatio).toBe(0.3);
  });

  it('keeps compactAtPercent between 1 and 100', () => {
    expect(resolveHookConfig({ compactAtPercent: 0 }).compactAtPercent).toBe(1);
    expect(resolveHookConfig({ compactAtPercent: -20 }).compactAtPercent).toBe(1);
    expect(resolveHookConfig({ compactAtPercent: 400 }).compactAtPercent).toBe(100);
    expect(resolveHookConfig({ compactAtPercent: 60 }).compactAtPercent).toBe(60);
  });
});
