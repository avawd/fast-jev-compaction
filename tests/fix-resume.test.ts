import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script, no declaration file
import { applyPlan, fixFile, planFix, runningSession } from '../scripts/fix-resume.mjs';

type Row = Record<string, any>;

let n = 0;
const id = (p: string) => `${p}-${(n += 1).toString().padStart(4, '0')}`;

/** One turn: prompt, an assistant message with two parallel Bash calls, their results, a reply. */
function turn(parent: string | null, msg: string, tag: string): Row[] {
  const prompt = { type: 'user', uuid: id('u'), parentUuid: parent, message: { role: 'user', content: `do ${tag}` } };
  const think = { type: 'assistant', uuid: id('a'), parentUuid: prompt.uuid, message: { id: msg, role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] } };
  const call1 = { type: 'assistant', uuid: id('a'), parentUuid: think.uuid, message: { id: msg, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${tag}1`, name: 'Bash', input: { command: 'echo 1' } }] } };
  const call2 = { type: 'assistant', uuid: id('a'), parentUuid: call1.uuid, message: { id: msg, role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${tag}2`, name: 'Bash', input: { command: 'echo 2' } }] } };
  const res1 = { type: 'user', uuid: id('u'), parentUuid: call1.uuid, sourceToolAssistantUUID: call1.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${tag}1`, content: '1' }] } };
  const att = { type: 'attachment', uuid: id('t'), parentUuid: res1.uuid, attachment: { type: 'hook_success' } };
  const res2 = { type: 'user', uuid: id('u'), parentUuid: call2.uuid, sourceToolAssistantUUID: call2.uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${tag}2`, content: '2' }] } };
  const reply = { type: 'assistant', uuid: id('a'), parentUuid: res2.uuid, message: { id: `${msg}r`, role: 'assistant', content: [{ type: 'text', text: 'done' }] } };
  return [prompt, think, call1, call2, res1, att, res2, reply];
}

/**
 * What 2.1.282 writes when a session.compact hook keeps rows: a boundary without preserved-segment
 * metadata, then every kept row again under a fresh uuid, chained in order, with tool_result rows'
 * sourceToolAssistantUUID (and parentUuid) still naming the pre-boundary assistant row.
 */
function hookCompaction(before: Row[]): Row[] {
  const boundary = { type: 'system', subtype: 'compact_boundary', uuid: id('b'), parentUuid: null, compactMetadata: { trigger: 'manual', preTokens: 1 } };
  const out: Row[] = [boundary];
  let parent = boundary.uuid;
  for (const r of before) {
    if (r.type === 'system') continue;
    const copy: Row = { ...r, uuid: id('c'), parentUuid: parent };
    if (r.sourceToolAssistantUUID) copy.parentUuid = r.sourceToolAssistantUUID;
    out.push(copy);
    parent = copy.uuid;
  }
  return out;
}

function builtinCompaction(before: Row[]): Row[] {
  const kept = before.slice(-2);
  const boundary = {
    type: 'system', subtype: 'compact_boundary', uuid: id('b'), parentUuid: null,
    compactMetadata: { trigger: 'manual', preservedSegment: { headUuid: kept[0]!.uuid, tailUuid: kept[1]!.uuid } },
  };
  const summary = { type: 'user', uuid: id('s'), parentUuid: boundary.uuid, isCompactSummary: true, message: { role: 'user', content: 'summary' } };
  return [boundary, summary];
}

const toText = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const parse = (text: string): Row[] => text.split('\n').filter(Boolean).map((l) => JSON.parse(l));

function tmp(rows: Row[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'fix-resume-'));
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, toText(rows));
  return file;
}

function staleAfterLastBoundary(rows: Row[]): number {
  const b = rows.map((r) => r.subtype === 'compact_boundary').lastIndexOf(true);
  const pos = new Map(rows.map((r, i) => [r.uuid, i]));
  return rows.slice(b + 1).filter((r) => r.sourceToolAssistantUUID && (pos.get(r.sourceToolAssistantUUID) ?? Infinity) < b).length;
}

function sharedIdsAcross(rows: Row[], b: number): string[] {
  const before = new Set(rows.slice(0, b).filter((r) => r.type === 'assistant').map((r) => r.message.id));
  return [...new Set(rows.slice(b + 1).filter((r) => r.type === 'assistant' && before.has(r.message.id)).map((r) => r.message.id))];
}

describe('fix-resume plan', () => {
  const pre = turn(null, 'msg_A', 'a');
  const rows = [...pre, ...hookCompaction(pre), ...turn(null, 'msg_B', 'b')];
  const b = pre.length;

  it('re-links stale tool_result rows to the post-boundary assistant copy (the repro)', () => {
    expect(staleAfterLastBoundary(rows)).toBe(2);
    const fixed = applyPlan(rows, planFix(rows));
    expect(staleAfterLastBoundary(fixed)).toBe(0);
    const copy = fixed.slice(b + 1);
    const call1 = copy.find((r) => r.message?.content?.[0]?.id === 'toolu_a1')!;
    const res1 = copy.find((r) => r.message?.content?.[0]?.tool_use_id === 'toolu_a1')!;
    expect(res1.sourceToolAssistantUUID).toBe(call1.uuid);
    expect(res1.parentUuid).toBe(call1.uuid);
  });

  it('scopes message ids shared across the boundary, keeping rows of one message together', () => {
    expect(sharedIdsAcross(rows, b)).toEqual(['msg_A', 'msg_Ar']);
    const fixed = applyPlan(rows, planFix(rows));
    expect(sharedIdsAcross(fixed, b)).toEqual([]);
    const ids = fixed.slice(b + 1, b + 1 + pre.length).filter((r) => r.type === 'assistant' && r.message.content[0].type !== 'text').map((r) => r.message.id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toMatch(/^msg_A/);
    // Rows before the boundary and rows the model wrote after it are untouched.
    expect(fixed.slice(0, b + 1)).toEqual(rows.slice(0, b + 1));
    expect(fixed.slice(-8)).toEqual(rows.slice(-8));
  });

  it('is idempotent: a second plan is empty', () => {
    const fixed = applyPlan(rows, planFix(rows));
    const again = planFix(fixed);
    expect(again.relinks).toEqual([]);
    expect(again.renames).toEqual([]);
  });

  it('leaves a transcript with no hook compaction alone (none, or built-in only)', () => {
    const plain = [...turn(null, 'msg_P', 'p'), ...turn(null, 'msg_Q', 'q')];
    expect(planFix(plain)).toEqual({ relinks: [], renames: [] });
    const t = turn(null, 'msg_S', 's');
    const builtin = [...t, ...builtinCompaction(t), ...turn(null, 'msg_T', 't')];
    expect(planFix(builtin)).toEqual({ relinks: [], renames: [] });
  });

  it('fixes every hook boundary in a file with several, and never reuses an id', () => {
    const t0 = turn(null, 'msg_M', 'm');
    const c1 = hookCompaction(t0);
    const c2 = hookCompaction(c1.slice(1));
    const all = [...t0, ...c1, ...c2];
    const fixed = applyPlan(all, planFix(all));
    const b1 = t0.length;
    const b2 = t0.length + c1.length;
    expect(staleAfterLastBoundary(fixed)).toBe(0);
    expect(sharedIdsAcross(fixed, b1)).toEqual([]);
    expect(sharedIdsAcross(fixed, b2)).toEqual([]);
    // The middle segment's tool_result rows point into the middle segment.
    const pos = new Map(fixed.map((r, i) => [r.uuid, i]));
    for (const r of fixed.slice(b1 + 1, b2)) if (r.sourceToolAssistantUUID) expect(pos.get(r.sourceToolAssistantUUID)).toBeGreaterThan(b1);
    expect(planFix(fixed)).toEqual({ relinks: [], renames: [] });
  });
});

describe('fix-resume file handling', () => {
  const pre = turn(null, 'msg_F', 'f');
  const rows = [...pre, ...hookCompaction(pre)];
  const noSessions = () => mkdtempSync(join(tmpdir(), 'fix-resume-cfg-'));

  it('dry run by default: reports and writes nothing', () => {
    const file = tmp(rows);
    const before = readFileSync(file, 'utf8');
    const report = fixFile(file, { write: false, configDir: noSessions() });
    expect(report.relinks).toBe(2);
    expect(report.renames).toBeGreaterThan(0);
    expect(report.written).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(join(file, '..'))).toEqual(['session.jsonl']);
  });

  it('--write makes a timestamped .bak of the original, then rewrites; unchanged lines stay byte-identical', () => {
    const file = tmp(rows);
    const before = readFileSync(file, 'utf8').replace('"do f"', '"do  f"'); // odd spacing survives in unchanged rows
    writeFileSync(file, before);
    const report = fixFile(file, { write: true, configDir: noSessions() });
    expect(report.written).toBe(true);
    const baks = readdirSync(join(file, '..')).filter((f) => f.endsWith('.bak'));
    expect(baks).toHaveLength(1);
    expect(baks[0]).toMatch(/^session\.jsonl\.\d{8}T\d{6}Z?\.bak$/);
    expect(readFileSync(join(file, '..', baks[0]!), 'utf8')).toBe(before);
    const after = readFileSync(file, 'utf8');
    expect(after.split('\n')[0]).toBe(before.split('\n')[0]);
    expect(staleAfterLastBoundary(parse(after))).toBe(0);
    // A second run changes nothing and makes no second backup.
    const again = fixFile(file, { write: true, configDir: noSessions() });
    expect(again.written).toBe(false);
    expect(readdirSync(join(file, '..')).filter((f) => f.endsWith('.bak'))).toHaveLength(1);
    expect(readFileSync(file, 'utf8')).toBe(after);
  });

  it('keeps lines it cannot parse', () => {
    const file = tmp(rows);
    writeFileSync(file, readFileSync(file, 'utf8') + '{not json\n');
    fixFile(file, { write: true, configDir: noSessions() });
    expect(readFileSync(file, 'utf8').endsWith('{not json\n')).toBe(true);
  });

  it('refuses to write while a live process has the session open', () => {
    const file = tmp(rows);
    const cfg = noSessions();
    mkdirSync(join(cfg, 'sessions'));
    writeFileSync(join(cfg, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: 'session' }));
    expect(runningSession('session', cfg)).toBe(process.pid);
    expect(() => fixFile(file, { write: true, configDir: cfg })).toThrow(/running/);
    expect(readdirSync(join(file, '..')).some((f) => f.endsWith('.bak'))).toBe(false);
    // A registry entry whose process is gone does not block.
    writeFileSync(join(cfg, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: 999999, sessionId: 'session' }));
    expect(runningSession('session', cfg)).toBeUndefined();
    expect(existsSync(file)).toBe(true);
  });
});
