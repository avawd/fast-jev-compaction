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
    const dropAll: Scorer = async (calls) => ({
      verdicts: new Map(calls.filter((c) => !c.pinned).map((c) => [c.id, { action: 'drop_call' as const, source: 'claude' as const }])),
      claude: 'ran',
    });
    const run = async (body: string, options = {}) => {
      const messages = [msg('user', 'go'), use('u1', 'Bash', { command: './find.sh' }, 'Looking.'), res('u1', body),
        use('u2', 'Bash', { command: 'git show deadbeef1234' }, 'Showing.'), res('u2', 'ok'), ...tail(8)];
      return compact(messages, dropAll, options);
    };
    // Within reach: truncated to a head that ends at the token.
    const near = `${'x'.repeat(2000)} deadbeef1234 ${'y'.repeat(5000)}`;
    const reached = await run(near);
    expect(resultText(reached.messages, 'u1')).toContain('deadbeef1234');
    expect(resultText(reached.messages, 'u1')!.length).toBeLessThan(2200);
    expect(reached.decisions.find((d) => d.id === 't1')).toMatchObject({ action: 'drop_result', headChars: 2013 });
    // Out of reach (past MAX_PINNED_HEAD and the tail): the head plus a window around the token.
    const far = `${'x'.repeat(6000)} deadbeef1234 ${'y'.repeat(5000)}`;
    const excerpted = await run(far);
    const text = resultText(excerpted.messages, 'u1')!;
    expect(text).toContain(' deadbeef1234 ');
    expect(text.startsWith('x'.repeat(300))).toBe(true);
    expect(text).toContain(TRUNCATION_NOTE_PREFIX);
    expect(text).toMatch(/\[… 5501 chars omitted …\]/);
    expect(text.length).toBeLessThan(1000);
    expect(excerpted.decisions.find((d) => d.id === 't1')).toMatchObject({ action: 'drop_result', windows: [[5801, 6213]] });
    // Too many far tokens to excerpt within the cap: kept verbatim.
    const many = Array.from({ length: 30 }, (_, k) => `${'x'.repeat(1000)} deadbeef${String(k).padStart(4, '0')} `).join('');
    const quoting = [msg('user', 'go'), use('u1', 'Bash', { command: './find.sh' }, 'Looking.'), res('u1', many),
      use('u2', 'Bash', { command: 'echo ' + Array.from({ length: 30 }, (_, k) => `deadbeef${String(k).padStart(4, '0')}`).join(' ') }, 'Showing.'),
      res('u2', 'ok'), ...tail(8)];
    const kept = await compact(quoting, dropAll, {});
    expect(resultText(kept.messages, 'u1')).toBe(many);
    expect(kept.decisions.find((d) => d.id === 't1')).toMatchObject({ action: 'keep', source: 'pinned' });
    // Pin off: the call goes, token and all.
    expect(resultText((await run(near, { pinReferenced: false })).messages, 'u1')).toBeUndefined();
  });
});

describe('compact passes the session cwd to the rules (F2)', () => {
  it('annotates every call with options.cwd so Bash paths resolve against it', async () => {
    let seen: readonly ToolCall[] = [];
    const scorer: Scorer = async (calls) => { seen = calls; return { verdicts: new Map(), claude: 'skipped' }; };
    const messages = [msg('user', 'go'), use('u1', 'Bash', { command: 'cat src/a.ts' }), res('u1', 'x'), ...tail(8)];
    await compact(messages, scorer, { cwd: '/w/opt' });
    expect(seen[0]!.cwd).toBe('/w/opt');
    await compact(messages, scorer, {});
    expect(seen[0]!.cwd).toBeUndefined();
    await compact(messages, scorer, { cwd: 'relative/dir' });
    expect(seen[0]!.cwd).toBeUndefined();
  });

  it('keeps a Bash read of one worktree when only another worktree\'s copy is re-read', async () => {
    const messages = [msg('user', 'go'),
      use('u1', 'Bash', { command: 'cat src/compact.ts' }, 'Reading.'), res('u1', 'y'.repeat(4000)),
      use('u2', 'Read', { file_path: '/elsewhere/src/compact.ts' }, 'Reading.'), res('u2', 'z'.repeat(4000)),
      ...tail(8)];
    const out = await compact(messages, rulesOnly, { cwd: '/w/opt' });
    expect(out.decisions.find((d) => d.id === 't1')?.rule).toBeUndefined();
    const same = await compact(messages.map((m) => m.toolUses[0]?.tool === 'Read'
      ? { ...m, toolUses: [{ ...m.toolUses[0]!, input: { file_path: '/w/opt/src/compact.ts' } }] } : m), rulesOnly, { cwd: '/w/opt' });
    expect(same.decisions.find((d) => d.id === 't1')?.rule).toBe('bash_read_superseded');
  });
});
