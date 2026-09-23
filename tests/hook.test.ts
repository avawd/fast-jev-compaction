import { describe, expect, it } from 'vitest';
import { compactSession, resolveHookConfig, summarize, toSessionMessages } from '../hooks/verbatim.ts';
import type { Message } from '../src/index.js';

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
      truncateHeadChars: 300, maxCandidates: 400, useClaudeScorer: true,
    });
    expect(resolveHookConfig({ useClaudeScorer: false, maxCandidates: 50 })).toMatchObject({
      useClaudeScorer: false, maxCandidates: 50,
    });
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
