import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compact, makeScorer, TRUNCATION_NOTE_PREFIX,
  type Message, type Scorer, type ToolCall,
} from '../src/index.js';

const JIRA = readFileSync(new URL('./fixtures/jira-get-issue.json', import.meta.url), 'utf8');

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function use(id: string, tool: string, input: Record<string, unknown>, text = ''): Message {
  return msg('assistant', text, { toolUses: [{ tool_use_id: id, tool, input }] });
}
function res(id: string, text: string): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text }] });
}
const tail = (n: number): Message[] => Array.from({ length: n }, (_, i) => msg(i % 2 ? 'user' : 'assistant', 'ok'));
const rulesOnly = makeScorer({ useClaudeScorer: false, maxCandidates: 400 });
const resultText = (messages: readonly Message[], id: string) =>
  messages.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === id)?.text;

describe('compact with the Stage 2a rules', () => {
  it('annotates the calls the scorer sees with result text, age, staleness and ref-later counts', async () => {
    let seen: readonly ToolCall[] = [];
    const scorer: Scorer = async (calls) => { seen = calls; return { verdicts: new Map(), claude: 'skipped' }; };
    const messages = [
      msg('user', 'go'),
      use('u1', 'Bash', { command: 'git log' }), res('u1', 'a1b2c3d4e5 fix'),
      use('u2', 'Bash', { command: 'git show a1b2c3d4e5' }), res('u2', 'diff'),
      ...tail(8),
    ];
    await compact(messages, scorer, { staleAfterMessages: 5 });
    expect(seen[0]).toMatchObject({ resultText: 'a1b2c3d4e5 fix', age: 10, stale: true, refLater: 1, refTokens: ['a1b2c3d4e5'] });
    expect(seen[1]).toMatchObject({ resultText: 'diff', age: 8, refLater: 0 });
  });

  it('truncates a test run to head + tail so the verdict line survives', async () => {
    const log = `${'progress line\n'.repeat(400)} Tests  57 passed (57)\n`;
    const messages = [msg('user', 'go'), use('u1', 'Bash', { command: 'npm test' }), res('u1', log),
      ...tail(8)];
    const out = await compact(messages, async (calls) => ({
      verdicts: new Map([['t1', { action: 'drop_result', source: 'claude' }]]),
      claude: 'ran',
    }), {});
    const text = resultText(out.messages, 'u1')!;
    expect(text).toContain(TRUNCATION_NOTE_PREFIX);
    expect(text).toContain('Tests  57 passed (57)');
    expect(text.length).toBeLessThan(1600);
  });

  it('strips MCP furniture from kept results, and not when the option is off', async () => {
    const messages = [msg('user', 'go'), use('u1', 'mcp__r__getJiraIssue', { issueIdOrKey: 'EXA-4457' }), res('u1', JIRA), ...tail(8)];
    const on = await compact(messages, rulesOnly, {});
    expect(resultText(on.messages, 'u1')!.length).toBeLessThan(JIRA.length);
    expect(resultText(on.messages, 'u1')).toContain('"key":"EXA-4457"');
    expect(on.stats.charsAfter).toBeLessThan(on.stats.charsBefore);
    const off = await compact(messages, rulesOnly, { stripMcpFurniture: false });
    expect(off.messages).toEqual(messages);
    expect(off.messages[2]).toBe(messages[2]);
  });

  it('never drops a result whose introduced token is quoted later', async () => {
    const body = `${'x'.repeat(2000)} deadbeef1234 ${'y'.repeat(5000)}`;
    const messages = [msg('user', 'go'), use('u1', 'Bash', { command: './find.sh' }), res('u1', body),
      use('u2', 'Bash', { command: 'git show deadbeef1234' }), res('u2', 'ok'), ...tail(8)];
    const dropAll: Scorer = async (calls) => ({
      verdicts: new Map(calls.filter((c) => !c.pinned).map((c) => [c.id, { action: 'drop_call' as const, source: 'claude' as const }])),
      claude: 'ran',
    });
    const out = await compact(messages, dropAll, {});
    expect(resultText(out.messages, 'u1')).toBe(body);
    expect(out.decisions.find((d) => d.id === 't1')).toMatchObject({ action: 'keep', source: 'pinned' });
    const unpinned = await compact(messages, dropAll, { pinReferenced: false });
    expect(resultText(unpinned.messages, 'u1')).toBeUndefined();
  });
});
