import { describe, expect, it } from 'vitest';
import { compact, type Message, type Scorer } from '../src/index.js';

/**
 * The model's earlier thinking stays in context (a fit to real API usage puts it at a quarter to
 * nearly half of a long session's tokens), and Claude Code hands each thinking block to the hook as
 * its own row: an assistant message with no text and no tool calls. Returning the transcript without
 * such a row removes that thinking block (2.1.282 maps returned rows back by handle, and a row left
 * out is not installed). The API accepts thinking omitted from completed earlier turns; the last
 * assistant turn's thinking (an active tool loop) must stay, signature and all.
 */

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
const think = () => msg('assistant', '');
function use(id: string): Message {
  return msg('assistant', '', { toolUses: [{ tool_use_id: id, tool: 'Bash', input: { command: `echo ${id}` } }] });
}
function res(id: string): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text: `out ${id}` }] });
}
const keepAll: Scorer = async () => ({ verdicts: new Map(), claude: 'skipped' });

/** Three turns: a prompt, thinking, a call and its result, thinking, an answer. */
function turns(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(msg('user', `prompt ${i}`), think(), use(`u${i}`), res(`u${i}`), think(), msg('assistant', `answer ${i}`));
  }
  return out;
}
const thinkingRows = (ms: readonly Message[]) =>
  ms.filter((m) => m.role === 'assistant' && m.text === '' && m.toolUses.length === 0 && !(m.toolResults?.length)).length;

describe('dropOldThinking', () => {
  it('drops thinking-only rows of completed earlier turns, outside the preserved tail', async () => {
    const input = turns(4);
    const out = await compact(input, keepAll, { preserveRecentMessages: 2, dropOldThinking: true });
    // Turns 0-2 lose their two thinking rows each; the last turn (from its prompt on) keeps both.
    expect(thinkingRows(out.messages)).toBe(2);
    expect(out.stats.thinkingDropped).toBe(6);
    const last = input.slice(18);
    expect(out.messages.slice(-last.length)).toEqual(last);
    for (const m of last) expect(out.messages).toContain(m);
  });

  it('never drops thinking in the last assistant turn, however long that turn is', async () => {
    // One prompt, then a long tool loop: every row is in the last assistant turn.
    const input: Message[] = [msg('user', 'go')];
    for (let i = 0; i < 30; i += 1) input.push(think(), use(`u${i}`), res(`u${i}`));
    const out = await compact(input, keepAll, { preserveRecentMessages: 2, dropOldThinking: true });
    expect(thinkingRows(out.messages)).toBe(30);
    expect(out.stats.thinkingDropped ?? 0).toBe(0);
  });

  it('never drops the preserved tail or the first message, and leaves pairing untouched', async () => {
    const input = turns(3);
    const out = await compact(input, keepAll, { preserveRecentMessages: 12, dropOldThinking: true });
    // Only turn 0 is outside a 12-row tail.
    expect(out.stats.thinkingDropped).toBe(2);
    expect(out.messages[0]).toBe(input[0]);
    const uses = out.messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
    const results = out.messages.flatMap((m) => (m.toolResults ?? []).map((r) => r.tool_use_id));
    expect(uses).toEqual(results);
    // Every kept row is the input's own object: nothing is rebuilt for it.
    for (const m of out.messages) expect(input).toContain(m);
  });

  it('is off unless asked for', async () => {
    const out = await compact(turns(4), keepAll, { preserveRecentMessages: 2 });
    expect(thinkingRows(out.messages)).toBe(8);
    expect(out.stats.thinkingDropped).toBeUndefined();
  });
});
