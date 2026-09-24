import { describe, expect, it } from 'vitest';
import { parseDebugLog, parseStream, scoreAnswer } from './live-summary.ts';

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

describe('scoreAnswer', () => {
  it('matches expected tokens case-insensitively', () => {
    expect(scoreAnswer('merged as #922 (FE09588)', ['922', 'fe09588', 'ABC-4534'])).toEqual({ hit: ['922', 'fe09588'], miss: ['ABC-4534'] });
  });
});
