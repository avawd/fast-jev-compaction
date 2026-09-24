import { describe, expect, it } from 'vitest';
import { applyRules, canonicalJson, normalizePath, type ToolCall } from '../src/index.js';

let n = 0;
function c(tool: string, input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
  n += 1;
  return {
    id: `t${n}`, tool_use_id: `u${n}`, tool, input, callIndex: n, resultIndex: n,
    resultChars: 1000, isError: false, pinned: false, ...extra,
  };
}
function fresh(): void { n = 0; }

describe('applyRules', () => {
  it('truncates a read of a file that is later edited or re-read', () => {
    fresh();
    const calls = [
      c('Read', { file_path: './src/a.ts' }),
      c('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }),
      c('Read', { file_path: 'src/b.ts' }),
      c('Read', { file_path: 'src/b.ts' }),
    ];
    const v = applyRules(calls);
    expect(v.get('t1')).toEqual({ action: 'drop_result', source: 'rule', rule: 'stale_read', evidence: 't2' });
    expect(v.get('t3')).toEqual({ action: 'drop_result', source: 'rule', rule: 'stale_read', evidence: 't4' });
    expect(v.has('t2')).toBe(false);
    expect(v.has('t4')).toBe(false);
  });

  it('drops an older identical search, regardless of key order', () => {
    fresh();
    const calls = [
      c('Grep', { pattern: 'foo', path: 'src' }),
      c('Grep', { path: 'src', pattern: 'foo' }),
      c('Grep', { pattern: 'bar', path: 'src' }),
    ];
    const v = applyRules(calls);
    expect(v.get('t1')).toEqual({ action: 'drop_call', source: 'rule', rule: 'repeated_search', evidence: 't2' });
    expect(v.size).toBe(1);
  });

  it('drops a failed call that was later retried with the same input and succeeded', () => {
    fresh();
    const calls = [
      c('Bash', { command: 'npm test' }, { isError: true }),
      c('Bash', { command: 'npm test' }),
      c('Bash', { command: 'npm run build' }, { isError: true }),
    ];
    const v = applyRules(calls);
    expect(v.get('t1')).toEqual({ action: 'drop_call', source: 'rule', rule: 'failed_then_fixed', evidence: 't2' });
    expect(v.has('t3')).toBe(false);
  });

  it('never targets a pinned call but uses one as evidence', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'src/a.ts' }, { pinned: true }),
      c('Read', { file_path: 'src/b.ts' }),
      c('Edit', { file_path: 'src/b.ts' }, { pinned: true }),
      c('Read', { file_path: 'src/a.ts' }),
    ];
    const v = applyRules(calls);
    expect(v.has('t1')).toBe(false);
    expect(v.get('t2')?.rule).toBe('stale_read');
  });

  it('does not count a failed write as evidence', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'src/a.ts' }),
      c('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, { isError: true }),
    ];
    expect(applyRules(calls).size).toBe(0);
  });

  it('does not count a later ranged read as evidence', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'src/a.ts', offset: 1, limit: 50 }),
      c('Read', { file_path: 'src/a.ts', offset: 900, limit: 50 }),
    ];
    expect(applyRules(calls).size).toBe(0);
  });

  it('does not count a later PDF page-range read as evidence', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'doc/spec.pdf' }),
      c('Read', { file_path: 'doc/spec.pdf', pages: '3-5' }),
    ];
    expect(applyRules(calls).size).toBe(0);
  });

  it('makes a ranged read stale after a later full read', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'src/a.ts', offset: 1, limit: 50 }),
      c('Read', { file_path: 'src/a.ts' }),
    ];
    expect(applyRules(calls).get('t1')?.rule).toBe('stale_read');
  });

  it('makes a read stale after a later successful edit', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'src/a.ts', offset: 1, limit: 50 }),
      c('Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }),
    ];
    expect(applyRules(calls).get('t1')?.rule).toBe('stale_read');
  });

  it('records the nearest later call as evidence', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'src/a.ts' }),
      c('Read', { file_path: 'src/a.ts' }),
      c('Edit', { file_path: 'src/a.ts' }),
      c('Grep', { pattern: 'x' }),
      c('Grep', { pattern: 'x' }),
      c('Grep', { pattern: 'x' }),
    ];
    const v = applyRules(calls);
    expect(v.get('t1')?.evidence).toBe('t2');
    expect(v.get('t2')?.evidence).toBe('t3');
    expect(v.get('t4')?.evidence).toBe('t5');
    expect(v.get('t5')?.evidence).toBe('t6');
  });

  it('survives an input canonicalJson cannot encode (L3), and still judges the rest', () => {
    fresh();
    const cyclic: Record<string, unknown> = { pattern: 'x' };
    cyclic['self'] = cyclic;
    const calls = [
      c('Grep', cyclic),
      c('Grep', cyclic),
      c('Bash', { command: 'n', big: 10n as unknown }),
      c('Read', { file_path: 'src/a.ts' }),
      c('Read', { file_path: 'src/a.ts' }),
    ];
    const v = applyRules(calls);
    expect(v.has('t1')).toBe(false);
    expect(v.get('t4')?.rule).toBe('stale_read');
  });

  it('leaves different paths and different inputs alone', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'src/a.ts' }),
      c('Edit', { file_path: 'src/b.ts' }),
      c('Glob', { pattern: '*.ts' }),
      c('Glob', { pattern: '*.tsx' }),
    ];
    expect(applyRules(calls).size).toBe(0);
  });
});

describe('helpers', () => {
  it('canonicalJson sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });
  it('normalizePath strips ./ and collapses segments', () => {
    expect(normalizePath('./src//x/../a.ts')).toBe('src/a.ts');
    expect(normalizePath('/abs/./a.ts')).toBe('/abs/a.ts');
  });
});
