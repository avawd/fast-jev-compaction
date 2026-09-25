import { describe, expect, it } from 'vitest';
import { categorize, categoryDelta, categoryRows, classifyUserText, duplicateUserChars, duplicateUserCharsByCategory, TOKENS_PER_CHAR } from './categories.ts';
import type { EvalMessage } from './parse.ts';

const user = (text: string): EvalMessage => ({ role: 'user', text, toolUses: [] });
const assistant = (text: string, toolUses: EvalMessage['toolUses'] = []): EvalMessage => ({ role: 'assistant', text, toolUses });
const results = (...texts: string[]): EvalMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: texts.map((t, i) => ({ tool_use_id: `r${i}`, text: t })),
});

describe('classifyUserText', () => {
  it('splits a teammate row into content, idle notifications and boilerplate', () => {
    const idle = '<teammate-message teammate_id="a" color="red">\n{"type":"idle_notification","from":"a"}\n</teammate-message>';
    const body = '<teammate-message teammate_id="b" summary="done">\nreport body\n</teammate-message>';
    const text = `Another Claude session sent a message:\n${idle}\n\n${body}\n\nThis came from another Claude session.`;
    const parts = classifyUserText(text);
    expect(parts['user:idle']).toBe(idle.length);
    expect(parts['user:teammate']).toBe(body.length);
    expect(parts['user:boilerplate']).toBeGreaterThan(0);
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    expect(total).toBe(text.length);
  });

  it('recognises reminders, task notifications, command rows and summaries', () => {
    expect(classifyUserText('<system-reminder>x</system-reminder>')['user:reminder']).toBe(36);
    expect(classifyUserText('<task-notification>\n<task-id>1</task-id>\n</task-notification>')['user:task']).toBeGreaterThan(0);
    expect(classifyUserText('<command-name>/clear</command-name>')['user:command']).toBe(35);
    expect(classifyUserText('<local-command-stdout>ok</local-command-stdout>')['user:command']).toBeGreaterThan(0);
    expect(classifyUserText('This session is being continued from a previous conversation. Summary...')['user:summary']).toBeGreaterThan(0);
    expect(classifyUserText('please fix the bug')).toEqual({ 'user:typed': 18 });
  });

  it('counts an agent-message block as teammate content', () => {
    const t = '<agent-message from="x">\nhello\n</agent-message>';
    expect(classifyUserText(t)['user:teammate']).toBe(t.length);
  });

  it('keeps typed text that surrounds a reminder', () => {
    const parts = classifyUserText('do it\n<system-reminder>r</system-reminder>');
    expect(parts['user:typed']).toBe(6);
    expect(parts['user:reminder']).toBe(36);
  });
});

describe('categorize', () => {
  it('attributes every hook-visible char to one category', () => {
    const msgs: EvalMessage[] = [
      user('hello'),
      assistant('thinking aloud', [
        { tool_use_id: 'r0', tool: 'Bash', input: { command: 'ls' } },
        { tool_use_id: 'r1', tool: 'SendMessage', input: { to: 'x', message: 'hi' } },
        { tool_use_id: 'r2', tool: 'mcp__foo__bar', input: {} },
        { tool_use_id: 'r3', tool: 'Task', input: { prompt: 'p' } },
      ]),
      results('out', 'sent', '', 'agent said'),
    ];
    const c = categorize(msgs);
    expect(c['user:typed']).toBe(5);
    expect(c['assistant_text']).toBe(14);
    expect(c['input:Bash']).toBe(JSON.stringify({ command: 'ls' }).length);
    expect(c['input:SendMessage']).toBe(JSON.stringify({ to: 'x', message: 'hi' }).length);
    expect(c['input:other']).toBe(2);
    expect(c['input:Agent']).toBe(JSON.stringify({ prompt: 'p' }).length);
    expect(c['tool_result']).toBe(3 + 4 + 0 + 10);
  });

  it('delta reports removed chars per category, never negative keys dropped', () => {
    const before = categorize([user('aaaa'), results('xxxxxxxx')]);
    const after = categorize([user('aaaa'), results('xx')]);
    const d = categoryDelta(before, after);
    expect(d['tool_result']).toBe(6);
    expect(d['user:typed']).toBe(0);
  });
});

describe('duplicateUserChars', () => {
  it('counts teammate lines that repeat text already in context', () => {
    const line = 'HIGH | lib/foo.ts:12 | a finding that is long enough to count here';
    const msgs: EvalMessage[] = [
      assistant('', [{ tool_use_id: 'r0', tool: 'Agent', input: { prompt: 'go' } }]),
      results(`report\n${line}\nend`),
      user(`<teammate-message teammate_id="a">\n${line}\nshort\n</teammate-message>`),
    ];
    expect(duplicateUserChars(msgs)).toBe(line.length);
  });

  it('files a repeated lead-in around teammate blocks as boilerplate, not typed', () => {
    const lead = 'This came from another Claude session, not typed by your user, and more words';
    const row = `<teammate-message teammate_id="a">\nok\n</teammate-message>\n${lead}`;
    expect(duplicateUserCharsByCategory([user(row), user(row)])).toEqual({ 'user:boilerplate': lead.length });
  });

  it('reads an idle notification\'s JSON result, so an escaped repeat of a report still counts', () => {
    const line = 'HIGH | lib/foo.ts:12 | a finding that is long enough to count here';
    const report = `<teammate-message teammate_id="a" summary="s">\nsummary\n${line}\n</teammate-message>`;
    const idleJson = JSON.stringify({ type: 'idle_notification', from: 'a', result: `intro\n${line}` });
    const idle = `<teammate-message teammate_id="a">\n${idleJson}\n</teammate-message>`;
    expect(duplicateUserCharsByCategory([user(report), user(idle)])).toEqual({ 'user:idle': line.length });
  });

  it('counts a repeated line only once it has been seen', () => {
    const line = 'x'.repeat(50);
    const msgs = [user(`<teammate-message teammate_id="a">\n${line}\n</teammate-message>`), user(`<teammate-message teammate_id="a">\n${line}\n</teammate-message>`)];
    expect(duplicateUserChars(msgs)).toBe(50);
  });
});

describe('categoryRows', () => {
  it('lists every category with its size, share and what each arm removed', () => {
    const before = { tool_result: 1000, 'input:Bash': 500, 'user:idle': 0, assistant_text: 100 };
    const rows = categoryRows(before, { rules: { tool_result: 400, 'input:Bash': 0, assistant_text: 0 }, trunc: { tool_result: 900, 'input:Bash': 50, assistant_text: 0 } });
    expect(rows.map((r) => r.category)).toEqual(['tool_result', 'input:Bash', 'assistant_text', 'total']);
    const tr = rows[0]!;
    expect(tr.chars).toBe(1000);
    expect(tr.sharePct).toBeCloseTo(62.5, 1);
    expect(tr.removed).toEqual({ rules: 400, trunc: 900 });
    expect(tr.removedPct).toEqual({ rules: 40, trunc: 90 });
    expect(tr.estTokens).toBe(Math.round(1000 * TOKENS_PER_CHAR['tool_result']!));
    const total = rows.at(-1)!;
    expect(total.chars).toBe(1600);
    expect(total.removed).toEqual({ rules: 400, trunc: 950 });
  });
});
