import { describe, expect, it } from 'vitest';
import { compact, type Message, type Scorer } from '../src/index.js';

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

function randomTranscript(r: () => number): Message[] {
  const out: Message[] = [{ role: 'user', text: 'start', toolUses: [] }];
  const count = 5 + Math.floor(r() * 40);
  for (let i = 0; i < count; i += 1) {
    const id = `u${i}`;
    const tool = TOOLS[Math.floor(r() * TOOLS.length)]!;
    out.push({ role: 'assistant', text: r() < 0.3 ? `thinking ${i}` : '', toolUses: [{ tool_use_id: id, tool, input: { file_path: `src/f${Math.floor(r() * 4)}.ts` } }] });
    out.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'z'.repeat(Math.floor(r() * 2000)), isError: r() < 0.1 }] });
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

      const inText = input.map((m) => m.text).filter((t) => t.trim().length > 0);
      const outText = out.messages.map((m) => m.text).filter((t) => t.trim().length > 0);
      expect(outText).toEqual(inText);

      expect(out.messages[0]).toBe(input[0]);
      const tail = input.slice(-4);
      expect(out.messages.slice(-4)).toEqual(tail);
    }
  });
});
