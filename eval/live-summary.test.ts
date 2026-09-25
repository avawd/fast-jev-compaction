import { describe, expect, it } from 'vitest';
import { parseDebugLog, parseStream, realCtx, scoreAnswer, scoreRecall } from './live-summary.ts';

// Lines in the shape 2.1.281 writes them (copied from a validation run's debug log, paths generic).
const LOG = [
  '2026-09-24T16:09:32.139Z [DEBUG] Read hooks.json for plugin verbatim-compaction (enabled=true): /w/fjc/hooks/hooks.json',
  '2026-09-24T16:09:32.204Z [DEBUG] Read hooks.json for plugin verbatim-compaction (enabled=false; will NOT register, plugin is disabled): /g/fjc/hooks/hooks.json',
  '2026-09-24T16:10:40.800Z [DEBUG] [API REQUEST] /v1/messages x-client-request-id=abc source=hook_prompt',
  '2026-09-24T16:10:49.000Z [DEBUG] $.model.fork (verbatim-compaction): 8269ms, 1 replies',
  '2026-09-24T16:10:46.802Z [DEBUG] [verbatim-compaction] $.ui.log: fallback to built-in summary (below 25%: 0% reduction; rules 1, claude 0 (timeout), kept 148, pinned 1; 1 truncated, 0 dropped)',
  '2026-09-24T16:12:39.978Z [DEBUG] hooks module verbatim-compaction@inline session.compact settled in 119202.4ms (worker hop, next() included)',
].join('\n');

describe('parseDebugLog', () => {
  it('reads which copy loaded, the forks and the outcome', () => {
    const f = parseDebugLog(LOG);
    expect(f.pluginLoads).toEqual([{ enabled: true, hooksJson: '/w/fjc/hooks/hooks.json' }]);
    expect(f.forks.map((x) => x.ms)).toEqual([8269]);
    expect(f.forkRequests).toBe(1);
    expect(f.claudeStatus).toBe('timeout');
    expect(f.outcome?.startsWith('fallback')).toBe(true);
    expect(f.hookAnswered).toBe(false);
    expect(f.hookSettledMs).toBe(119202.4);
  });

  it('parses a verbatim outcome', () => {
    const f = parseDebugLog(
      "x [DEBUG] [verbatim-compaction] $.ui.log: kept 259/417 messages, no summary (68% reduction; rules 1, claude 116 (ran), kept 15, pinned 2; 38 truncated, 79 dropped)\n" +
        "x [DEBUG] session.compact (manual): a hook's 259 messages stand (hooked by verbatim-compaction); core never ran",
    );
    expect([f.kept, f.total, f.reductionPct, f.claudeStatus, f.hookAnswered]).toEqual([259, 417, 68, 'ran', true]);
  });
});

describe('parseStream', () => {
  it('skips /compact’s own result and collects the recall answers after the boundary', () => {
    const lines = [
      { type: 'result', result: 'ok', session_id: 's1' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 100, post_tokens: 10 } },
      { type: 'result', result: '', num_turns: 0 },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Set 1 ...' }] } },
      { type: 'result', result: 'Set 1: 922 Set 2: unknown' },
    ].map((o) => JSON.stringify(o));
    const s = parseStream(lines.join('\n'));
    expect(s).toMatchObject({ sessionId: 's1', preTokens: 100, postTokens: 10, answers: ['Set 1: 922 Set 2: unknown'], recallToolUses: [] });
  });
});

describe('real context from API usage', () => {
  const usage = (input: number, read: number, create: number) => ({ input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: create, output_tokens: 5 });
  it('takes the last request before the boundary and the first one after it', () => {
    const lines = [
      { type: 'assistant', message: { id: 'm0', usage: usage(1, 100, 10), content: [] } },
      { type: 'assistant', message: { id: 'm1', usage: usage(2, 200_000, 66_000), content: [{ type: 'text', text: 'ok' }] } },
      { type: 'result', result: 'ok', session_id: 's1' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 100, post_tokens: 10 } },
      { type: 'result', result: '', num_turns: 0 },
      { type: 'assistant', message: { id: 'm2', usage: usage(3, 0, 231_000), content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', message: { id: 'm3', usage: usage(4, 231_000, 900), content: [{ type: 'text', text: 'b' }] } },
      { type: 'result', result: 'a b' },
    ].map((o) => JSON.stringify(o));
    const s = parseStream(lines.join('\n'));
    expect(s.realBefore).toBe(266_002);
    expect(s.realAfter).toBe(231_003);
  });

  it('ignores zero-usage and synthetic messages', () => {
    const lines = [
      { type: 'assistant', message: { id: 'm1', usage: usage(1, 10, 0), content: [] } },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: {} },
      { type: 'assistant', message: { id: 'x', model: '<synthetic>', usage: usage(0, 0, 0), content: [] } },
      { type: 'assistant', message: { id: 'm2', usage: usage(5, 0, 0), content: [] } },
    ].map((o) => JSON.stringify(o));
    const s = parseStream(lines.join('\n'));
    expect([s.realBefore, s.realAfter]).toEqual([11, 5]);
  });
});

describe('realCtx', () => {
  it('prints before→after with the relative change', () => {
    expect(realCtx(266_000, 231_000)).toBe('266k→231k (-13%)');
    expect(realCtx(undefined, 5)).toBe('-→5');
  });
});

describe('scoreAnswer', () => {
  it('matches expected tokens case-insensitively', () => {
    expect(scoreAnswer('merged as #922 (FE09588)', ['922', 'fe09588', 'ABC-4534'])).toEqual({ hit: ['922', 'fe09588'], miss: ['ABC-4534'] });
  });
});

describe('fork api errors', () => {
  it('counts fork lines that report an API error', () => {
    const f = parseDebugLog(
      'x [DEBUG] $.model.fork (verbatim-compaction): 812ms, 0 replies, API error no status\n' +
        'x [DEBUG] $.model.fork (verbatim-compaction): 5100ms, 1 replies',
    );
    expect(f.forks).toHaveLength(2);
    expect(f.forkApiErrors).toBe(1);
  });
});

describe('scoreRecall', () => {
  const sets = [{ name: 'hard', question: 'q', expected: ['abc1234', '456'] }];
  it('scores every set against all answers', () => {
    expect(scoreRecall(['abc1234 and 456'], sets, [])).toEqual([{ set: 'hard', hit: ['abc1234', '456'], miss: [], failed: false, answer: 'abc1234 and 456' }]);
  });
  it('fails a recall that used a tool, whatever the answer says', () => {
    expect(scoreRecall(['abc1234 and 456'], sets, ['Bash'])).toEqual([
      { set: 'hard', hit: [], miss: ['abc1234', '456'], failed: true, answer: 'abc1234 and 456' },
    ]);
  });
});

describe('outcome wording', () => {
  it('reads the reduction from the tool-output wording too', () => {
    const f = parseDebugLog('x [DEBUG] [verbatim-compaction] $.ui.log: kept 634/634 messages, no summary (59% of tool output (26% of transcript); rules 32, claude 70 (ran 10.4s), kept 3)');
    expect([f.kept, f.total, f.reductionPct, f.claudeStatus]).toEqual([634, 634, 59, 'ran 10.4s']);
  });
});
