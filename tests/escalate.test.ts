import { describe, expect, it } from 'vitest';
import { compact, gateOutcome, gateRatio, makeScorer, TRUNCATION_NOTE_PREFIX, type Message } from '../src/index.js';

/**
 * A long session compacts many times. Replayed over the corpus (eval/replay.ts), a pass over an
 * already-compacted transcript misses the gate far more often than a first pass: the old output is
 * already cut, so only what arrived since is prunable. Before handing such a transcript to the
 * summary (which loses every verbatim fact), compact() tries once more with a stricter tier.
 */

const note = (n: number) => `${TRUNCATION_NOTE_PREFIX} ${n} chars of this tool result; re-run the tool if needed]`;
function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function use(id: string, tool: string, input: Record<string, unknown>): Message {
  return msg('assistant', '', { toolUses: [{ tool_use_id: id, tool, input }] });
}
function res(id: string, text: string): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text }] });
}
const filler = (n: number): Message[] => Array.from({ length: n }, (_, i) => msg(i % 2 ? 'user' : 'assistant', `turn ${i}`));
const rules = makeScorer({ useClaudeScorer: false, maxCandidates: 400 });
const results = (ms: readonly Message[]) => new Map(ms.flatMap((m) => (m.toolResults ?? []).map((r) => [r.tool_use_id, r.text] as const)));

/**
 * An earlier pass's stubs (old), then a fresh Read 60 rows old: stale at tier 2's half age (50) but
 * not at the default 100, so the first try saves nothing and misses a 0.25 gate.
 */
function compacted(): Message[] {
  const stubs = Array.from({ length: 10 }, (_, i) => [
    use(`s${i}`, 'Read', { file_path: `/srv/app/old${i}.ts` }),
    res(`s${i}`, `${'o'.repeat(300)}\n${note(5000)}`),
  ]).flat();
  return [
    msg('user', 'go'),
    ...stubs,
    // Not a file read, so stale_age never applies: only tier 2's stale_truncation re-cuts it.
    use('p1', 'Bash', { command: 'git push origin main' }),
    res('p1', `${'p'.repeat(300)}\n${note(4000)}`),
    ...filler(60),
    use('f1', 'Read', { file_path: '/srv/app/fresh.ts' }),
    res('f1', 'f'.repeat(6000)),
    ...filler(60),
  ];
}

describe('tier-2 escalation', () => {
  it('re-runs a compacted transcript that misses the gate with halved age, head and tail', async () => {
    const plain = await compact(compacted(), rules, {});
    expect(gateRatio(plain)).toBeLessThan(0.25);
    const out = await compact(compacted(), rules, { escalateBelow: 0.25 });
    expect(out.stats.tier).toBe(2);
    expect(gateRatio(out)).toBeGreaterThanOrEqual(0.25);
    const after = results(out.messages);
    // The fresh read went stale at half age and was cut to half the head.
    expect(after.get('f1')!.startsWith(`${'f'.repeat(150)}\n${TRUNCATION_NOTE_PREFIX}`)).toBe(true);
    // The old stubs, stale at tier 2's age, lose half their head; their count still adds up.
    expect(after.get('s0')).toBe(`${'o'.repeat(150)}\n${note(5150)}`);
    // A push is log-like (it would keep a tail), but its first cut kept none: no tail to keep now.
    expect(after.get('p1')).toBe(`${'p'.repeat(150)}\n${note(4150)}`);
    expect(out.decisions.find((d) => d.tool === 'Bash')).toMatchObject({ action: 'drop_result', rule: 'stale_truncation' });
  });

  it('never escalates a first compaction (nothing truncated yet)', async () => {
    const fresh = compacted().map((m) => (m.toolResults?.[0]?.text.includes(TRUNCATION_NOTE_PREFIX) ? res(m.toolResults[0].tool_use_id, 'o'.repeat(300)) : m));
    const out = await compact(fresh, rules, { escalateBelow: 0.25 });
    expect(out.stats.tier).toBeUndefined();
  });

  it('never escalates without escalateBelow, or when the first try clears it', async () => {
    expect((await compact(compacted(), rules, {})).stats.tier).toBeUndefined();
    expect((await compact(compacted(), rules, { escalateBelow: 0 })).stats.tier).toBeUndefined();
  });

  it('keeps pins: a result whose token is quoted later keeps it through tier 2', async () => {
    const input = compacted();
    const at = input.findIndex((m) => m.toolResults?.[0]?.tool_use_id === 'f1');
    input[at] = res('f1', `${'f'.repeat(3000)} sha 4be1c0de9a ${'f'.repeat(3000)}`);
    input.push(msg('assistant', 'Deployed 4be1c0de9a.'));
    input.push(...filler(6));
    const out = await compact(input, rules, { escalateBelow: 0.9 });
    expect(results(out.messages).get('f1')).toContain('4be1c0de9a');
  });

  it('never calls the scorer twice', async () => {
    let calls = 0;
    const counting: typeof rules = async (c) => {
      calls += 1;
      return rules(c);
    };
    await compact(compacted(), counting, { escalateBelow: 0.25 });
    expect(calls).toBe(1);
  });
});

describe('gateOutcome', () => {
  it('prunes at or over the gate, whatever asked', () => {
    for (const trigger of ['auto', 'manual', 'plugin', 'precompute']) expect(gateOutcome(0.3, 0.25, trigger)).toBe('prune');
  });

  it('below the gate: the plugin\'s own early request skips; everything else gets the summary', () => {
    expect(gateOutcome(0.1, 0.25, 'plugin')).toBe('skip');
    expect(gateOutcome(0.1, 0.25, 'auto')).toBe('summary');
    expect(gateOutcome(0.1, 0.25, 'manual')).toBe('summary');
    expect(gateOutcome(0.1, 0.25, 'precompute')).toBe('summary');
  });
});
