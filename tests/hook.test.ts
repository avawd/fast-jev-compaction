import { describe, expect, it } from 'vitest';
import { compactSession, resolveHookConfig, summarize, toSessionMessages } from '../hooks/verbatim.ts';
import type { Message } from '../src/index.js';
import { harness, NEXT_RESULT } from './harness.ts';

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
    m('assistant', '', { toolUses: [{ tool_use_id: 'u3', tool: 'Bash', input: { command: 'npm test' } }], handle: 'h5' }),
    m('user', '', { toolResults: [{ tool_use_id: 'u3', text: big }], handle: 'h6' }),
    ...Array.from({ length: 6 }, (_, i) => m(i % 2 ? 'user' : 'assistant', `turn ${i}`, { handle: `r${i}` })),
  ];
}

describe('resolveHookConfig', () => {
  it('reads userConfig and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60, minReductionRatio: 0.25, preserveRecentMessages: 6,
      truncateHeadChars: 300, maxCandidates: 400, useClaudeScorer: true, claudeTimeoutMs: 6000,
      truncateTailChars: 1000, staleAfterMessages: 60, pinReferenced: true, stripMcpFurniture: true,
    });
    expect(resolveHookConfig({ claudeTimeoutMs: 2500 }).claudeTimeoutMs).toBe(2500);
    expect(resolveHookConfig({ useClaudeScorer: false, maxCandidates: 50 })).toMatchObject({
      useClaudeScorer: false, maxCandidates: 50,
    });
  });

  it('clamps claudeTimeoutMs to [500, 9000]', () => {
    expect(resolveHookConfig({ claudeTimeoutMs: -5 }).claudeTimeoutMs).toBe(500);
    expect(resolveHookConfig({ claudeTimeoutMs: 0 }).claudeTimeoutMs).toBe(500);
    expect(resolveHookConfig({ claudeTimeoutMs: 499 }).claudeTimeoutMs).toBe(500);
    expect(resolveHookConfig({ claudeTimeoutMs: 500 }).claudeTimeoutMs).toBe(500);
    expect(resolveHookConfig({ claudeTimeoutMs: 9000 }).claudeTimeoutMs).toBe(9000);
    expect(resolveHookConfig({ claudeTimeoutMs: 50_000 }).claudeTimeoutMs).toBe(9000);
    expect(resolveHookConfig({ claudeTimeoutMs: Number.NaN }).claudeTimeoutMs).toBe(6000);
    expect(resolveHookConfig({ claudeTimeoutMs: Infinity }).claudeTimeoutMs).toBe(6000);
    expect(resolveHookConfig({ claudeTimeoutMs: '3000' as unknown as number }).claudeTimeoutMs).toBe(6000);
    expect(resolveHookConfig({ claudeTimeoutMs: 1234.5 }).claudeTimeoutMs).toBe(1234.5);
  });
});

describe('compactSession', () => {
  it('prunes by rules and Claude and keeps untouched engine objects', async () => {
    const input = transcript();
    const { result, messages } = await compactSession(input, resolveHookConfig({}), async () => ({
      text: '{"drop":["t3"],"truncate":[]}',
    }));
    expect(result.stats).toMatchObject({ byRule: 1, byClaude: 1, claude: 'ran' });
    expect(messages[0]).toBe(input[0]);
    expect(messages.some((x) => x.toolUses.some((t) => t.tool_use_id === 'u3'))).toBe(false);
    expect(summarize(result)).toMatch(/rules 1, claude 1/);
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
      expect(h.toasts.join('\n')).toMatch(/rules 1, claude 0 \(error\)/);
    });

    it('falls back to next(event) on an unexpected error', async () => {
      const h = harness();
      const event = { trigger: 'auto', get messages(): never { throw new Error('bad transcript'); } };
      expect(await h.compact(event)).toBe(NEXT_RESULT);
      expect(h.toasts.join('\n')).toMatch(/bad transcript/);
    });

    it('returns the pruned messages and toasts on success', async () => {
      const h = harness({ fork: async () => ({ text: '{"drop":["t3"],"truncate":[]}' }) });
      const out = (await h.compact(prunable())) as { messages: SessionMessage[] };
      expect(h.nextCalls).toHaveLength(0);
      expect(out.messages.some((x) => x.toolUses.some((t) => t.tool_use_id === 'u3'))).toBe(false);
      expect(h.toasts).toHaveLength(1);
      expect(h.toasts[0]).toMatch(/rules 1, claude 1 \(ran\)/);
    });

    it('keeps rule verdicts when the fork outlasts claudeTimeoutMs', async () => {
      const h = harness({ fork: () => new Promise(() => {}), sleep: async () => {} });
      const out = (await h.compact(prunable())) as { messages: SessionMessage[] };
      expect(out.messages).toBeDefined();
      expect(h.toasts[0]).toMatch(/rules 1, claude 0 \(timeout\)/);
      expect(h.sleeps).toHaveLength(1);
      expect(h.sleeps[0]?.ms).toBe(6000);
    });

    it('cancels the pending timeout sleep once a fast fork wins the race', async () => {
      let sleepSignal: AbortSignal | undefined;
      const h = harness({
        fork: async () => ({ text: '{"drop":["t3"],"truncate":[]}' }),
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

    it('skips precompute outright: engine skip shape, no fork, no toast', async () => {
      const h = harness();
      const out = await h.compact({ ...prunable(), trigger: 'precompute' });
      expect(out).toMatchObject({ skip: expect.any(String) });
      expect((out as { messages?: unknown }).messages).toBeUndefined();
      expect(h.forkCalls).toHaveLength(0);
      expect(h.toasts).toHaveLength(0);
      expect(h.logs).toHaveLength(1);
    });

    it('prefixes only the toast; the engine already names the plugin on log lines', async () => {
      const h = harness({ fork: async () => ({ text: '{"drop":["t3"],"truncate":[]}' }) });
      await h.compact(prunable());
      expect(h.toasts[0]).toMatch(/^verbatim-compaction: /);
      expect(h.logs.every((line) => !line.startsWith('verbatim-compaction'))).toBe(true);
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
      await h.turnComplete(answered);
      expect(h.compactCalls).toBe(2);
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
