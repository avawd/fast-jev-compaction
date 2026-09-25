import { describe, expect, it } from 'vitest';
import { compact, makeScorer, salientWindows, type Message, type Scorer } from '../src/index.js';

/**
 * Recall fixes measured by eval/recall.ts: a Claude `drop` kept no head at all (9 of 15 live
 * Claude-cut misses sat in the first 300 chars), and a stale file read kept a 300-char head only
 * (the facts past it were lost). See the round-2 recall eval.
 */
function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
const use = (id: string, tool: string, input: Record<string, unknown>) => msg('assistant', '', { toolUses: [{ tool_use_id: id, tool, input }] });
const res = (id: string, text: string) => msg('user', '', { toolResults: [{ tool_use_id: id, text }] });
const tail = () => ['a', 'b', 'c', 'd', 'e', 'f'].map((t, i) => msg(i % 2 ? 'assistant' : 'user', t));
const notes = (text: string) => text.split('[verbatim-compaction truncated').length - 1;
const resultOf = (out: Message[], id: string) => out.flatMap((m) => m.toolResults ?? []).find((r) => r.tool_use_id === id)?.text ?? '';

describe('A: a Claude drop keeps the head', () => {
  const body = 'build 9876543 started\n' + 'x'.repeat(3000) + '\nTests: 3 passed';

  it('keeps the default head (no tail) where the call row has no text', async () => {
    const input = [msg('user', 'go'), use('u1', 'Bash', { command: 'npm test' }), res('u1', body), ...tail()];
    const scorer: Scorer = async () => ({ claude: 'ran', verdicts: new Map([['t1', { action: 'drop_call', source: 'claude' }]]) });
    const out = await compact(input, scorer, { preserveRecentMessages: 6 });
    const text = resultOf(out.messages, 'u1');
    expect(text).toContain('9876543');
    expect(text).not.toContain('Tests: 3 passed');
    expect(text.length).toBeLessThan(500);
    expect(out.decisions[0]).toMatchObject({ action: 'drop_result', source: 'claude' });
  });

  it('a rule drop (a later call superseded it) still keeps nothing but the note', async () => {
    const input = [
      msg('user', 'go'),
      use('u1', 'Grep', { pattern: 'foo' }), res('u1', body),
      use('u2', 'Grep', { pattern: 'foo' }), res('u2', body),
      ...tail(),
    ];
    const scorer: Scorer = async () => ({ claude: 'ran', verdicts: new Map([['t1', { action: 'drop_call', source: 'rule', rule: 'repeated_search' }]]) });
    const out = await compact(input, scorer, { preserveRecentMessages: 6 });
    expect(resultOf(out.messages, 'u1').startsWith('[verbatim-compaction truncated')).toBe(true);
  });
});

describe('B: salientWindows', () => {
  it('picks lines past the head that carry a sha, #PR, ticket key, URL, money or long number', () => {
    const lines = ['head line', 'plain words only', 'commit ab12cd34 merged', 'year 2026 only', 'see #4321 now', 'x'.repeat(50)];
    const text = lines.join('\n');
    const w = salientWindows(text, 10, 0);
    expect(w.map(([s, e]) => text.slice(s, e))).toEqual(['commit ab12cd34 merged', 'see #4321 now']);
  });

  it('caps a line at 120 chars and all windows at 400', () => {
    const text = 'head\n' + Array.from({ length: 20 }, (_, i) => `id ${100000 + i} ${'y'.repeat(200)}`).join('\n');
    const w = salientWindows(text, 5, 0);
    expect(w.every(([s, e]) => e - s <= 120)).toBe(true);
    expect(w.reduce((n, [s, e]) => n + e - s, 0)).toBeLessThanOrEqual(400);
    expect(w.length).toBeGreaterThan(1);
  });

  it('leaves a real gap after the head and before the tail (a zero gap is no excerpt)', () => {
    const text = 'id 123456\nid 654321\nfiller\nid 777777';
    // head 10 ends exactly where line 2 starts; the tail starts exactly where line 4 does
    expect(salientWindows(text, 10, 9)).toEqual([]);
    expect(salientWindows(text, 0, 0).every(([s]) => s > 0)).toBe(true);
  });

  it('keeps windows strictly between head and tail', () => {
    const text = 'id 123456 in head\nfiller\nid 654321 mid\nfiller\nid 777777 tail';
    const w = salientWindows(text, 18, 13);
    expect(w.map(([s, e]) => text.slice(s, e))).toEqual(['id 654321 mid']);
  });
});

describe('B: stale_age keeps the lines that carry facts', () => {
  const body = 'line 1\n' + 'filler text\n'.repeat(150) + 'pr #4321 merged as ab12cd34\n' + 'filler text\n'.repeat(150);
  // 100+ rows after the read make it stale (staleAfterMessages 100).
  const later = Array.from({ length: 110 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `turn ${i}`));
  const rulesOnly = makeScorer({ useClaudeScorer: false });

  it('truncates a stale read to its head, the salient line, and one note', async () => {
    const input = [msg('user', 'go'), use('u1', 'Read', { file_path: 'src/a.ts' }), res('u1', body), ...later];
    const out = await compact(input, rulesOnly, {});
    expect(out.decisions[0]).toMatchObject({ action: 'drop_result', rule: 'stale_age' });
    const text = resultOf(out.messages, 'u1');
    expect(text).toContain('pr #4321 merged as ab12cd34');
    expect(notes(text)).toBe(1);
    expect(text.length).toBeLessThan(900);
  });

  it('a second pass leaves the excerpt as it is: never a nested note', async () => {
    const input = [msg('user', 'go'), use('u1', 'Read', { file_path: 'src/a.ts' }), res('u1', body), ...later];
    const once = await compact(input, rulesOnly, {});
    const twice = await compact([...once.messages, ...later], rulesOnly, {});
    const text = resultOf(twice.messages, 'u1');
    expect(notes(text)).toBe(1);
    expect(text).toContain('#4321');
  });

  it('a result an earlier pass cut to a head is re-cut as before, with no windows', async () => {
    const earlier = 'line 1\n' + 'z'.repeat(600) + '\n[verbatim-compaction truncated 5000 chars of this tool result; re-run the tool if needed]';
    const input = [msg('user', 'go'), use('u1', 'Read', { file_path: 'src/a.ts' }), res('u1', earlier), ...later];
    const out = await compact(input, rulesOnly, {});
    const text = resultOf(out.messages, 'u1');
    expect(notes(text)).toBe(1);
    expect(text).not.toContain('omitted');
  });
});
