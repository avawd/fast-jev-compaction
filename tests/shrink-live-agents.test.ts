import { describe, expect, it } from 'vitest';
import { collectToolCalls, liveInstructionIds, shrinkOld, SHRINK_NOTE_PREFIX, type Message, type ToolCall } from '../src/index.js';
import { annotateCalls } from '../src/annotate.js';

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function use(id: string, tool: string, input: Record<string, unknown>): Message {
  return msg('assistant', '', { toolUses: [{ tool_use_id: id, tool, input }] });
}
function res(id: string, text: string): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text, isError: false }] });
}
function filler(n: number): Message[] {
  return Array.from({ length: n }, (_, i) => msg(i % 2 === 0 ? 'user' : 'assistant', `filler ${i}`));
}
const prompt = Array.from({ length: 120 }, (_, i) => `Step ${i}: do the careful thing number ${i} and report back.`).join('\n');
const reply = (from: string, text: string) =>
  msg('user', `Another Claude session sent a message:\n<teammate-message teammate_id="${from}">\n${text}\n</teammate-message>`);

const OPTS = { preserveRecentMessages: 6, staleAfterMessages: 20, shrinkOldInputs: true, pinReferenced: true };
function shrinkOf(messages: Message[]) {
  const calls: ToolCall[] = annotateCalls(collectToolCalls(messages, OPTS.preserveRecentMessages), messages, OPTS);
  return { out: shrinkOld(messages, messages, calls, OPTS), calls };
}
const inputOf = (messages: readonly Message[], id: string) =>
  messages.flatMap((m) => m.toolUses).find((u) => u.tool_use_id === id)?.input;

describe('live agents: their instructions are never shortened', () => {
  it('keeps a background agent prompt whole while its result only says it was spawned', () => {
    const input = [msg('user', 'go'), use('a1', 'Agent', { prompt, run_in_background: true }),
      res('a1', 'Async agent launched successfully. agentId: a1 (the agent is now running in the background)'), ...filler(30)];
    const { out, calls } = shrinkOf(input);
    expect(inputOf(out.messages, 'a1')).toEqual({ prompt, run_in_background: true });
    expect(out.inputs).toBe(0);
    expect([...liveInstructionIds(calls, input)]).toEqual(['a1']);
  });

  it('keeps a teammate spawn whole, whatever its result says', () => {
    const input = [msg('user', 'go'), use('a1', 'Agent', { prompt, name: 'worker-2', team_name: 't' }),
      res('a1', 'Spawned successfully as worker-2. The agent is now running and will receive instructions via mailbox.'), ...filler(30)];
    expect(inputOf(shrinkOf(input).out.messages, 'a1')).toEqual({ prompt, name: 'worker-2', team_name: 't' });
  });

  it('still shortens a foreground agent whose result is its report, and the note never says it ran', () => {
    const input = [msg('user', 'go'), use('a1', 'Agent', { prompt }), res('a1', 'Report: all three files fixed.'), ...filler(30)];
    const shrunk = inputOf(shrinkOf(input).out.messages, 'a1')!['prompt'] as string;
    expect(shrunk).toContain(SHRINK_NOTE_PREFIX);
    expect(shrunk).not.toMatch(/already ran/);
    expect(shrunk).toMatch(/tool result/);
  });

  it('keeps a SendMessage body whole until its recipient answers after it', () => {
    const body = prompt;
    const before = [msg('user', 'go'), use('s1', 'SendMessage', { to: 'r4-log', message: body }), res('s1', '{"success":true}'), ...filler(30)];
    expect(inputOf(shrinkOf(before).out.messages, 's1')).toEqual({ to: 'r4-log', message: body });
    // An answer from someone else, or one from the recipient that came BEFORE the message, is no answer.
    const others = [msg('user', 'go'), reply('r4-log', 'earlier'), use('s1', 'SendMessage', { to: 'r4-log', message: body }), res('s1', 'ok'),
      reply('someone-else', 'done'), ...filler(30)];
    expect(inputOf(shrinkOf(others).out.messages, 's1')).toEqual({ to: 'r4-log', message: body });
    const answered = [msg('user', 'go'), use('s1', 'SendMessage', { to: 'r4-log', message: body }), res('s1', 'ok'),
      reply('r4-log', 'done: 3855daf'), ...filler(30)];
    expect((inputOf(shrinkOf(answered).out.messages, 's1')!['message'] as string)).toContain(SHRINK_NOTE_PREFIX);
  });

  it('keeps a broadcast or a recipient-less SendMessage whole', () => {
    for (const to of ['*', undefined]) {
      const input = [msg('user', 'go'), use('s1', 'SendMessage', { to, message: prompt }), res('s1', 'ok'), reply('x', 'done'), ...filler(30)];
      expect(inputOf(shrinkOf(input).out.messages, 's1')).toEqual({ to, message: prompt });
    }
  });
});
