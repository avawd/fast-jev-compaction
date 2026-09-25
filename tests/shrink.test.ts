import { describe, expect, it } from 'vitest';
import { toSessionMessages } from '../hooks/verbatim.ts';
import {
  collectToolCalls, compact, isShrunk, SHRINK_NOTE_PREFIX, shrinkOld, shrinkText, type Message, type Scorer, type ToolCall,
} from '../src/index.js';
import { annotateCalls } from '../src/annotate.js';

const keepAll: Scorer = async () => ({ verdicts: new Map(), claude: 'skipped' });

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function use(id: string, tool: string, input: Record<string, unknown>, text = ''): Message {
  return msg('assistant', text, { toolUses: [{ tool_use_id: id, tool, input }] });
}
function res(id: string, text: string): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] });
}
/** `n` filler rows, so what comes before them is old. */
function filler(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `filler ${i}`));
}

const heredoc = ['cat > /tmp/script.py <<EOF', ...Array.from({ length: 200 }, (_, i) => `print("line ${i} of the script body")`), 'EOF', 'python3 /tmp/script.py'].join('\n');
const fileBody = Array.from({ length: 300 }, (_, i) => `export const value${i} = ${i};`).join('\n');

const OPTS = { preserveRecentMessages: 6, staleAfterMessages: 20 };

function shrinkOf(messages: Message[], options: Partial<typeof OPTS> & { shrinkOldInputs?: boolean; shrinkOldText?: boolean } = {}) {
  const o = { ...OPTS, shrinkOldInputs: true, shrinkOldText: true, pinReferenced: true, ...options };
  const calls: ToolCall[] = annotateCalls(collectToolCalls(messages, o.preserveRecentMessages), messages, o);
  return shrinkOld(messages, messages, calls, o);
}

describe('shrinkText', () => {
  it('keeps a head, a note naming what went, and the lines that carry a must-keep token', () => {
    const text = fileBody;
    const out = shrinkText(text, { head: 200, what: "this Write's content", hint: 'the file on disk holds it' }, ['value250']);
    expect(out.length).toBeLessThan(text.length / 4);
    expect(text.startsWith(out.slice(0, 150))).toBe(true);
    expect(out).toContain(SHRINK_NOTE_PREFIX);
    expect(out).toContain('export const value250 = 250;');
    expect(isShrunk(out)).toBe(true);
  });

  it('leaves text that already carries a note, or that would not shrink, alone', () => {
    const once = shrinkText(fileBody, { head: 200, what: 'x', hint: 'y' }, []);
    expect(shrinkText(once, { head: 50, what: 'x', hint: 'y' }, [])).toBe(once);
    expect(shrinkText('short', { head: 200, what: 'x', hint: 'y' }, [])).toBe('short');
  });

  it('keeps the text whole when its must-keep lines would not fit the budget', () => {
    const tokens = Array.from({ length: 300 }, (_, i) => `value${i}`).filter((_, i) => i > 20);
    expect(shrinkText(fileBody, { head: 200, what: 'x', hint: 'y' }, tokens)).toBe(fileBody);
  });

  it('never splits a surrogate pair', () => {
    const text = `${'a'.repeat(199)}😀${'b'.repeat(3000)}`;
    const out = shrinkText(text, { head: 200, what: 'x', hint: 'y' }, []);
    expect(out.isWellFormed()).toBe(true);
  });
});

describe('shrinkOld', () => {
  it('shortens an old Bash heredoc, keeping the tool_use id, the other fields and the result', () => {
    const messages = [msg('user', 'go'), use('b1', 'Bash', { command: heredoc, description: 'run it' }), res('b1', 'ok'), ...filler(30)];
    const { messages: out, inputs } = shrinkOf(messages);
    expect(inputs).toBe(1);
    const row = out[1]!;
    expect(row).not.toBe(messages[1]);
    expect(row.toolUses[0]!.tool_use_id).toBe('b1');
    expect(row.toolUses[0]!.input['description']).toBe('run it');
    const command = row.toolUses[0]!.input['command'] as string;
    expect(command.startsWith('cat > /tmp/script.py <<EOF')).toBe(true);
    expect(command).toContain(SHRINK_NOTE_PREFIX);
    expect(command.length).toBeLessThan(heredoc.length / 3);
    expect(out[2]).toBe(messages[2]);
  });

  it('shortens an old Write content and Edit strings but keeps file_path', () => {
    const messages = [
      msg('user', 'go'),
      use('w1', 'Write', { file_path: '/repo/src/values.ts', content: fileBody }),
      res('w1', 'File created'),
      use('e1', 'Edit', { file_path: '/repo/src/values.ts', old_string: fileBody.slice(0, 2000), new_string: fileBody.slice(2000, 5000) }),
      res('e1', 'File updated'),
      ...filler(30),
    ];
    const { messages: out, inputs } = shrinkOf(messages);
    expect(inputs).toBe(2);
    expect(out[1]!.toolUses[0]!.input['file_path']).toBe('/repo/src/values.ts');
    expect((out[1]!.toolUses[0]!.input['content'] as string).length).toBeLessThan(1000);
    expect((out[3]!.toolUses[0]!.input['new_string'] as string)).toContain(SHRINK_NOTE_PREFIX);
    expect((out[3]!.toolUses[0]!.input['old_string'] as string)).toContain(SHRINK_NOTE_PREFIX);
  });

  it('leaves recent calls, the preserved tail and the first row alone', () => {
    const messages = [use('b0', 'Bash', { command: heredoc }), res('b0', 'ok'), ...filler(5), use('b1', 'Bash', { command: heredoc }), res('b1', 'ok'), ...filler(4)];
    const { messages: out, inputs } = shrinkOf(messages);
    expect(inputs).toBe(0);
    out.forEach((m, i) => expect(m).toBe(messages[i]));
  });

  it('does nothing with both options off', () => {
    const messages = [msg('user', 'go'), use('b1', 'Bash', { command: heredoc }), res('b1', 'ok'), msg('assistant', fileBody), ...filler(30)];
    const { messages: out } = shrinkOf(messages, { shrinkOldInputs: false, shrinkOldText: false });
    out.forEach((m, i) => expect(m).toBe(messages[i]));
  });

  it('merges a parallel group into one row so every tool_use still precedes its results', () => {
    const messages = [
      msg('user', 'go'),
      msg('assistant', ''), // thinking
      use('p1', 'Bash', { command: heredoc }),
      use('p2', 'Bash', { command: 'echo short' }),
      use('p3', 'Write', { file_path: '/repo/x.ts', content: fileBody }),
      res('p1', 'one'),
      res('p2', 'two'),
      res('p3', 'three'),
      ...filler(30),
    ];
    const { messages: out, inputs } = shrinkOf(messages);
    expect(inputs).toBe(2);
    expect(out).toHaveLength(messages.length - 2);
    expect(out[1]).toBe(messages[1]);
    const merged = out[2]!;
    expect(merged.role).toBe('assistant');
    expect(merged.toolUses.map((u) => u.tool_use_id)).toEqual(['p1', 'p2', 'p3']);
    expect(merged.toolUses[1]!.input).toEqual({ command: 'echo short' });
    expect(out[3]).toBe(messages[5]);
  });

  it('skips a group whose tool rows are followed by more assistant rows before the results', () => {
    const messages = [
      msg('user', 'go'),
      use('p1', 'Bash', { command: heredoc }),
      use('p2', 'Bash', { command: heredoc }),
      msg('assistant', 'trailing text'),
      res('p1', 'one'),
      res('p2', 'two'),
      ...filler(30),
    ];
    const { messages: out, inputs } = shrinkOf(messages, { shrinkOldText: false });
    expect(inputs).toBe(0);
    out.forEach((m, i) => expect(m).toBe(messages[i]));
  });

  it('keeps an input line whose token a later message quotes', () => {
    const script = heredoc.replace('print("line 150 of the script body")', 'print("deploy key ZETA_TOKEN_NAME_42")');
    const messages = [msg('user', 'go'), use('b1', 'Bash', { command: script }), res('b1', 'ok'), msg('assistant', 'set ZETA_TOKEN_NAME_42 next'), ...filler(30)];
    const { messages: out } = shrinkOf(messages);
    expect(out[1]!.toolUses[0]!.input['command']).toContain('ZETA_TOKEN_NAME_42');
  });

  it('keeps twice the head of a call whose result carries a token quoted later', () => {
    const quoted = [msg('user', 'go'), use('b1', 'Bash', { command: heredoc }), res('b1', 'created abc1234def'), msg('assistant', 'commit abc1234def is in'), ...filler(30)];
    const plain = [msg('user', 'go'), use('b1', 'Bash', { command: heredoc }), res('b1', 'created'), msg('assistant', 'done'), ...filler(30)];
    const head = (m: Message[]) => (shrinkOf(m).messages[1]!.toolUses[0]!.input['command'] as string).indexOf(SHRINK_NOTE_PREFIX);
    expect(head(quoted)).toBeGreaterThanOrEqual(2 * 300);
    expect(head(plain)).toBeLessThan(2 * 300);
  });

  it('shortens a Write whose result path is quoted later: the confirmation needs no content', () => {
    const messages = [msg('user', 'go'), use('w1', 'Write', { file_path: '/repo/src/values.ts', content: fileBody }), res('w1', 'File created successfully at: /repo/src/values.ts'), msg('assistant', 'wrote /repo/src/values.ts'), ...filler(30)];
    expect(shrinkOf(messages).inputs).toBe(1);
  });

  it('keeps many quoted lines of a long prompt, up to about a third of it', () => {
    const prompt = Array.from({ length: 120 }, (_, i) => `Step ${i}: look at docs/area${i}/notes.md and report back in detail please`).join('\n');
    const later = Array.from({ length: 30 }, (_, i) => `docs/area${i * 4}/notes.md`).join(' ');
    const messages = [msg('user', 'go'), use('a1', 'Agent', { prompt, description: 'survey' }), res('a1', 'report'), msg('assistant', `checked ${later}`), ...filler(30)];
    const out = shrinkOf(messages).messages[1]!.toolUses[0]!.input['prompt'] as string;
    expect(out).toContain(SHRINK_NOTE_PREFIX);
    for (let i = 0; i < 30; i += 1) expect(out).toContain(`docs/area${i * 4}/notes.md`);
  });

  it('never touches an AskUserQuestion', () => {
    const questions = [{ question: 'x'.repeat(3000), options: [] }];
    const messages = [msg('user', 'go'), use('q1', 'AskUserQuestion', { questions }), res('q1', 'answered'), ...filler(30)];
    expect(shrinkOf(messages).inputs).toBe(0);
  });

  it('shortens a long old assistant text row but keeps its salient lines', () => {
    const reply = [...Array.from({ length: 60 }, (_, i) => `Paragraph ${i} explains the plan in some detail and at some length.`), 'Merged as #4567 at sha 9f8e7d6c5b.', ...Array.from({ length: 20 }, () => 'More prose.')].join('\n');
    const messages = [msg('user', 'go'), msg('assistant', reply), ...filler(30)];
    const { messages: out, texts } = shrinkOf(messages);
    expect(texts).toBe(1);
    expect(out[1]!.text.length).toBeLessThan(reply.length / 2);
    expect(out[1]!.text).toContain('#4567');
    expect(out[1]!.text).toContain(SHRINK_NOTE_PREFIX);
  });

  it('is idempotent: a second pass over its output changes nothing and nests no note', () => {
    const messages = [msg('user', 'go'), use('b1', 'Bash', { command: heredoc }), res('b1', 'ok'), msg('assistant', fileBody), ...filler(30)];
    const once = shrinkOf(messages).messages;
    const twice = shrinkOf(once);
    expect(twice.inputs + twice.texts).toBe(0);
    twice.messages.forEach((m, i) => expect(m).toBe(once[i]));
  });
});

describe('compact with shrinking', () => {
  it('counts what shrinking saved and hands the engine a rebuilt row without a handle', async () => {
    const messages = [msg('user', 'go'), use('b1', 'Bash', { command: heredoc }), res('b1', 'ok'), ...filler(30)].map((m, i) => ({ ...m, handle: `h${i}` }));
    const result = await compact(messages, keepAll, OPTS);
    expect(result.stats.inputsShrunk).toBe(1);
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore);
    const session = toSessionMessages(messages as never, result.messages);
    expect(session[1]!.handle).toBeUndefined();
    expect(session[1]!.toolUses[0]!.tool_use_id).toBe('b1');
    expect(session[2]).toBe(messages[2]);
  });

  it('shrinks nothing when the options are off', async () => {
    const messages = [msg('user', 'go'), use('b1', 'Bash', { command: heredoc }), res('b1', 'ok'), ...filler(30)];
    const result = await compact(messages, keepAll, { ...OPTS, shrinkOldInputs: false, shrinkOldText: false });
    result.messages.forEach((m, i) => expect(m).toBe(messages[i]));
    expect(result.stats.inputsShrunk).toBe(0);
  });
});
