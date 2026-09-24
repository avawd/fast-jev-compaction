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
  it('states the two questions, the policy, the reply format and the sentinel', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).toContain('Keep the call when its input still matters.');
    expect(prompt).toContain('Keep the result verbatim only when its exact text is still needed and re-running would not do.');
    expect(prompt).toContain('Prefer truncate over drop unless a later call superseded it.');
    expect(prompt).toMatch(/t12 93/);
    expect(prompt).toContain('last line "END"');
    expect(prompt).toMatch(/^t1 Read msg 16\/5/m);
  });
});

describe('parseJevReply', () => {
  const ids = new Set(['t1', 't2', 't3']);

  it('reads compact score lines terminated by END', () => {
    const out = parseJevReply('t1 93\nt2 00\nEND', ids);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.scores.get('t1')).toEqual({ call: 9, result: 3 });
    expect(out.scores.get('t2')).toEqual({ call: 0, result: 0 });
    expect(out.scores.has('t3')).toBe(false);
  });

  it('tolerates spacing, a space between the digits, fences and prose around the lines', () => {
    const out = parseJevReply('Here:\n```\n  t1   9 3  \nt3 55\n```\nEND\n', ids);
    expect(out.ok && out.scores.size).toBe(2);
  });

  it('ignores unknown ids and malformed lines; a repeated id keeps the higher digits', () => {
    const out = parseJevReply('t9 00\nt1 9\nt1 x3\nt2 13\nt2 40\nEND', ids);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect([...out.scores.keys()]).toEqual(['t2']);
    expect(out.scores.get('t2')).toEqual({ call: 4, result: 3 });
  });

  it('accepts END with no lines: every call is kept', () => {
    const out = parseJevReply('END', ids);
    expect(out.ok && out.scores.size).toBe(0);
  });

  it('rejects a reply without END when it does not cover every id (a cut-off reply is never applied partially)', () => {
    expect(parseJevReply('t1 00\nt2 00', ids)).toEqual({ ok: false, reason: 'no-sentinel' });
    expect(parseJevReply('', ids)).toEqual({ ok: false, reason: 'no-sentinel' });
  });

  it('accepts a reply without END when every id was scored (nothing can have been cut off)', () => {
    const out = parseJevReply('t1 00\nt2 11\nt3 99', ids);
    expect(out.ok && out.scores.size).toBe(3);
  });

  it('ignores lines after END', () => {
    const out = parseJevReply('t1 99\nEND\nt2 00', ids);
    expect(out.ok && [...out.scores.keys()]).toEqual(['t1']);
  });
});

describe('decide', () => {
  it('keeps on result ≥ threshold, truncates on call ≥ threshold, else drops', () => {
    expect(decide({ call: 0, result: 5 }, 0.5)).toBe('keep');
    expect(decide({ call: 9, result: 4 }, 0.5)).toBe('drop_result');
    expect(decide({ call: 5, result: 0 }, 0.5)).toBe('drop_result');
    expect(decide({ call: 4, result: 4 }, 0.5)).toBe('drop_call');
  });
  it('maps digits onto the 0..1 threshold as d/9', () => {
    expect(decide({ call: 0, result: 9 }, 1)).toBe('keep');
    expect(decide({ call: 8, result: 8 }, 0.9)).toBe('drop_call');
    expect(decide({ call: 0, result: 0 }, 0)).toBe('keep');
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
