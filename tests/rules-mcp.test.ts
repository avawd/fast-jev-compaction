import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isMcpWriteTool,
  mcpWriteEcho,
  stripMcpFurniture,
  stripFurnitureInMessages,
  type Message,
  type ToolCall,
} from '../src/index.js';

const JIRA = readFileSync(new URL('./fixtures/jira-get-issue.json', import.meta.url), 'utf8');

function call(tool: string, extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 't1', tool_use_id: 'u1', tool, input: {}, callIndex: 1, resultIndex: 2,
    resultChars: 1000, isError: false, pinned: false, ...extra,
  };
}

/** Every leaf value reachable from `value`, as `path=value` strings. */
function leaves(value: unknown, path = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${path}.${k}`));
  }
  return [`${path}=${JSON.stringify(value)}`];
}

describe('isMcpWriteTool', () => {
  it('matches MCP tools whose name carries a write verb as a whole word', () => {
    expect(isMcpWriteTool('mcp__claude_ai_Atlassian_Rovo__createJiraIssue')).toBe(true);
    expect(isMcpWriteTool('mcp__claude_ai_Atlassian_Rovo__editJiraIssue')).toBe(true);
    expect(isMcpWriteTool('mcp__claude_ai_Atlassian_Rovo__transitionJiraIssue')).toBe(true);
    expect(isMcpWriteTool('mcp__claude_ai_Atlassian_Rovo__addCommentToJiraIssue')).toBe(true);
    expect(isMcpWriteTool('mcp__claude_ai_Slack__slack_add_reaction')).toBe(true);
    expect(isMcpWriteTool('mcp__x__updateConfluencePage')).toBe(true);
  });

  it('does not match reads, even ones that mention comments', () => {
    expect(isMcpWriteTool('mcp__claude_ai_Atlassian_Rovo__getJiraIssue')).toBe(false);
    expect(isMcpWriteTool('mcp__claude_ai_Atlassian_Rovo__getConfluencePageFooterComments')).toBe(false);
    expect(isMcpWriteTool('mcp__claude_ai_Slack__slack_read_thread')).toBe(false);
    expect(isMcpWriteTool('Edit')).toBe(false);
    expect(isMcpWriteTool('mcp__address_book__lookup')).toBe(false);
  });
});

describe('mcpWriteEcho', () => {
  it('truncates a large successful MCP write echo', () => {
    expect(mcpWriteEcho(call('mcp__r__createJiraIssue', { resultChars: 5000 }))).toEqual({
      action: 'drop_result', source: 'rule', rule: 'mcp_write_echo',
    });
  });

  it('leaves small echoes, errors, pinned calls and reads alone', () => {
    expect(mcpWriteEcho(call('mcp__r__createJiraIssue', { resultChars: 500 }))).toBeUndefined();
    expect(mcpWriteEcho(call('mcp__r__createJiraIssue', { resultChars: 5000, isError: true }))).toBeUndefined();
    expect(mcpWriteEcho(call('mcp__r__createJiraIssue', { resultChars: 5000, pinned: true }))).toBeUndefined();
    expect(mcpWriteEcho(call('mcp__r__getJiraIssue', { resultChars: 5000 }))).toBeUndefined();
  });
});

describe('stripMcpFurniture', () => {
  it('shrinks a recorded Jira payload substantially', () => {
    const out = stripMcpFurniture(JIRA);
    expect(out.length).toBeLessThan(JIRA.length * 0.6);
  });

  it('is lossless for every business field of the recorded Jira payload', () => {
    const before = leaves(JSON.parse(JIRA));
    const after = new Set(leaves(JSON.parse(stripMcpFurniture(JIRA))));
    const furniture = /\.(self|expand|iconUrl)=|\.avatarUrls\.|\.featureFlags\.|^\.context\.|\.customfield_\d+=null$/;
    const lost = before.filter((leaf) => !after.has(leaf) && !furniture.test(leaf));
    expect(lost).toEqual([]);
    expect(after.has('.issues.nodes[0].key="EXA-4457"')).toBe(true);
    expect(after.has('.issues.nodes[0].fields.customfield_10002="Team Alpha"')).toBe(true);
    expect(after.has('.issues.nodes[0].webUrl="https://example.atlassian.net/browse/EXA-4457"')).toBe(true);
  });

  it('removes the furniture keys it names', () => {
    const out = stripMcpFurniture(JIRA);
    expect(out).not.toMatch(/"(self|avatarUrls|expand|featureFlags|iconUrl)":/);
    expect(out).not.toContain('"customfield_10001"');
    expect(out).not.toContain('invocationId');
  });

  it('keeps a `context` key that is not an MCP envelope', () => {
    const text = JSON.stringify({ context: { note: 'business' }, pad: 'x'.repeat(600) });
    expect(stripMcpFurniture(text)).toBe(text);
  });

  it('refuses a payload whose integers JSON cannot carry exactly', () => {
    const text = `{"id":12345678901234567890,"self":"https://x/1","pad":"${'z'.repeat(600)}"}`;
    expect(stripMcpFurniture(text)).toBe(text);
  });

  it('keeps a `__proto__` key as data rather than setting the prototype', () => {
    const text = `{"__proto__":{"k":"v"},"self":"https://x/1","pad":"${'z'.repeat(600)}"}`;
    const out = stripMcpFurniture(text);
    expect(out).toContain('"__proto__":{"k":"v"}');
    expect(out).not.toContain('"self"');
  });

  it('returns non-JSON and furniture-free text unchanged (same string)', () => {
    const prose = `Created issue ${'x'.repeat(600)}`;
    expect(stripMcpFurniture(prose)).toBe(prose);
    const clean = JSON.stringify({ key: 'A-1', pad: 'y'.repeat(600) });
    expect(stripMcpFurniture(clean)).toBe(clean);
  });
});

describe('stripFurnitureInMessages', () => {
  const messages: Message[] = [
    { role: 'user', text: 'start', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'mcp__r__getJiraIssue', input: {} }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: JIRA }] },
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u2', tool: 'Bash', input: { command: 'x' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u2', text: JIRA }] },
  ];

  it('rewrites unpinned MCP results only and leaves other messages as the same objects', () => {
    const calls = [
      call('mcp__r__getJiraIssue', { id: 't1', tool_use_id: 'u1', callIndex: 1, resultIndex: 2, resultChars: JIRA.length }),
      call('Bash', { id: 't2', tool_use_id: 'u2', callIndex: 3, resultIndex: 4, resultChars: JIRA.length }),
    ];
    const out = stripFurnitureInMessages(messages, calls);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
    expect(out[2]).not.toBe(messages[2]);
    expect(out[2]!.toolResults![0]!.text.length).toBeLessThan(JIRA.length);
    expect(out[4]).toBe(messages[4]);
    expect(messages[2]!.toolResults![0]!.text).toBe(JIRA);
  });

  it('never rewrites a pinned MCP result', () => {
    const calls = [call('mcp__r__getJiraIssue', { tool_use_id: 'u1', resultChars: JIRA.length, pinned: true })];
    expect(stripFurnitureInMessages(messages, calls)).toEqual(messages);
    expect(stripFurnitureInMessages(messages, calls)[2]).toBe(messages[2]);
  });

  it('skips a result whose later-referenced tokens the strip would remove', () => {
    const calls = [call('mcp__r__getJiraIssue', {
      tool_use_id: 'u1', resultChars: JIRA.length,
      refTokens: ['https://api.atlassian.com/ex/jira/00000000-0000-4000-8000-000000000000/rest/api/3/issue/100001'],
    })];
    expect(stripFurnitureInMessages(messages, calls)[2]).toBe(messages[2]);
  });
});

describe('isMcpWriteTool: the verb must lead the tool name (F9)', () => {
  it('rejects reads that merely contain a write word', () => {
    for (const t of ['mcp__jira__getComment', 'mcp__jira__getCommentsForIssue', 'mcp__x__read_comment',
      'mcp__x__comment_search', 'mcp__gh__get_pull_request_comments', 'mcp__x__list_recent_updates',
      'mcp__x__search_updated', 'mcp__x__getIssueComment', 'mcp__x__addTeamworkGraphContext']) {
      expect(isMcpWriteTool(t), t).toBe(false);
    }
  });

  it('still accepts writes, including a server-named prefix like slack_', () => {
    for (const t of ['mcp__x__transitionJiraIssue', 'mcp__x__addWorklogToJiraIssue', 'mcp__x__editJiraIssue',
      'mcp__claude_ai_Slack__slack_add_reaction', 'mcp__x__commentOnIssue', 'mcp__x__update_page']) {
      expect(isMcpWriteTool(t), t).toBe(true);
    }
  });
});

describe('stripMcpFurniture: numbers and self (F10)', () => {
  const pad = `"pad":"${'p'.repeat(40)}"`;
  it('refuses when re-serialising would change any number literal', () => {
    for (const lit of ['1e400', '1.0', '-0', '0.1000000000000000055511151231257827', '1E5', '12345678901234567890']) {
      const text = `{"v":${lit},"self":"https://x/1",${pad}}`;
      expect(stripMcpFurniture(text), lit).toBe(text);
    }
  });

  it('does not mistake digits inside strings for number literals', () => {
    const text = `{"v":"1.0 and -0","n":12,"self":"https://x/1",${pad}}`;
    expect(stripMcpFurniture(text)).toBe(`{"v":"1.0 and -0","n":12,${pad}}`);
  });

  it('strips self only when it is a URL', () => {
    const flag = `{"reaction":{"self":true,"name":"+1"},${pad}}`;
    expect(stripMcpFurniture(flag)).toBe(flag);
    expect(stripMcpFurniture(`{"self":"http://x/1","a":1,${pad}}`)).toBe(`{"a":1,${pad}}`);
  });
});
