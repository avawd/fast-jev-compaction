import { describe, expect, it } from 'vitest';
import { compact, TRUNCATION_NOTE_PREFIX, type Message, type Scorer } from '../src/index.js';

/**
 * A long session compacts many times, so a result truncated by one pass is handed to the next.
 * Measured on the replay (eval/replay.ts) before this: a pinned head-stretched result re-cut with
 * a head+tail window kept the old note inside its new tail (two notes, the first one's count now
 * wrong), and a third pass made three.
 */

const note = (n: number, error = false) =>
  `${TRUNCATION_NOTE_PREFIX} ${n} chars of this tool result${error ? ' (error)' : ''}; re-run the tool if needed]`;

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function use(id: string, tool: string, input: Record<string, unknown>, text = 'calling'): Message {
  return msg('assistant', text, { toolUses: [{ tool_use_id: id, tool, input }] });
}
function res(id: string, text: string, isError = false): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}
const tail = () => ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((t) => msg(t === 'a' ? 'user' : 'assistant', `later ${t}`));

const dropAll = (action: 'drop_result' | 'drop_call' = 'drop_result', source: 'claude' | 'rule' = 'claude'): Scorer => async (calls) => ({
  claude: 'ran',
  verdicts: new Map(calls.filter((c) => !c.pinned).map((c) => [c.id, { action, source }])),
});

function notes(text: string): number {
  return text.split(TRUNCATION_NOTE_PREFIX).length - 1;
}

async function resultAfter(text: string, options: Record<string, unknown> = {}, scorer = dropAll(), tool = 'Read', isError = false) {
  const input = [msg('user', 'go'), use('u1', tool, { file_path: '/srv/app/a.ts' }), res('u1', text, isError), ...tail()];
  const out = await compact(input, scorer, { preserveRecentMessages: 6, ...options });
  return { text: out.messages.find((m) => m.toolResults?.length)?.toolResults?.[0]?.text, out };
}

describe('re-truncating a result an earlier pass already truncated', () => {
  it('cuts the old head further and merges the counts into one note', async () => {
    const head = 'h'.repeat(2000);
    const { text } = await resultAfter(`${head}\n${note(5000)}`, { truncateHeadChars: 300 });
    expect(text).toBe(`${'h'.repeat(300)}\n${note(6700)}`);
  });

  it('keeps the old tail when the new tail still covers it, and never nests the old note', async () => {
    const before = `${'h'.repeat(2000)}\n${note(9000)}\n${'t'.repeat(800)}`;
    const { text } = await resultAfter(before, { truncateHeadChars: 300, truncateTailChars: 1000 }, dropAll(), 'Bash');
    // The Bash result ends with no verdict and its command is not a test run: head only.
    expect(notes(text!)).toBe(1);
    expect(text).toBe(`${'h'.repeat(300)}\n${note(9000 + 1700 + 800)}`);
  });

  it('is a no-op (a keep) when the new window is no smaller than the old one', async () => {
    const before = `${'h'.repeat(300)}\n${note(9000)}`;
    const { text, out } = await resultAfter(before, { truncateHeadChars: 300 });
    expect(text).toBe(before);
    expect(out.decisions[0]).toMatchObject({ action: 'keep' });
  });

  it('shrinks an old truncation to its note alone on a rule drop, with the whole count', async () => {
    const before = `${'h'.repeat(300)}\n${note(9000, true)}`;
    // A rule's drop_call on a call whose row has no text becomes a note-only truncation.
    const input = [msg('user', 'go'), use('u1', 'Read', { file_path: '/srv/app/a.ts' }, ''), res('u1', before, true), ...tail()];
    const out = await compact(input, dropAll('drop_call', 'rule'), { preserveRecentMessages: 6 });
    const text = out.messages.find((m) => m.toolResults?.length)?.toolResults?.[0]?.text;
    expect(text).toBe(note(9300, true));
  });

  it("leaves an old head-only truncation as it is on Claude's drop, which keeps the default head", async () => {
    const before = `${'h'.repeat(300)}\n${note(9000, true)}`;
    const input = [msg('user', 'go'), use('u1', 'Read', { file_path: '/srv/app/a.ts' }, ''), res('u1', before, true), ...tail()];
    const out = await compact(input, dropAll('drop_call'), { preserveRecentMessages: 6 });
    const text = out.messages.find((m) => m.toolResults?.length)?.toolResults?.[0]?.text;
    expect(text).toBe(before);
  });

  it('leaves a result alone when a pinned window reaches past the old note', async () => {
    // The token sits in the old tail, beyond what a head+tail window of the new size would keep
    // without stretching across the note: re-cutting would lose it or nest the note.
    const before = `${'h'.repeat(2000)}\n${note(9000)}\n${'t'.repeat(1500)} sha 9f3e2a1c7b ${'t'.repeat(1500)}`;
    const input = [
      msg('user', 'go'),
      use('u1', 'Read', { file_path: '/srv/app/a.ts' }),
      res('u1', before),
      msg('assistant', 'The fix is 9f3e2a1c7b.'),
      ...tail(),
    ];
    const out = await compact(input, dropAll(), { preserveRecentMessages: 6, truncateHeadChars: 300, truncateTailChars: 1000 });
    const text = out.messages.find((m) => m.toolResults?.length)?.toolResults?.[0]?.text ?? '';
    expect(text).toContain('9f3e2a1c7b');
    expect(notes(text)).toBe(1);
  });

  it('never re-cuts a result that already holds more than one note', async () => {
    const before = `${'h'.repeat(2000)}\n${note(10)}\n${'m'.repeat(2000)}\n${note(20)}`;
    const { text } = await resultAfter(before, { truncateHeadChars: 300 });
    expect(text).toBe(before);
  });

  it('is idempotent: a second identical pass changes no result', async () => {
    const input = [
      msg('user', 'go'),
      use('u1', 'Read', { file_path: '/srv/app/a.ts' }),
      res('u1', 'r'.repeat(8000)),
      use('u2', 'Bash', { command: 'npm test' }),
      res('u2', `${'l'.repeat(6000)}\n57 passed`),
      ...tail(),
    ];
    const once = await compact(input, dropAll(), { preserveRecentMessages: 6 });
    const twice = await compact(once.messages, dropAll(), { preserveRecentMessages: 6 });
    const texts = (ms: readonly Message[]) => ms.flatMap((m) => (m.toolResults ?? []).map((r) => r.text));
    expect(texts(twice.messages)).toEqual(texts(once.messages));
    expect(twice.stats.resultsDropped).toBe(0);
  });

  it('never re-cuts or nests an excerpted result, and keeps its pinned windows', async () => {
    // A first pass excerpts a result whose quoted tokens sit far past any head (excerpt.ts).
    const body = (k: number) => Array.from({ length: 200 }, (_, i) => `line ${k}-${i} ${'x'.repeat(60)}`).join('\n');
    const text = `${body(1)}\nsha 7c0ffee1a2b3 here\n${body(2)}\nsha 5eedbead9f00 there\n${body(3)}`;
    const input = [
      msg('user', 'go'),
      use('u1', 'Read', { file_path: '/srv/app/a.ts' }),
      res('u1', text),
      msg('assistant', 'Both 7c0ffee1a2b3 and 5eedbead9f00 matter.'),
      ...tail(),
    ];
    const once = await compact(input, dropAll(), { preserveRecentMessages: 6 });
    const first = once.messages.find((m) => m.toolResults?.length)!.toolResults![0]!.text;
    expect(first).toMatch(/chars omitted/);
    for (const options of [{}, { truncateHeadChars: 50, truncateTailChars: 100 }, { escalateBelow: 0.99 }]) {
      const twice = await compact(once.messages, dropAll(), { preserveRecentMessages: 6, ...options });
      const second = twice.messages.find((m) => m.toolResults?.length)!.toolResults![0]!.text;
      expect(notes(second)).toBe(1);
      expect(second).toContain('7c0ffee1a2b3');
      expect(second).toContain('5eedbead9f00');
      expect(second).toBe(first);
    }
    // Once nothing quotes the tokens any more, it is still left as it is, not cut around its markers.
    const unquoted = once.messages.filter((m) => !m.text.startsWith('Both'));
    const third = await compact(unquoted, dropAll(), { preserveRecentMessages: 6, truncateHeadChars: 50 });
    expect(third.messages.find((m) => m.toolResults?.length)!.toolResults![0]!.text).toBe(first);
  });
});
