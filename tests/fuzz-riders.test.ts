/**
 * Rider DETECTION over seeded API views: the shapes 2.1.282's normalizer produces (riders folded into
 * a result's content or left as siblings, several reminders in one block, parallel results hoisted
 * to the front of a merged message, a typed prompt merged in with a trailing newline), each built
 * from a known ground truth. Every truly carried rider must be detected; a result may be protected
 * without one only when it shares an API message with a sibling rider (attribution is ambiguous
 * there by construction).
 */
import { describe, expect, it } from 'vitest';
import { riderProtected, type ApiLike, type Message } from '../src/index.js';
import { chance, int, pick, rng, seedCount, type Rng } from './fuzz-gen.ts';

const SEEDS = seedCount(300);
const sr = (inner: string) => `<system-reminder>\n${inner}\n</system-reminder>`;
const EPHEMERAL = [
  '<total_tokens>12 tokens left</total_tokens>',
  'PostToolUse:Bash hook additional context: verify',
  'UserPromptSubmit hook additional context: caveman',
  "The task tools haven't been used recently.",
];
const REAL = [
  'The user sent a new message while you were working:\nTYPED',
  '<task-notification>done</task-notification>',
  'Contents of /x/CLAUDE.md: rules',
];

/** One rider: its text, and whether losing it matters. */
function rider(r: Rng): { text: string; real: boolean } {
  const parts = Array.from({ length: int(r, 1, 3) }, () => (chance(r, 0.5) ? { t: sr(pick(r, EPHEMERAL)), real: false } : { t: sr(pick(r, REAL)), real: true }));
  // Sometimes plain text outside any reminder (a verified Slack prompt stays plain).
  if (chance(r, 0.1)) parts.push({ t: 'plain typed words', real: true });
  return { text: parts.map((p) => p.t).join('\n'), real: parts.some((p) => p.real) };
}

function viewCase(seed: number) {
  const r = rng(seed ^ 0x51de);
  const rows: Message[] = [];
  const api: ApiLike[] = [];
  const truthCalls = new Set<string>();
  const truthRows = new Set<Message>();
  const ambiguous = new Set<string>();
  for (let turn = 0; turn < int(r, 1, 12); turn += 1) {
    const ids = Array.from({ length: chance(r, 0.3) ? int(r, 2, 4) : 1 }, (_, k) => `c${turn}_${k}`);
    rows.push({ role: 'assistant', text: '', toolUses: ids.map((id) => ({ tool_use_id: id, tool: 'Bash', input: {} })) });
    api.push({ role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: {} })) });
    const results: Array<Record<string, unknown>> = [];
    const siblings: Array<Record<string, unknown>> = [];
    let siblingReal = false;
    for (const id of ids) {
      const out = `output of ${id} ${'x'.repeat(int(r, 0, 40))}`;
      rows.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: out }] });
      let content: unknown = out;
      if (chance(r, 0.4)) {
        const rd = rider(r);
        if (rd.real) truthCalls.add(id);
        if (chance(r, 0.6)) content = chance(r, 0.5) ? `${out}\n${rd.text}` : [{ type: 'text', text: out }, { type: 'text', text: rd.text }];
        else {
          siblings.push({ type: 'text', text: rd.text });
          siblingReal ||= rd.real;
        }
      }
      results.push({ type: 'tool_result', tool_use_id: id, content });
    }
    if (siblingReal) for (const id of ids) ambiguous.add(id);
    const blocks = [...results, ...siblings];
    // A typed prompt merged into the same API message, maybe with its own rider after it.
    if (chance(r, 0.3)) {
      const typed: Message = { role: 'user', text: `typed prompt ${turn}`, toolUses: [] };
      rows.push(typed);
      blocks.push({ type: 'text', text: chance(r, 0.5) ? `${typed.text}\n` : typed.text });
      if (chance(r, 0.5)) {
        const rd = rider(r);
        if (rd.real) truthRows.add(typed);
        blocks.push({ type: 'text', text: rd.text });
      }
    }
    api.push({ role: 'user', content: blocks });
  }
  return { rows, api, truthCalls, truthRows, ambiguous };
}

describe('fuzz: rider detection', () => {
  it(`detects every carried rider and protects nothing unexplained over ${SEEDS} seeds`, () => {
    const failures: string[] = [];
    let carried = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const c = viewCase(seed);
      const found = riderProtected(c.api, c.rows);
      carried += c.truthCalls.size + c.truthRows.size;
      for (const id of c.truthCalls) if (!found.callIds.has(id)) failures.push(`seed ${seed}: missed rider on ${id}`);
      for (const m of c.truthRows) if (!found.rows.has(m)) failures.push(`seed ${seed}: missed rider on "${m.text}"`);
      for (const id of found.callIds) if (!c.truthCalls.has(id) && !c.ambiguous.has(id)) failures.push(`seed ${seed}: ${id} protected without a rider`);
      for (const m of found.rows) if (!c.truthRows.has(m)) failures.push(`seed ${seed}: "${m.text}" protected without a rider`);
    }
    expect({ failures: failures.slice(0, 20), total: failures.length }).toEqual({ failures: [], total: 0 });
    expect(carried).toBeGreaterThan(SEEDS / 2);
  });
});
