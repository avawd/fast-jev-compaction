import { describe, expect, it } from 'vitest';
import {
  buildJevPrompt, chunk, collectToolCalls, decide, jevCandidateLine, parseJevReply, stripCdPrefix, type ToolCall,
} from '../src/index.js';

function c(id: string, tool: string, input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id, tool_use_id: `u-${id}`, tool, input, callIndex: 15, resultIndex: 16, resultChars: 4213,
    isError: false, pinned: false, ...extra,
  };
}

describe('stripCdPrefix', () => {
  it('drops a leading cd … && or cd …; and nothing else', () => {
    expect(stripCdPrefix('cd /srv/repo && npm test')).toBe('npm test');
    expect(stripCdPrefix('cd "/a b/c"; git status')).toBe('git status');
    expect(stripCdPrefix('cd /a && cd b && ls')).toBe('ls');
    expect(stripCdPrefix('npm test && cd /a')).toBe('npm test && cd /a');
    expect(stripCdPrefix('cd /only')).toBe('cd /only');
    expect(stripCdPrefix('cdx && ls')).toBe('cdx && ls');
  });
});

describe('jevCandidateLine', () => {
  const ctx = { messageCount: 189 };

  it('shows id, tool, 1-based position, input, outcome, size and a result preview', () => {
    const line = jevCandidateLine(
      c('t12', 'Read', { file_path: 'src/a.ts' }, { resultHead: 'export const a = 1;\nexport const b = 2;' }),
      ctx,
    );
    expect(line).toBe(
      't12 Read msg 16/189 file_path=src/a.ts → ok 4213ch | export const a = 1;⏎export const b = 2;',
    );
  });

  it('shows a Bash command in full, cd prefix stripped, up to 400 chars', () => {
    const short = jevCandidateLine(c('t1', 'Bash', { command: 'cd /repo && npm test', description: 'run' }), ctx);
    expect(short).toContain(' npm test');
    expect(short).not.toContain('cd /repo');
    expect(short).not.toContain('description');
    const long = jevCandidateLine(c('t2', 'Bash', { command: `echo ${'x'.repeat(1000)}` }), ctx);
    const input = long.slice(long.indexOf('echo'), long.indexOf(' → '));
    expect(input.length).toBe(400);
    expect(input.endsWith('…')).toBe(true);
  });

  it('flags errors, and shows ref-later when the stub map knows the call', () => {
    const line = jevCandidateLine(c('t3', 'Grep', { pattern: 'foo' }, { isError: true, resultChars: 20 }), {
      messageCount: 10, refLater: new Map([['t3', 2]]),
    });
    expect(line).toContain('→ error 20ch');
    expect(line).toContain('ref-later:2');
    expect(jevCandidateLine(c('t4', 'Grep', { pattern: 'foo' }), { messageCount: 10, refLater: new Map() }))
      .not.toContain('ref-later');
  });

  it('caps the preview at 80 chars and never ends it on a lone high surrogate', () => {
    const head = `${'a'.repeat(79)}😀tail`;
    const line = jevCandidateLine(c('t5', 'Read', { file_path: 'x' }, { resultHead: head }), ctx);
    const preview = line.slice(line.indexOf(' | ') + 3);
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(/[\uD800-\uDBFF]…?$/.test(preview)).toBe(false);
  });

  it('survives an unserialisable input', () => {
    const input: Record<string, unknown> = {};
    input['self'] = input;
    expect(jevCandidateLine(c('t6', 'X', input), ctx)).toContain('[unserializable input]');
  });
});

describe('buildJevPrompt', () => {
  it('asks Jev\'s two questions with the policy text and the JSON reply shape', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).toContain('Keep the call when its input still matters.');
    expect(prompt).toContain('Keep the result verbatim only when its exact text is still needed and re-running would not do.');
    expect(prompt).toContain('Prefer truncate over drop unless a later call superseded it.');
    expect(prompt).toContain('{"result_needed":[],"call_matters":[],"unsure":[]}');
    expect(prompt).toMatch(/^t1 Read msg 16\/5/m);
  });

  it('asks for lists, never a per-call line or number: the API rejects that shape (probed live, 2.1.281)', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).not.toMatch(/one line per call|digit|0-9|END/);
  });
});

describe('parseJevReply', () => {
  const ids = new Set(['t1', 't2', 't3', 't4']);

  it('reads the three lists, ignoring unknown ids and prose around the object', () => {
    const out = parseJevReply('Here:\n{"result_needed":["t1"],"call_matters":["t2","t9"],"unsure":["t3"]}\nok', ids);
    expect(out && [...out.resultNeeded]).toEqual(['t1']);
    expect(out && [...out.callMatters]).toEqual(['t2']);
    expect(out && [...out.unsure]).toEqual(['t3']);
  });

  it('treats a missing unsure list as empty', () => {
    expect(parseJevReply('{"result_needed":[],"call_matters":["t1"]}', ids)?.unsure.size).toBe(0);
  });

  it('rejects anything that is not the full object: no JSON, a cut-off reply, a missing or mistyped list', () => {
    expect(parseJevReply('nope', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":["t1"],"call_matters":["t2"', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":["t1"]}', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":"t1","call_matters":[]}', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":[],"call_matters":[],"unsure":[1]}', ids)).toBeUndefined();
  });
});

describe('decide', () => {
  const answer = {
    resultNeeded: new Set(['t1', 't4']), callMatters: new Set(['t2', 't4']), unsure: new Set(['t3', 't4']),
  };

  it('result_needed keeps, call_matters truncates, neither drops; the safer list wins an overlap', () => {
    expect(decide('t1', answer, 0.5)).toBe('keep');
    expect(decide('t2', answer, 0.5)).toBe('drop_result');
    expect(decide('t4', answer, 0.5)).toBe('keep');
    expect(decide('t9', answer, 0.5)).toBe('drop_call');
  });

  it('maps unsure through keepThreshold: below 0.5 keep, up to 0.75 truncate, above drop', () => {
    expect(decide('t3', answer, 0.3)).toBe('keep');
    expect(decide('t3', answer, 0.5)).toBe('drop_result');
    expect(decide('t3', answer, 0.75)).toBe('drop_result');
    expect(decide('t3', answer, 0.9)).toBe('drop_call');
  });
});

describe('chunk', () => {
  it('splits into pieces of at most size, in order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 60)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('resultHead', () => {
  it('is the first 200 chars of the paired result, for the preview', () => {
    const calls = collectToolCalls([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'r'.repeat(500) }] },
    ], 0);
    expect(calls[0]?.resultHead).toBe('r'.repeat(200));
    expect(calls[0]?.resultChars).toBe(500);
  });
});
