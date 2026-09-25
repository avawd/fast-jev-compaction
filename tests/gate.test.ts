import { describe, expect, it } from 'vitest';
import { compact, gateRatio, makeScorer, reductionRatio, resultChars, type Message } from '../src/index.js';

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function use(id: string, tool: string, input: Record<string, unknown>): Message {
  return msg('assistant', '', { toolUses: [{ tool_use_id: id, tool, input }] });
}
function res(id: string, text: string): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text }] });
}
const tail = (n: number): Message[] => Array.from({ length: n }, (_, i) => msg(i % 2 ? 'user' : 'assistant', 'ok'));
const rulesOnly = makeScorer({ useClaudeScorer: false, maxCandidates: 400 });

describe('gateRatio', () => {
  it('counts tool-result characters only', () => {
    expect(resultChars([msg('user', 'x'.repeat(50)), res('u1', 'abc'), res('u2', 'de')])).toBe(5);
  });

  it('reports result bytes and gates on the reduction of them', async () => {
    const messages = [msg('user', 'x'.repeat(10_000)), use('u1', 'Read', { file_path: 'a.ts' }), res('u1', 'z'.repeat(4000)),
      use('u2', 'Read', { file_path: 'a.ts' }), res('u2', 'z'.repeat(4000)), ...tail(8)];
    const out = await compact(messages, rulesOnly, {});
    expect(out.stats.resultCharsBefore).toBe(8000);
    const saved = out.stats.charsBefore - out.stats.charsAfter;
    expect(saved).toBeGreaterThan(3000);
    expect(gateRatio(out)).toBeCloseTo(saved / 8000, 5);
    expect(gateRatio(out)).toBeGreaterThan(reductionRatio(out));
    expect(gateRatio({ stats: { ...out.stats, resultCharsBefore: 0 } })).toBe(0);
  });

  it('caps at 1 when dropped call inputs push the saving past the result total', () => {
    const stats = { charsBefore: 1000, charsAfter: 0, resultCharsBefore: 10 };
    expect(gateRatio({ stats } as never)).toBe(1);
  });
});
