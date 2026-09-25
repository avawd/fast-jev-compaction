import { describe, expect, it } from 'vitest';
import { compact, compactUserRows, protectRows, resolveOptions, riderProtected, riderProtectedIds, type ApiLike, type Message, type Scorer } from '../src/index.js';

const reminder = (inner: string) => ({ type: 'text', text: `<system-reminder>\n${inner}\n</system-reminder>` });
const result = (id: string, content = 'out') => ({ type: 'tool_result', tool_use_id: id, content });
const user = (...content: Array<Record<string, unknown>>): ApiLike => ({ role: 'user', content });
const asst = (...ids: string[]): ApiLike => ({ role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: {} })) });

describe('riderProtectedIds', () => {
  it('protects a result followed by a prompt the user typed while the tool ran', () => {
    const api = [user({ type: 'text', text: 'go' }), asst('a'), user(result('a'), reminder('The user sent a new message while you were working:\nQUEUED'))];
    expect([...riderProtectedIds(api, [])]).toEqual(['a']);
  });

  it('ignores ephemeral reminders: token counts, hook context, task and todo nags', () => {
    const api = [
      asst('a', 'b'),
      user(
        result('a'),
        reminder('<total_tokens>123 tokens left</total_tokens>'),
        reminder('PostToolUse:Bash hook additional context: verify results'),
        reminder('SessionStart hook success: caveman'),
        reminder("The task tools haven't been used recently. ..."),
        reminder("The TodoWrite tool hasn't been used recently. ..."),
        result('b'),
      ),
    ];
    expect(riderProtectedIds(api, []).size).toBe(0);
  });

  it('protects every result of a message a sibling rider follows: the normalizer hoists results to the front', () => {
    const api = [asst('a', 'b'), user(result('a'), result('b'), { type: 'text', text: '<task-notification>done</task-notification>' })];
    expect([...riderProtectedIds(api, [])].sort()).toEqual(['a', 'b']);
  });

  it('protects a result whose content has a rider folded into it', () => {
    const rows: Message[] = [{ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: 'out' }] }];
    const folded = [asst('a'), user(result('a', `out\n${reminder('The user sent a new message while you were working:\nQ').text}`))];
    expect([...riderProtectedIds(folded, rows)]).toEqual(['a']);
    const blocks = [asst('a'), user(result('a', [{ type: 'text', text: 'out' }, reminder('The user sent a new message while you were working:\nQ')] as never))];
    expect([...riderProtectedIds(blocks, rows)]).toEqual(['a']);
    const ephemeral = [asst('a'), user(result('a', `out\n${reminder('<total_tokens>5 left</total_tokens>').text}`))];
    expect(riderProtectedIds(ephemeral, rows).size).toBe(0);
    const plain = [asst('a'), user(result('a', 'out'))];
    expect(riderProtectedIds(plain, rows).size).toBe(0);
  });

  it('judges a block holding several reminders by all of them, and by any text outside them', () => {
    const two = { type: 'text', text: `${reminder('<total_tokens>5 left</total_tokens>').text}\n${reminder('The user sent a new message while you were working:\nQ').text}` };
    expect([...riderProtectedIds([asst('a'), user(result('a'), two)], [])]).toEqual(['a']);
    const outside = { type: 'text', text: `${reminder('<total_tokens>5 left</total_tokens>').text}\nplain words` };
    expect([...riderProtectedIds([asst('a'), user(result('a'), outside)], [])]).toEqual(['a']);
    const both = { type: 'text', text: `${reminder('<total_tokens>5 left</total_tokens>').text}\n${reminder('SessionStart hook success: x').text}` };
    expect(riderProtectedIds([asst('a'), user(result('a'), both)], []).size).toBe(0);
  });

  it('recognises the next typed prompt with a trailing newline the merge added', () => {
    const rows: Message[] = [{ role: 'user', text: 'next typed prompt', toolUses: [] }];
    const api = [asst('a'), user(result('a'), { type: 'text', text: 'next typed prompt\n' }, reminder('instructions for the prompt'))];
    expect(riderProtectedIds(api, rows).size).toBe(0);
  });

  it('does not count the next typed prompt (a row of its own) as a rider, nor what follows it', () => {
    const rows: Message[] = [{ role: 'user', text: 'next typed prompt', toolUses: [] }];
    const api = [asst('a'), user(result('a'), { type: 'text', text: 'next typed prompt' }, reminder('instructions for the prompt'))];
    expect(riderProtectedIds(api, rows).size).toBe(0);
  });

  it('protects on an unknown non-ephemeral reminder (safe side)', () => {
    const api = [asst('a'), user(result('a'), reminder('Contents of /x/CLAUDE.md: ...'))];
    expect([...riderProtectedIds(api, [])]).toEqual(['a']);
  });

  it('protects on an image or document block after a result', () => {
    const api = [asst('a'), user(result('a'), { type: 'image', source: {} })];
    expect([...riderProtectedIds(api, [])]).toEqual(['a']);
  });
});

describe('riderProtected: user text rows', () => {
  const tm = 'Another Claude session sent a message:\n<teammate-message teammate_id="a1" color="blue">\nreport\n</teammate-message>';
  const rows: Message[] = [{ role: 'user', text: 'Start.', toolUses: [] }, { role: 'user', text: tm, toolUses: [] }];

  it('protects a teammate row a prompt typed right after it rides on', () => {
    const api = [user({ type: 'text', text: 'Start.' }), user({ type: 'text', text: tm }, reminder('The user sent a new message while you were working:\nTYPED'))];
    const out = riderProtected(api, rows);
    expect([...out.rows]).toEqual([rows[1]]);
    expect(out.callIds.size).toBe(0);
  });

  it('leaves it unprotected when only its prompt-submit hook context follows', () => {
    const api = [user({ type: 'text', text: tm }, reminder('UserPromptSubmit hook additional context: caveman'))];
    expect(riderProtected(api, rows).rows.size).toBe(0);
  });

  it('the teammate pass returns a protected row as the input object', () => {
    const body = Array.from({ length: 80 }, (_, i) => `- line ${i} of a long stale report, long enough to cut`).join('\n');
    const old: Message = { role: 'user', text: tm.replace('report', body), toolUses: [] };
    const input = [rows[0]!, old, ...Array.from({ length: 30 }, (_, i): Message => ({ role: i % 2 ? 'user' : 'assistant', text: `f${i}`, toolUses: [] }))];
    const o = resolveOptions({ preserveRecentMessages: 2, staleAfterMessages: 2 });
    expect(compactUserRows(input, o).messages[1]).not.toBe(old);
    expect(compactUserRows(input, o, new Set([old])).messages[1]).toBe(old);
  });
});

describe('protectRows', () => {
  it('grows the set to every call sharing a row, transitively', () => {
    const rows: Message[] = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: {} }, { tool_use_id: 'b', tool: 'Bash', input: {} }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b', text: '' }, { tool_use_id: 'c', text: '' }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'd', text: '' }] },
    ];
    expect([...protectRows(rows, ['a'])].sort()).toEqual(['a', 'b', 'c']);
    expect([...protectRows(rows, [])]).toEqual([]);
  });
});

describe('compact() with protected results', () => {
  it('keeps a protected result and its call whole, however stale', async () => {
    const big = 'x'.repeat(5000);
    const input: Message[] = [
      { role: 'user', text: 'Start.', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'ls' } }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'a', text: big }] },
      ...Array.from({ length: 8 }, (_, i): Message => ({ role: i % 2 ? 'user' : 'assistant', text: `t${i}`, toolUses: [] })),
    ];
    const dropAll: Scorer = async (calls) => ({ verdicts: new Map(calls.map((c) => [c.id, { action: 'drop_call', source: 'claude' }])), claude: 'ran' });
    const out = await compact(input, dropAll, { preserveRecentMessages: 2, protectedResultIds: ['a'] });
    expect(out.messages[1]).toBe(input[1]);
    expect(out.messages[2]).toBe(input[2]);
    expect(out.decisions[0]).toMatchObject({ action: 'keep', source: 'pinned' });
    const unprotected = await compact(input, dropAll, { preserveRecentMessages: 2 });
    expect(unprotected.messages[2]).not.toBe(input[2]);
  });
});
