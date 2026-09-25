import { describe, expect, it } from 'vitest';
import type { EvalMessage, Segment } from './parse.ts';
import { loadPlugin } from './plugin.ts';
import {
  buildStream,
  estimateTokens,
  fitTokenModel,
  idempotence,
  noteCount,
  replay,
  turnEnds,
  type TokenModel,
} from './replay.ts';

const NOTE = '[verbatim-compaction truncated';
const prompt = (text: string): EvalMessage => ({ role: 'user', text, toolUses: [] });
const say = (text: string): EvalMessage => ({ role: 'assistant', text, toolUses: [] });
const call = (id: string, tool: string, input: Record<string, unknown>): EvalMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool, input }],
});
const result = (id: string, text: string): EvalMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text }],
});

describe('estimateTokens', () => {
  it('is overhead + visible chars + hidden chars, each at its own rate', () => {
    const a = say('x'.repeat(100));
    const b = result('u1', 'y'.repeat(50));
    const hidden = new Map([[a, 40]]);
    const model: TokenModel = { overhead: 1000, perVisibleChar: 0.5, perHiddenChar: 0.25 };
    expect(estimateTokens([a, b], hidden, model)).toBe(1000 + 150 * 0.5 + 40 * 0.25);
  });
});

describe('fitTokenModel', () => {
  it('recovers the coefficients of exact data', () => {
    const points = [
      { visible: 100, hidden: 10, usage: 0 },
      { visible: 1000, hidden: 50, usage: 0 },
      { visible: 5000, hidden: 900, usage: 0 },
      { visible: 20000, hidden: 3000, usage: 0 },
    ].map((p) => ({ ...p, usage: 7000 + 0.6 * p.visible + 0.2 * p.hidden }));
    const m = fitTokenModel(points)!;
    expect(m.overhead).toBeCloseTo(7000, 3);
    expect(m.perVisibleChar).toBeCloseTo(0.6, 6);
    expect(m.perHiddenChar).toBeCloseTo(0.2, 6);
  });

  it('fits overhead + visible alone when no row has hidden chars', () => {
    const points = [100, 1000, 5000, 20000].map((visible) => ({ visible, hidden: 0, usage: 500 + 0.7 * visible }));
    const m = fitTokenModel(points)!;
    expect(m.overhead).toBeCloseTo(500, 3);
    expect(m.perVisibleChar).toBeCloseTo(0.7, 6);
    expect(m.perHiddenChar).toBe(0);
  });

  it('returns undefined when there are too few points to fit', () => {
    expect(fitTokenModel([{ visible: 1, hidden: 0, usage: 5 }])).toBeUndefined();
  });
});

describe('turnEnds', () => {
  it('marks an assistant row followed by a typed prompt, and the last row', () => {
    const rows = [prompt('go'), call('u1', 'Read', {}), result('u1', 'r'), say('done'), prompt('next'), say('ok')];
    expect(turnEnds(rows)).toEqual([false, false, false, true, false, true]);
  });
});

describe('noteCount / idempotence', () => {
  it('counts truncation notes', () => {
    expect(noteCount(`head\n${NOTE} 5 chars]\n${NOTE} 9 chars]`)).toBe(2);
    expect(noteCount('plain')).toBe(0);
  });

  it('reports results truncated before that shrank again, nested notes, and dropped truncations', () => {
    const t1 = `${'a'.repeat(300)}\n${NOTE} 900 chars of this tool result; re-run the tool if needed]`;
    const before = [call('u1', 'Read', {}), result('u1', t1), call('u2', 'Read', {}), result('u2', t1), result('u3', t1)];
    const after = [
      call('u1', 'Read', {}),
      result('u1', t1),
      call('u2', 'Read', {}),
      result('u2', `${'a'.repeat(10)}\n${NOTE} 1 chars]\n${NOTE} 2 chars]`),
    ];
    expect(idempotence(before, after)).toEqual({ truncatedBefore: 3, reshrunk: 1, nested: 1, dropped: 1 });
  });
});

describe('buildStream', () => {
  const seg = (index: number, messages: EvalMessage[], startsWithSummary = false): Segment => ({
    file: 'f',
    index,
    messages,
    hiddenChars: messages.map(() => 1),
    usageTokens: messages.map(() => 0),
    startsWithSummary,
    thinkingRows: 0,
    metaRowsSkipped: 0,
    skippedLines: 0,
  });

  it('joins segments, dropping each later one\'s summary row and the rows it carried over', () => {
    const a = [prompt('go'), call('u1', 'Read', {}), result('u1', 'r'), say('done')];
    const b = [prompt('SUMMARY'), result('u1', 'r'), say('done'), prompt('more'), say('ok')];
    const s = buildStream([seg(0, a), seg(1, b, true)]);
    expect(s.messages.map((m) => m.text)).toEqual(['go', '', '', 'done', 'more', 'ok']);
    expect(s.hidden).toHaveLength(6);
    // Usage after a real compaction measured a different context: only the first segment fits the model.
    expect(s.fitRows).toBe(4);
  });
});

describe('replay (through this checkout\'s src)', () => {
  // 12 turns, each reading a fresh 4000-char file: ~48k result chars in all.
  const rows: EvalMessage[] = [prompt('start')];
  for (let i = 0; i < 12; i += 1) {
    rows.push(call(`u${i}`, 'Read', { file_path: `/srv/app/f${i}.ts` }));
    rows.push(result(`u${i}`, `${i}`.repeat(4000)));
    rows.push(call(`v${i}`, 'Read', { file_path: `/srv/app/f${i}.ts` }));
    rows.push(result(`v${i}`, `${i}`.repeat(4000)));
    rows.push(say(`turn ${i} done`));
    rows.push(prompt(`next ${i}`));
  }

  it('compacts more than once, carries the result forward, and never nests notes', async () => {
    const api = await loadPlugin();
    const report = await replay(api, { messages: rows, hidden: rows.map(() => 0) }, 'rules', {
      model: { overhead: 0, perVisibleChar: 1, perHiddenChar: 0 },
      window: 30_000,
      compactAt: 0.6,
      autoAt: 0.92,
      minReduction: 0.25,
      summaryTokens: 500,
      options: { preserveRecentMessages: 6, staleAfterMessages: 12 },
    });
    const passes = report.compactions.filter((c) => c.pass);
    expect(passes.length).toBeGreaterThanOrEqual(2);
    for (const c of passes) {
      expect(c.tokensAfter).toBeLessThan(c.tokensBefore);
      expect(c.idempotence.nested).toBe(0);
      // Only tier 2 cuts an earlier truncation further; a normal pass leaves it alone.
      if (c.tier === 1) expect(c.idempotence.reshrunk).toBe(0);
    }
    expect(passes[1]!.prior).toBe(true);
    expect(passes[1]!.idempotence.truncatedBefore).toBeGreaterThan(0);
  });

  it('falls back to a summary (context reset) when the gate fails', async () => {
    const api = await loadPlugin();
    const report = await replay(api, { messages: rows, hidden: rows.map(() => 0) }, 'rules', {
      model: { overhead: 0, perVisibleChar: 1, perHiddenChar: 0 },
      window: 30_000,
      compactAt: 0.6,
      autoAt: 0.92,
      minReduction: 0.95,
      summaryTokens: 500,
      options: { preserveRecentMessages: 6, staleAfterMessages: 12 },
    });
    expect(report.compactions[0]!.pass).toBe(false);
    expect(report.compactions[0]!.tokensAfter).toBeLessThan(report.compactions[0]!.tokensBefore / 2);
    expect(report.compactions[0]!.prior).toBe(false);
  });

  it('lets Claude Code\'s own auto-compact fire at most once per turn, and flags a context it could not bring down', async () => {
    const api = await loadPlugin();
    // Nothing prunable: every turn is text, so each compaction falls back, and a summary this large
    // leaves the context over the auto-compact point.
    const talk: EvalMessage[] = [prompt('start')];
    for (let i = 0; i < 6; i += 1) talk.push(say('z'.repeat(3000)), prompt(`q${i}`));
    const report = await replay(api, { messages: talk, hidden: talk.map(() => 0) }, 'rules', {
      model: { overhead: 0, perVisibleChar: 1, perHiddenChar: 0 },
      window: 10_000,
      compactAt: 0.6,
      autoAt: 0.92,
      minReduction: 0.25,
      summaryTokens: 9_500,
      options: {},
    });
    const turns = talk.filter((m) => m.role === 'assistant').length;
    expect(report.compactions.length).toBeLessThanOrEqual(turns);
    expect(report.compactions.some((c) => c.overflow)).toBe(true);
  });
});
