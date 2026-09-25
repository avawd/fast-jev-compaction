import { describe, expect, it } from 'vitest';
import { wellFormed } from './fuzz-gen.ts';
import { excerptPlan, renderTruncation, TRUNCATION_NOTE_PREFIX, type ExcerptPlan } from '../src/index.js';

/** Lines of `width` filler characters, `count` of them, each ending in a newline. */
const lines = (count: number, width = 60, fill = 'x') => `${fill.repeat(width)}\n`.repeat(count);

/** Reads a rendered excerpt back into its kept pieces and gaps, so tests can check offsets. */
function pieces(rendered: string): { head: string; parts: Array<{ gap: number; text: string }>; total: number } {
  const at = rendered.indexOf(TRUNCATION_NOTE_PREFIX);
  const close = rendered.indexOf(']', at);
  const total = Number(/truncated (\d+) chars/.exec(rendered.slice(at, close))![1]);
  const head = at === 0 ? '' : rendered.slice(0, at - 1);
  const rest = rendered.slice(close + 1);
  const parts: Array<{ gap: number; text: string }> = [];
  const marker = /\n\[… (\d+) chars omitted …\](?:\n|$)/g;
  const found = [...rest.matchAll(marker)];
  found.forEach((m, k) => {
    const start = m.index! + m[0].length;
    const end = found[k + 1]?.index ?? rest.length;
    parts.push({ gap: Number(m[1]), text: rest.slice(start, end) });
  });
  return { head, parts, total };
}

/** Rebuilds where every kept piece came from and checks it against the source. */
function checkAgainst(source: string, rendered: string): void {
  const { head, parts, total } = pieces(rendered);
  expect(source.startsWith(head)).toBe(true);
  let at = head.length;
  let omitted = 0;
  for (const part of parts) {
    at += part.gap;
    omitted += part.gap;
    expect(source.slice(at, at + part.text.length)).toBe(part.text);
    at += part.text.length;
  }
  expect(at).toBe(source.length);
  expect(omitted).toBe(total);
}

describe('excerptPlan', () => {
  it('keeps the head plus a line-snapped window around a token out of the head\'s reach', () => {
    const text = `${lines(100)}the sha is deadbeef1234 here\n${lines(100)}`;
    const plan = excerptPlan(text, ['deadbeef1234'], 300, 0)!;
    expect(plan.head).toBe(300);
    expect(plan.tail).toBe(0);
    expect(plan.windows).toHaveLength(1);
    const [start, end] = plan.windows[0]!;
    const window = text.slice(start, end);
    expect(window).toContain('the sha is deadbeef1234 here');
    // Whole lines: starts after a newline and ends before one.
    expect(text[start - 1]).toBe('\n');
    expect(text[end]).toBe('\n');
    expect(end - start).toBeLessThanOrEqual(2 * 200 + 'deadbeef1234'.length);
  });

  it('cuts a long line at the radius instead of keeping it whole', () => {
    const text = `${'a'.repeat(5000)}deadbeef1234${'b'.repeat(5000)}`;
    const plan = excerptPlan(text, ['deadbeef1234'], 300, 0)!;
    expect(plan.windows).toEqual([[4800, 5212]]);
  });

  it('merges windows that overlap or nearly touch, and adds none for a token the head or tail holds', () => {
    const text = `HEADTOKEN_abc123 ${lines(100)}one TOKEN_A_111111\ntwo TOKEN_B_222222\n${lines(100)}TAILTOKEN_xyz789`;
    const plan = excerptPlan(text, ['HEADTOKEN_abc123', 'TOKEN_A_111111', 'TOKEN_B_222222', 'TAILTOKEN_xyz789'], 300, 1000)!;
    expect(plan.windows).toHaveLength(1);
    const [start, end] = plan.windows[0]!;
    expect(text.slice(start, end)).toContain('TOKEN_A_111111\ntwo TOKEN_B_222222');
  });

  it('folds a window that reaches the head into a longer head', () => {
    const text = `${'h'.repeat(290)}\nnear deadbeef1234\n${lines(200)}`;
    const plan = excerptPlan(text, ['deadbeef1234'], 300, 0)!;
    expect(plan.windows).toEqual([]);
    expect(text.slice(0, plan.head)).toContain('deadbeef1234');
  });

  it('gives up when the windows would keep more than the cap', () => {
    const tokens = Array.from({ length: 30 }, (_, k) => `TOKEN_${String(k).padStart(8, '0')}`);
    const text = tokens.map((t) => `${lines(20)}${t}\n`).join('') + lines(20);
    expect(excerptPlan(text, tokens, 300, 0)).toBeUndefined();
    expect(excerptPlan(text, tokens.slice(0, 3), 300, 0)?.windows).toHaveLength(3);
  });

  it('gives up when excerpting would not shrink the text', () => {
    const text = `${'h'.repeat(300)}${'m'.repeat(200)}deadbeef1234${'t'.repeat(50)}`;
    expect(excerptPlan(text, ['deadbeef1234'], 300, 0)).toBeUndefined();
  });

  it('never cuts a surrogate pair at a window edge', () => {
    // 😀 is two UTF-16 units; odd offsets land on its low half.
    for (const [shift, token] of [[0, 'deadbeef1234'], [1, 'deadbeef1234'], [0, 'deadbeef12345'], [1, 'deadbeef12345']] as const) {
      const text = `${'😀'.repeat(3000)}${'x'.repeat(shift)}${token}${'😀'.repeat(3000)}`;
      const plan = excerptPlan(text, [token], 301, 301)!;
      const rendered = renderTruncation(text, false, plan);
      expect(wellFormed(rendered), `${shift} ${token}`).toBe(true);
      expect(rendered).toContain(token);
      checkAgainst(text, rendered);
    }
  });
});

describe('renderTruncation', () => {
  it('renders head, note, elided gaps, windows and tail, and reads back to the source offsets', () => {
    const text = `${lines(100)}one TOKEN_A_111111\n${lines(100)}two TOKEN_B_222222\n${lines(100)}`;
    const plan = excerptPlan(text, ['TOKEN_A_111111', 'TOKEN_B_222222'], 300, 500)!;
    const rendered = renderTruncation(text, true, plan);
    expect(rendered).toContain('TOKEN_A_111111');
    expect(rendered).toContain('TOKEN_B_222222');
    expect(rendered).toContain('(error)');
    expect(rendered).toMatch(/re-run the tool if needed\]/);
    expect(rendered.length).toBeLessThan(text.length);
    expect(pieces(rendered).parts).toHaveLength(3);
    checkAgainst(text, rendered);
  });

  it('ends with an omitted marker when no tail is kept', () => {
    const text = `${lines(100)}one TOKEN_A_111111\n${lines(100)}`;
    const plan = excerptPlan(text, ['TOKEN_A_111111'], 0, 0)!;
    const rendered = renderTruncation(text, false, plan);
    expect(rendered.startsWith(TRUNCATION_NOTE_PREFIX)).toBe(true);
    expect(rendered).toMatch(/chars omitted …\]$/);
    checkAgainst(text, rendered);
  });

  it('is the plain head + note + tail form when there are no windows', () => {
    const text = 'a'.repeat(2000);
    const plain: ExcerptPlan = { head: 100, tail: 100, windows: [] };
    expect(renderTruncation(text, false, plain)).toBe(
      `${'a'.repeat(100)}\n${TRUNCATION_NOTE_PREFIX} 1800 chars of this tool result; re-run the tool if needed]\n${'a'.repeat(100)}`,
    );
  });
});
