import { describe, expect, it } from 'vitest';
import { resolveHookConfig } from '../hooks/verbatim.ts';
import type { Message } from '../src/index.js';
import { harness, NEXT_RESULT } from './harness.ts';

const m = (role: Message['role'], text: string, extra: Partial<Message> = {}): Message => ({ role, text, toolUses: [], ...extra });

describe('resolveHookConfig (Stage 2a options)', () => {
  it('defaults the rule options and reads them from userConfig', () => {
    expect(resolveHookConfig({})).toMatchObject({
      truncateTailChars: 1000, staleAfterMessages: 100, pinReferenced: true, stripMcpFurniture: true,
    });
    expect(resolveHookConfig({ truncateTailChars: 500, staleAfterMessages: 30, pinReferenced: false, stripMcpFurniture: false }))
      .toMatchObject({ truncateTailChars: 500, staleAfterMessages: 30, pinReferenced: false, stripMcpFurniture: false });
    expect(resolveHookConfig({ pinReferenced: 'no' as never }).pinReferenced).toBe(true);
  });
});

describe('resolveHookConfig (teammate rows)', () => {
  it('defaults the teammate-row options on and reads them from userConfig', () => {
    expect(resolveHookConfig({})).toMatchObject({
      dedupeTeammates: true, trimStaleTeammates: true, dedupePeerNotice: true, teammateHeadChars: 1000, keepRecentUserTurns: 3,
    });
    expect(resolveHookConfig({ dedupeTeammates: false, trimStaleTeammates: false, dedupePeerNotice: false, teammateHeadChars: 50.5, keepRecentUserTurns: -2 }))
      .toMatchObject({ dedupeTeammates: false, trimStaleTeammates: false, dedupePeerNotice: false, teammateHeadChars: 50, keepRecentUserTurns: 0 });
  });

  it('names the teammate cut in the summary line, and the rebuilt rows reach the engine without a handle', async () => {
    const { summarize, compactSession } = await import('../hooks/verbatim.ts');
    const body = Array.from({ length: 40 }, (_, i) => `- finding ${i} explained at some length for the test`).join('\n');
    const idle = JSON.stringify({ type: 'idle_notification', from: 'a1', result: body.replace(/finding/g, 'restated') });
    const row = (inner: string) => `Another Claude session sent a message:\n<teammate-message teammate_id="a1">\n${inner}\n</teammate-message>`;
    const messages = [
      { ...m('user', 'Start.'), handle: 'h0' },
      { ...m('user', row(body)), handle: 'h1' },
      { ...m('user', row(idle)), handle: 'h2' },
      ...Array.from({ length: 8 }, (_, i) => ({ ...m(i % 2 ? 'user' : 'assistant', `turn ${i}`), handle: `t${i}` })),
    ];
    const { result, messages: out } = await compactSession(messages, resolveHookConfig({ useClaudeScorer: false }));
    expect(summarize(result)).toMatch(/teammate rows: 1 rebuilt, -\d+ chars \(1 restated, 0 repeated, 0 stale, 0 notices\)/);
    expect(out[1]).toBe(messages[1]);
    expect(out[2]!.handle).toBeUndefined();
  });
});

describe('the fallback gate', () => {
  // Two reads of one file: stale_read saves ~half of the tool-result bytes, but the user
  // text (attachments, reminders) is so large that it is under 25% of the whole transcript.
  const transcript = (): Message[] => [
    m('user', 'a'.repeat(40_000)),
    m('assistant', '', { toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'a.ts' } }] }),
    m('user', '', { toolResults: [{ tool_use_id: 'u1', text: 'z'.repeat(6000) }] }),
    m('assistant', '', { toolUses: [{ tool_use_id: 'u2', tool: 'Read', input: { file_path: 'a.ts' } }] }),
    m('user', '', { toolResults: [{ tool_use_id: 'u2', text: 'z'.repeat(6000) }] }),
    ...Array.from({ length: 6 }, (_, i) => m(i % 2 ? 'user' : 'assistant', `turn ${i}`)),
  ];

  it('judges the reduction against tool-result bytes, not the whole transcript', async () => {
    const h = harness({ userConfig: { useClaudeScorer: false } });
    const out = await h.compact({ trigger: 'auto', messages: transcript() });
    expect(out).not.toBe(NEXT_RESULT);
    expect((out as { messages: Message[] }).messages).toHaveLength(transcript().length);
  });

  it('still falls back when the result-byte reduction is under minReductionRatio', async () => {
    const h = harness({ userConfig: { useClaudeScorer: false, minReductionRatio: 0.6 } });
    expect(await h.compact({ trigger: 'auto', messages: transcript() })).toBe(NEXT_RESULT);
  });
});

describe('summarize', () => {
  it('names both denominators so the gate figure is not read as the transcript figure', async () => {
    const { summarize, compactSession } = await import('../hooks/verbatim.ts');
    const messages: Message[] = [
      m('user', 'a'.repeat(4000)),
      m('assistant', '', { toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'a.ts' } }] }),
      m('user', '', { toolResults: [{ tool_use_id: 'u1', text: 'z'.repeat(4000) }] }),
      m('assistant', '', { toolUses: [{ tool_use_id: 'u2', tool: 'Read', input: { file_path: 'a.ts' } }] }),
      m('user', '', { toolResults: [{ tool_use_id: 'u2', text: 'z'.repeat(4000) }] }),
      ...Array.from({ length: 6 }, (_, i) => m(i % 2 ? 'user' : 'assistant', `turn ${i}`)),
    ];
    const { result } = await compactSession(messages, resolveHookConfig({ useClaudeScorer: false }));
    expect(summarize(result)).toMatch(/^4\d% of tool output \(3\d% of transcript\); rules 1/);
  });
});

describe('sessionCwd', () => {
  it('reads $.session.cwd() and tolerates an engine without it or one that throws', async () => {
    const { sessionCwd } = await import('../hooks/verbatim.ts');
    expect(await sessionCwd({ session: { cwd: async () => '/w/opt' } } as never)).toBe('/w/opt');
    expect(await sessionCwd({ session: {} } as never)).toBeUndefined();
    expect(await sessionCwd({ session: { cwd: async () => { throw new Error('no'); } } } as never)).toBeUndefined();
  });
});
