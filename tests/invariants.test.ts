import { describe, expect, it } from 'vitest';
import { compact, type Message, type Scorer, type ToolUse } from '../src/index.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOLS = ['Read', 'Edit', 'Grep', 'Bash'];

function randomUse(r: () => number, id: string): ToolUse {
  const tool = TOOLS[Math.floor(r() * TOOLS.length)]!;
  const use: ToolUse = { tool_use_id: id, tool, input: { file_path: `src/f${Math.floor(r() * 4)}.ts` } };
  if (r() < 0.3) use.text = 'o'.repeat(Math.floor(r() * 1500));
  return use;
}

function randomTranscript(r: () => number): Message[] {
  const out: Message[] = [{ role: 'user', text: 'start', toolUses: [] }];
  const count = 5 + Math.floor(r() * 40);
  for (let i = 0; i < count; i += 1) {
    const ids = r() < 0.3 ? [`u${i}a`, `u${i}b`] : [`u${i}`];
    const toolUses = ids.map((id) => randomUse(r, id));
    const toolResults = ids.map((id) => ({
      tool_use_id: id, text: 'z'.repeat(Math.floor(r() * 2000)), isError: r() < 0.1,
    }));
    // A thinking block arrives as its own assistant row with no text, before its tool_use row.
    if (r() < 0.4) out.push({ role: 'assistant', text: '', toolUses: [] });
    out.push({ role: 'assistant', text: r() < 0.3 ? `thinking ${i}` : '', toolUses });
    out.push({ role: 'user', text: '', toolUses: [], toolResults });
  }
  out.push({ role: 'user', text: 'end', toolUses: [] });
  return out;
}

const randomScorer = (r: () => number): Scorer => async (calls) => ({
  claude: 'ran',
  verdicts: new Map(
    calls.filter(() => r() < 0.6).map((c) => [c.id, { action: r() < 0.5 ? 'drop_call' : 'drop_result', source: 'claude' }] as const),
  ),
});

describe('invariants over random transcripts', () => {
  it('never orphans a result, never edits text, never touches pinned messages', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const r = rng(seed);
      const input = randomTranscript(r);
      const out = await compact(input, randomScorer(r), { preserveRecentMessages: 4 });

      const useIds = new Set(out.messages.flatMap((m) => m.toolUses.map((t) => t.tool_use_id)));
      for (const m of out.messages) for (const res of m.toolResults ?? []) expect(useIds.has(res.tool_use_id)).toBe(true);

      const resultIds = new Set(out.messages.flatMap((m) => (m.toolResults ?? []).map((x) => x.tool_use_id)));
      for (const id of useIds) expect(resultIds.has(id)).toBe(true);

      const inputs = new Set(input);
      const isEmpty = (m: Message) => m.text.trim().length === 0 && m.toolUses.length === 0 && (m.toolResults ?? []).length === 0;
      out.messages.forEach((message, k) => {
        if (!inputs.has(message)) expect(isEmpty(message)).toBe(false);
        if (isEmpty(message) && message.role === 'assistant') {
          // Its sibling tool_use row must still be there, carrying its call.
          const sibling = out.messages[k + 1];
          expect(sibling?.role).toBe('assistant');
          expect(sibling!.toolUses.length + sibling!.text.trim().length).toBeGreaterThan(0);
        }
      });

      const inText = input.map((m) => m.text).filter((t) => t.trim().length > 0);
      const outText = out.messages.map((m) => m.text).filter((t) => t.trim().length > 0);
      expect(outText).toEqual(inText);

      expect(out.messages[0]).toBe(input[0]);
      const tail = input.slice(-4);
      const outTail = out.messages.slice(-4);
      tail.forEach((message, i) => expect(outTail[i]).toBe(message));
    }
  });
});
