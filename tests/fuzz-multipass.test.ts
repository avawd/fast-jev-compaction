/**
 * A long session compacts many times: the second pass is handed the first pass's output. Over
 * seeded transcripts, compacts once with the integrity suite's setup, then again with a random
 * scorer and random (often smaller) windows, and checks what the second pass may never do.
 * `FUZZ_SEEDS=5000 npx vitest run tests/fuzz-multipass.test.ts` for a long run.
 */
import { describe, expect, it } from 'vitest';
import { compact, TRUNCATION_NOTE_PREFIX, type CompactOptions, type Message, type Scorer, type Verdict } from '../src/index.js';
import { runCase } from './fuzz-check.ts';
import { chance, genTranscript, int, pick, rng, seedCount } from './fuzz-gen.ts';

const SEEDS = seedCount(300);

function secondScorer(seed: number): Scorer {
  return async (calls) => {
    const r = rng(seed ^ 0x2545f491);
    const verdicts = new Map<string, Verdict>();
    for (const c of calls) {
      if (!chance(r, 0.8)) continue;
      verdicts.set(c.id, { action: chance(r, 0.3) ? 'drop_call' : 'drop_result', source: 'claude' });
    }
    return { verdicts, claude: 'ran' };
  };
}

function results(messages: readonly Message[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) for (const r of m.toolResults ?? []) out.set(r.tool_use_id, r.text);
  return out;
}

const NOTE = /\[verbatim-compaction truncated (\d+) chars of this tool result(?: \(error\))?; re-run the tool if needed\]/g;

/** Head, tail and count of a text holding exactly one note. */
function split(text: string): { head: string; tail: string; count: number } | undefined {
  const found = [...text.matchAll(NOTE)];
  if (found.length !== 1) return undefined;
  const m = found[0]!;
  const head = m.index === 0 ? '' : text.slice(0, m.index - 1);
  const close = m.index + m[0].length;
  const tail = close === text.length ? '' : text.slice(close + 1);
  return { head, tail, count: Number(m[1]) };
}

/** Why an excerpt does not account for `src` exactly, or undefined when it does. */
function excerptAccount(src: string, text: string): string | undefined {
  const m = NOTE.exec(text);
  NOTE.lastIndex = 0;
  if (!m) return 'excerpt without a note';
  const head = m.index === 0 ? '' : text.slice(0, m.index - 1);
  const rest = text.slice(m.index + m[0].length + 1).split('\n');
  let at = head.length;
  let gaps = 0;
  if (!src.startsWith(head)) return 'excerpt head is not the start';
  // After the note: marker, piece lines..., marker, piece..., [marker], [tail]. Rebuild by markers.
  const joined = rest.join('\n');
  const pieces = joined.split(/\n?\[… (\d+) chars omitted …\]\n?/);
  // pieces: [before-first-marker(''), n1, piece1, n2, piece2, ..., nk, tail]
  if (pieces[0] !== '') return 'text between the note and the first gap marker';
  for (let i = 1; i < pieces.length; i += 2) {
    at += Number(pieces[i]);
    gaps += Number(pieces[i]);
    const piece = pieces[i + 1] ?? '';
    if (src.slice(at, at + piece.length) !== piece) return `excerpt piece ${i} is not the original at ${at}`;
    at += piece.length;
  }
  if (gaps !== Number(m[1])) return `note says ${m[1]}, gap markers ${gaps}`;
  return at === src.length ? undefined : `excerpt accounts for ${at} of ${src.length} chars`;
}

function check(seed: number, original: Map<string, string>, first: Map<string, string>, second: Map<string, string>): string[] {
  const fail: string[] = [];
  for (const [id, text] of second) {
    const n = text.split(TRUNCATION_NOTE_PREFIX).length - 1;
    const was = first.get(id) ?? '';
    const wasN = was.split(TRUNCATION_NOTE_PREFIX).length - 1;
    if (n > Math.max(1, wasN)) fail.push(`${id}: ${n} notes after the second pass (${wasN} before)`);
    const src = original.get(id);
    const parts = split(text);
    const firstParts = split(was);
    // Where the first pass only cut (no MCP rewrite), the second pass's one note still accounts for
    // the ORIGINAL result exactly: its head starts it, its tail ends it, its count is the rest.
    const cutOnly =
      src !== undefined &&
      !src.includes(TRUNCATION_NOTE_PREFIX) &&
      (wasN === 0
        ? was === src
        : !!firstParts && src.startsWith(firstParts.head) && src.endsWith(firstParts.tail) &&
          firstParts.count === src.length - firstParts.head.length - firstParts.tail.length);
    const excerpt = /\[… \d+ chars omitted …\]/.test(text);
    if (excerpt && cutOnly && wasN === 0) {
      // Excerpted by the second pass (excerpt.ts): its pieces are the original's, in order, and
      // the gap markers account for exactly what they skip, and the note for their sum.
      const f = excerptAccount(src!, text);
      if (f) fail.push(`${id}: ${f}`);
    } else if (parts && cutOnly) {
      if (!src.startsWith(parts.head)) fail.push(`${id}: head is not the original result's start`);
      if (!src.endsWith(parts.tail)) fail.push(`${id}: tail is not the original result's end`);
      if (parts.count !== src.length - parts.head.length - parts.tail.length) {
        fail.push(`${id}: note says ${parts.count}, original ${src.length} - head ${parts.head.length} - tail ${parts.tail.length}`);
      }
    }
    if (wasN === 1 && text.length > was.length) fail.push(`${id}: grew on the second pass`);

  }
  return fail.map((f) => `seed ${seed}: ${f}`);
}

function blobOf(messages: readonly Message[]): string {
  return messages.map((m) => [m.text, ...m.toolUses.map((u) => JSON.stringify(u.input)), ...(m.toolResults ?? []).map((r) => r.text)].join('\n')).join('\n');
}

/** A token a text row quotes, held before that row after the first pass, is still held before it after the second. */
function pinsHeld(seed: number, first: readonly Message[], second: readonly Message[], quotes: ReadonlyArray<{ token: string; row: Message }>): string[] {
  const fail: string[] = [];
  for (const q of quotes) {
    const i1 = first.indexOf(q.row);
    const i2 = second.indexOf(q.row);
    if (i1 < 0 || i2 < 0) continue;
    if (blobOf(first.slice(0, i1)).includes(q.token) && !blobOf(second.slice(0, i2)).includes(q.token)) {
      fail.push(`seed ${seed}: pinned token ${q.token} lost before its quote on the second pass`);
    }
  }
  return fail;

}

describe('fuzz: a second compaction over the first one\'s output', () => {
  it(`never nests notes, keeps counts exact, and keeps pins over ${SEEDS} seeds`, async () => {
    const failures: string[] = [];
    let escalated = 0;
    let excerptsCarried = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const transcript = genTranscript(seed);
      const run = await runCase(seed, transcript);
      if (run.setup.options.pinReferenced === false) continue;
      const r = rng(Math.imul(seed, 31) + 7);
      const options: CompactOptions = {
        ...run.setup.options,
        truncateHeadChars: pick(r, [0, 50, 100, 300]),
        truncateTailChars: pick(r, [0, 200, 1000]),
        staleAfterMessages: int(r, 2, 60),
        // Tier 2 (src/escalate.ts) too: it re-cuts old truncations, so it must keep every invariant.
        ...(chance(r, 0.6) ? { escalateBelow: pick(r, [0.25, 0.9]) } : {}),
      };
      const second = await compact(run.result.messages, secondScorer(seed), options);
      if (second.stats.tier === 2) escalated += 1;
      for (const t of results(run.result.messages).values()) if (t.includes('chars omitted …]')) excerptsCarried += 1;
      failures.push(...check(seed, results(transcript.messages), results(run.result.messages), results(second.messages)));
      // Text quotes only: a tool-input quote can go with its call, and then nothing refers to the token.
      const quotes = transcript.quotes.flatMap((q) => (q.kind === 'text' ? [{ token: q.token, row: q.row as Message }] : []));
      failures.push(...pinsHeld(seed, run.result.messages, second.messages, quotes));
    }
    expect({ failures: failures.slice(0, 25), total: failures.length }).toEqual({ failures: [], total: 0 });
    expect(escalated).toBeGreaterThan(SEEDS / 20);
    // First-pass excerpts reach the second pass, so the invariants above cover re-compacting them.
    expect(excerptsCarried).toBeGreaterThan(0);
  }, Math.max(60_000, SEEDS * 100));
});
