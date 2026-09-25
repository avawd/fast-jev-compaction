import { describe, expect, it } from 'vitest';
import { attributeLive, decisionLabel, factFate, liveVerdict, strataLines } from './diagnose.ts';
import type { EvalMessage } from './parse.ts';

const result = (id: string, text: string): EvalMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text }] });
const original = 'head part\n' + 'x'.repeat(500) + '\nvalue 777123 here\n' + 'y'.repeat(500) + '\ntail line';

describe('factFate', () => {
  it('whole: the result is untouched', () => {
    expect(factFate('777123', 'u1', original, [result('u1', original)], false)).toMatchObject({ inContext: true, how: 'whole' });
  });
  it('dropped: no result for the call remains', () => {
    const f = factFate('777123', 'u1', original, [result('u2', 'other')], false, { action: 'drop_call', source: 'rule', rule: 'repeated_search' });
    expect(f).toMatchObject({ inContext: false, how: 'dropped', by: 'rule:repeated_search' });
  });
  it('truncated-cut: the note is there and the token fell outside head and tail', () => {
    const cut = 'head part\n[verbatim-compaction truncated 1000 chars of this tool result; re-run the tool if needed]\ntail line';
    const f = factFate('777123', 'u1', original, [result('u1', cut)], false, { action: 'drop_result', source: 'claude' });
    expect(f).toMatchObject({ inContext: false, how: 'truncated-cut', by: 'claude' });
    expect(f.detail).toMatch(/at 5\d\d\/\d+; kept head 9 \+ tail 9/);
  });
  it('truncated-kept: the window still holds the token', () => {
    const kept = original.slice(0, 530) + '\n[verbatim-compaction truncated 10 chars of this tool result; re-run the tool if needed]';
    expect(factFate('777123', 'u1', original, [result('u1', kept)], false).how).toBe('truncated-kept');
  });
  it('stripped, not cut: a truncated result lost a token that sat inside the kept head (furniture went first)', () => {
    const json = '{ "self": "https://h.test/rest/1234567", "id": 1, ' + 'z'.repeat(900) + ' }';
    const kept = '{ "id": 1, ' + 'z'.repeat(100) + '\n[verbatim-compaction truncated 800 chars of this tool result; re-run the tool if needed]';
    expect(factFate('https://h.test/rest/1234567', 'u1', json, [result('u1', kept)], false, { action: 'drop_result', source: 'rule', rule: 'mcp_write_echo' })).toMatchObject({
      how: 'stripped',
      by: 'stripMcpFurniture',
    });
  });
  it('stripped: the result is present without a note but lost the token (MCP furniture)', () => {
    expect(factFate('777123', 'u1', original, [result('u1', 'head part')], false).how).toBe('stripped');
  });
  it('summary: kept or lost by the built-in summary', () => {
    const summary: EvalMessage = { role: 'user', text: 'summary mentions 777123', toolUses: [] };
    expect(factFate('777123', 'u1', original, [summary], true)).toMatchObject({ inContext: true, how: 'summary-kept', by: 'built-in summary' });
    expect(factFate('999999', 'u1', original, [summary], true)).toMatchObject({ inContext: false, how: 'summary-lost' });
  });
});

describe('decisionLabel / attributeLive', () => {
  it('names who decided', () => {
    expect(decisionLabel({ action: 'drop_result', source: 'rule', rule: 'stale_age' })).toBe('rule:stale_age');
    expect(decisionLabel({ action: 'keep', source: 'pinned' })).toBe('pinned');
    expect(decisionLabel(undefined)).toBe('unknown');
  });
  it('credits a live loss to the rule when the rules arm made the same cut, else to Claude', () => {
    expect(attributeLive('dropped', { action: 'drop_call', source: 'rule', rule: 'repeated_search' })).toBe('rule:repeated_search');
    expect(attributeLive('truncated-cut', { action: 'keep', source: 'default' })).toBe('claude');
    expect(attributeLive('truncated-cut', undefined)).toBe('claude');
    expect(attributeLive('whole', { action: 'keep', source: 'default' })).toBe('-');
    expect(attributeLive('stripped', undefined)).toBe('stripMcpFurniture');
  });
});

describe('liveVerdict', () => {
  it('orders the explanations: stale set, model miss, then the cut', () => {
    expect(liveVerdict({ hit: true, before: true, after: true, how: 'whole', by: '-' })).toBe('recalled');
    expect(liveVerdict({ hit: false, before: false, after: false, how: 'dropped', by: 'claude' })).toBe('not in pre-compact context');
    expect(liveVerdict({ hit: false, before: true, after: true, how: 'truncated-kept', by: 'claude' })).toBe('in context, model missed');
    expect(liveVerdict({ hit: false, before: true, after: false, how: 'truncated-cut', by: 'rule:stale_age', detail: 'at 5/9' })).toBe('truncated-cut by rule:stale_age (at 5/9)');
    expect(liveVerdict({ hit: true, before: true, after: false, how: 'summary-lost', by: 'built-in summary' })).toBe('recalled (not in context: guessed or re-derived)');
  });
});

describe('strataLines', () => {
  it('counts per stratum and column', () => {
    const f = (category: string) => ({ category }) as never;
    const lines = strataLines([{ fact: f('Bash'), ok: { a: true } }, { fact: f('Bash'), ok: { a: false } }, { fact: f('Read'), ok: { a: true } }], ['a'], (x: { category: string }) => x.category);
    expect(lines.slice(2)).toEqual(['| Bash | 2 | 1/2 (50%) |', '| Read | 1 | 1/1 (100%) |']);
  });
});
