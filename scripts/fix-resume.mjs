#!/usr/bin/env node
/**
 * Repairs a session transcript that a session.compact hook compacted by keeping rows, so that
 * `claude --resume` restores the compacted conversation instead of splicing old rows back in.
 *
 *   node scripts/fix-resume.mjs <session.jsonl>            dry run: prints what it would re-link
 *   node scripts/fix-resume.mjs <session.jsonl> --write    backs the file up, then rewrites it
 *
 * Claude Code 2.1.282 writes a hook's kept rows after the compact_boundary under fresh uuids but
 * (1) leaves each tool_result row's `sourceToolAssistantUUID` (and `parentUuid`) naming the
 * PRE-compaction assistant row, and (2) keeps each assistant row's `message.id`. On load, the engine
 * re-parents tool_result rows through (1) and groups assistant rows by (2) across the whole file, so
 * the resumed conversation re-enters the old rows. This script, for every boundary without the
 * built-in compaction's preserved-segment metadata:
 *   1. points those tool_result rows at the post-boundary copy of their assistant row;
 *   2. gives post-boundary assistant rows whose message.id also appears before the boundary a
 *      scoped id (`<id>_vc<n>`, n = the boundary's ordinal), the same for every row of one message.
 * Nothing before a boundary changes, unchanged lines are written back byte for byte, and a second
 * run is a no-op. It refuses to write while a live Claude Code process has the session open.
 * No dependencies.
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCOPE_SUFFIX = /_vc\d+$/;
/** A file written this recently may belong to a session that is still running. */
const RECENT_MS = 120_000;

const isBoundary = (r) => r?.type === 'system' && r.subtype === 'compact_boundary';
const isBuiltin = (r) => {
  const m = r.compactMetadata ?? r.compact_metadata ?? {};
  return m.preservedSegment !== undefined || m.preservedMessages !== undefined || m.preserved_segment !== undefined;
};
const blocks = (r) => (Array.isArray(r?.message?.content) ? r.message.content : []);
const toolResultIds = (r) => blocks(r).filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id);
const toolUseIds = (r) => blocks(r).filter((b) => b?.type === 'tool_use').map((b) => b.id);

/**
 * What to change, as a list of edits by row index. `rows` holds parsed rows (null for a line that
 * did not parse). Boundaries are handled oldest first over a working copy, so a later boundary sees
 * the ids an earlier one scoped.
 */
export function planFix(rows) {
  const work = rows.map((r) => (r && typeof r === 'object' ? { ...r, message: r.message ? { ...r.message } : r.message } : r));
  const pos = new Map();
  work.forEach((r, i) => { if (r?.uuid && !pos.has(r.uuid)) pos.set(r.uuid, i); });
  const boundaries = work.map((r, i) => (isBoundary(r) ? i : -1)).filter((i) => i >= 0);
  const relinks = [];
  const renames = [];
  boundaries.forEach((b, ordinal) => {
    if (isBuiltin(work[b])) return;
    const end = boundaries[ordinal + 1] ?? work.length;
    const before = (uuid) => typeof uuid === 'string' && pos.has(uuid) && pos.get(uuid) < b;

    const owner = new Map();
    for (let i = b + 1; i < end; i += 1) {
      if (work[i]?.type === 'assistant') for (const id of toolUseIds(work[i])) owner.set(id, work[i].uuid);
    }
    for (let i = b + 1; i < end; i += 1) {
      const r = work[i];
      if (r?.type !== 'user' || !before(r.sourceToolAssistantUUID)) continue;
      const to = toolResultIds(r).map((id) => owner.get(id)).find(Boolean);
      if (!to) continue;
      relinks.push({ index: i, field: 'sourceToolAssistantUUID', from: r.sourceToolAssistantUUID, to });
      r.sourceToolAssistantUUID = to;
      if (before(r.parentUuid)) {
        relinks.push({ index: i, field: 'parentUuid', from: r.parentUuid, to });
        r.parentUuid = to;
      }
    }

    const earlier = new Set();
    for (let i = 0; i < b; i += 1) if (work[i]?.type === 'assistant' && work[i].message?.id) earlier.add(work[i].message.id);
    for (let i = b + 1; i < end; i += 1) {
      const r = work[i];
      const id = r?.type === 'assistant' ? r.message?.id : undefined;
      if (typeof id !== 'string' || !earlier.has(id)) continue;
      const to = `${id.replace(SCOPE_SUFFIX, '')}_vc${ordinal + 1}`;
      renames.push({ index: i, from: id, to });
      r.message.id = to;
    }
  });
  return { relinks, renames };
}

/** `rows` with the plan's edits, as new objects; rows the plan does not name are returned as is. */
export function applyPlan(rows, plan) {
  const out = [...rows];
  const edit = (i) => {
    if (out[i] === rows[i]) out[i] = { ...rows[i], message: rows[i].message ? { ...rows[i].message } : rows[i].message };
    return out[i];
  };
  for (const r of plan.relinks) edit(r.index)[r.field] = r.to;
  for (const r of plan.renames) edit(r.index).message.id = r.to;
  return out;
}

/** The pid of a live Claude Code process registered for `sessionId`, if any. */
export function runningSession(sessionId, configDir = defaultConfigDir()) {
  const dir = join(configDir, 'sessions');
  if (!existsSync(dir)) return undefined;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    let entry;
    try {
      entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    if (entry?.sessionId !== sessionId || !Number.isInteger(entry.pid)) continue;
    if (alive(entry.pid)) return entry.pid;
  }
  return undefined;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function defaultConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/**
 * Plans (and with `write`, applies) the repair of one transcript. Throws when asked to write a
 * session that a live process has open.
 */
export function fixFile(file, { write = false, configDir = defaultConfigDir() } = {}) {
  const path = resolve(file);
  const sessionId = basename(path).replace(/\.jsonl$/, '');
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const rows = lines.map((l) => {
    if (!l.trim()) return null;
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  });
  const plan = planFix(rows);
  const pid = runningSession(sessionId, configDir);
  const recentlyModified = Date.now() - statSync(path).mtimeMs < RECENT_MS;
  const report = {
    file: path,
    relinks: plan.relinks.filter((r) => r.field === 'sourceToolAssistantUUID').length,
    parentRelinks: plan.relinks.filter((r) => r.field === 'parentUuid').length,
    renames: plan.renames.length,
    running: pid,
    recentlyModified,
    plan,
    written: false,
    backup: undefined,
  };
  if (!write || (plan.relinks.length === 0 && plan.renames.length === 0)) return report;
  if (pid !== undefined) throw new Error(`session ${sessionId} is running (pid ${pid}); exit it first`);

  const fixed = applyPlan(rows, plan);
  const out = lines.map((l, i) => (fixed[i] !== rows[i] ? JSON.stringify(fixed[i]) : l)).join('\n');
  const backup = `${path}.${stamp()}.bak`;
  copyFileSync(path, backup);
  const temp = `${path}.fix-resume-${process.pid}.tmp`;
  writeFileSync(temp, out);
  renameSync(temp, path);
  return { ...report, written: true, backup };
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const write = argv.includes('--write');
  if (args.length !== 1 || argv.includes('--help')) {
    console.error('usage: node scripts/fix-resume.mjs <session.jsonl> [--write]');
    return 2;
  }
  let report;
  try {
    report = fixFile(args[0], { write });
  } catch (error) {
    console.error(`fix-resume: ${error.message}`);
    return 1;
  }
  if (report.running !== undefined) console.error(`warning: a live process (pid ${report.running}) has this session open`);
  else if (report.recentlyModified) console.error('warning: the file changed in the last two minutes; make sure its session is not running');
  console.log(`${report.file}`);
  console.log(`  tool_result rows to re-link: ${report.relinks} (parentUuid too: ${report.parentRelinks})`);
  console.log(`  assistant rows whose message.id to scope: ${report.renames}`);
  if (report.relinks + report.renames === 0) console.log('  nothing to do');
  else if (report.written) console.log(`  written; original saved as ${report.backup}`);
  else console.log('  dry run: nothing written (pass --write to apply)');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
