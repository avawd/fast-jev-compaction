import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { carriedPrefix, compactedContext, loadSegments, type EvalMessage } from './parse.ts';

function fixture(rows: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'vc-eval-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

const user = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content },
  ...extra,
});
const assistant = (id: string, block: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { role: 'assistant', id, content: [block] },
  ...extra,
});

describe('loadSegments', () => {
  it('yields one message per user/assistant row, like $.session.messages()', async () => {
    const file = fixture([
      { type: 'attachment', rendered: [{ content: 'hook context' }] },
      user('first prompt'),
      assistant('m1', { type: 'thinking', thinking: 'hmm' }),
      assistant('m1', { type: 'text', text: 'looking' }),
      assistant('m1', { type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/a' } }),
      assistant('m1', { type: 'tool_use', id: 'u2', name: 'Grep', input: { pattern: 'x' } }),
      user([{ type: 'tool_result', tool_use_id: 'u1', content: 'AAA' }]),
      user([{ type: 'tool_result', tool_use_id: 'u2', content: [{ type: 'text', text: 'B1' }, { type: 'text', text: 'B2' }], is_error: true }]),
      user('<local-command-caveat>x</local-command-caveat>', { isMeta: true }),
      assistant('m9', { type: 'text', text: 'side' }, { isSidechain: true }),
      assistant('m2', { type: 'text', text: 'done' }),
    ]);
    const [seg] = await loadSegments(file);
    expect(seg!.messages.map((m) => [m.role, m.text, m.toolUses.length, m.toolResults?.length ?? 0])).toEqual([
      ['user', 'first prompt', 0, 0],
      ['assistant', '', 0, 0],
      ['assistant', 'looking', 0, 0],
      ['assistant', '', 1, 0],
      ['assistant', '', 1, 0],
      ['user', '', 0, 1],
      ['user', '', 0, 1],
      ['assistant', 'done', 0, 0],
    ]);
  });

  it('attaches each outcome to its tool use, as the engine does', async () => {
    const file = fixture([
      user('go'),
      assistant('m1', { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'ls' } }),
      user([{ type: 'tool_result', tool_use_id: 'u1', content: 'out', is_error: true }]),
    ]);
    const [seg] = await loadSegments(file);
    expect(seg!.messages[1]!.toolUses[0]).toEqual({
      tool_use_id: 'u1',
      tool: 'Bash',
      input: { command: 'ls' },
      text: 'out',
      isError: true,
    });
    expect(seg!.messages[2]!.toolResults).toEqual([{ tool_use_id: 'u1', text: 'out', isError: true }]);
  });

  it('splits at compact_boundary and records its metadata', async () => {
    const file = fixture([
      user('a'),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual', preTokens: 10, postTokens: 2 } },
      user('summary', { isCompactSummary: true }),
      user('b'),
    ]);
    const segs = await loadSegments(file);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.boundary).toEqual({ trigger: 'manual', preTokens: 10, postTokens: 2 });
    expect(segs[1]!.startsWithSummary).toBe(true);
    expect(segs[1]!.boundary).toBeUndefined();
  });

  it('skips unparseable lines instead of failing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-eval-'));
    const file = join(dir, 's.jsonl');
    writeFileSync(file, `${JSON.stringify(user('a'))}\n{not json\n${JSON.stringify(user('b'))}\n`);
    const [seg] = await loadSegments(file);
    expect(seg!.messages.map((m) => m.text)).toEqual(['a', 'b']);
    expect(seg!.skippedLines).toBe(1);
  });
});

describe('carriedPrefix', () => {
  it('stops at the first row the previous segment did not hold', () => {
    const prev = [
      { role: 'user' as const, text: 'go', toolUses: [] },
      { role: 'assistant' as const, text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }] },
      { role: 'user' as const, text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'x' }] },
    ];
    const next = [prev[0]!, prev[2]!, { role: 'user' as const, text: '<command-name>/compact</command-name>', toolUses: [] }, prev[0]!];
    expect(carriedPrefix(prev, next)).toHaveLength(2);
  });
});

describe('segment cwd', () => {
  it('is the cwd of the segment\'s last row that records one, like $.session.cwd() at compaction', async () => {
    const file = fixture([
      user('a', { cwd: '/repo' }),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: {}, cwd: '/repo' },
      user('b', { cwd: '/repo' }),
      assistant('m1', { type: 'text', text: 'moved' }, { cwd: '/repo/sub' }),
      { type: 'attachment', rendered: [], cwd: '/elsewhere' },
    ]);
    const segs = await loadSegments(file);
    expect(segs.map((s) => s.cwd)).toEqual(['/repo', '/repo/sub']);
  });
});

describe('carriedPrefix / compactedContext', () => {
  const u = (text: string): EvalMessage => ({ role: 'user', text, toolUses: [] });
  const a = (text: string): EvalMessage => ({ role: 'assistant', text, toolUses: [] });
  const pre = [u('old summary'), a(''), a('did things')];

  it('matches in order and stops at the end of the previous segment (an empty row after it is new)', () => {
    expect(carriedPrefix(pre, [u('old summary'), a(''), a('did things'), a(''), a('answer')])).toHaveLength(3);
  });

  it('a verbatim compaction that carried an older summary row is not a summary fallback', () => {
    const ctx = compactedContext(pre, [u('old summary'), a(''), a('did things'), u('q')], true);
    expect(ctx.summary).toBe(false);
    expect(ctx.context).toHaveLength(3);
  });

  it('a new summary row is a summary fallback', () => {
    const ctx = compactedContext(pre, [u('new summary'), u('q')], true);
    expect(ctx.summary).toBe(true);
    expect(ctx.context.map((m) => m.text)).toEqual(['new summary']);
  });
});

describe('hidden (thinking) characters', () => {
  it('records per message the thinking and signature characters the hook never sees', async () => {
    const file = fixture([
      user('go'),
      assistant('m1', { type: 'thinking', thinking: 'abcd', signature: 'SIG' }),
      assistant('m1', { type: 'text', text: 'ok' }),
      assistant('m2', { type: 'redacted_thinking', data: 'xxxxx' }),
    ]);
    const [seg] = await loadSegments(file);
    expect(seg!.hiddenChars).toEqual([0, 7, 0, 5]);
  });

  it('records each assistant row\'s API context tokens where the row has usage', async () => {
    const file = fixture([
      user('go'),
      { type: 'assistant', message: { role: 'assistant', id: 'm1', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 } } },
      assistant('m2', { type: 'text', text: 'b' }),
    ]);
    const [seg] = await loadSegments(file);
    expect(seg!.usageTokens).toEqual([0, 110, 0]);
  });
});
