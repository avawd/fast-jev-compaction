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
 * run is a no-op. It refuses to write while a live Claude Code process has the session open, when the
 * file changed in the last two minutes (unless --force), and to a subagent's transcript. The rewrite
 * keeps the file's mode, follows a symlink, and aborts if the file changes before the rename.
 * No dependencies.
 */
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, fsyncSync, openSync, readdirSync, readFileSync,
  realpathSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
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

const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;

/** `20260925T061155123Z`: UTC to the millisecond. */
function stamp(date) {
  return date.toISOString().replace(/[-:.]/g, '');
}

/** A backup path that does not exist yet: `<file>.<stamp>.bak`, else `<file>.<stamp>-<n>.bak`. */
function copyToBackup(path, date, mode) {
  for (let n = 0; ; n += 1) {
    const backup = `${path}.${stamp(date)}${n === 0 ? '' : `-${n}`}.bak`;
    try {
      copyFileSync(path, backup, constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }
    chmodSync(backup, mode);
    return backup;
  }
}

const unchanged = (a, b) => a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * Plans (and with `write`, applies) the repair of one transcript. With `write` it throws, leaving the
 * file as it was, when: a live process has the session open; the file was written in the last two
 * minutes (unless `force`); it is not a `<session-id>.jsonl` (a subagent's transcript, a renamed
 * copy); or it changed between the read and the rename. A symlink is followed and the real file is
 * rewritten. `beforeRename` is a test seam: it runs after the new content is on disk.
 */
export function fixFile(file, { write = false, force = false, configDir = defaultConfigDir(), now = new Date(), beforeRename } = {}) {
  const path = realpathSync(resolve(file));
  const name = basename(path);
  const sessionId = name.replace(/\.jsonl$/, '');
  const before = statSync(path);
  const text = readFileSync(path, 'utf8');
  if (!unchanged(before, statSync(path))) throw new Error(`${path} changed while it was being read; try again once its session has exited`);
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
  const recentlyModified = Date.now() - before.mtimeMs < RECENT_MS;
  const report = {
    file: path,
    relinks: plan.relinks.filter((r) => r.field === 'sourceToolAssistantUUID').length,
    parentRelinks: plan.relinks.filter((r) => r.field === 'parentUuid').length,
    renames: plan.renames.length,
    running: pid,
    recentlyModified,
    sessionFile: SESSION_FILE.test(name),
    plan,
    written: false,
    backup: undefined,
  };
  if (!write || (plan.relinks.length === 0 && plan.renames.length === 0)) return report;
  if (!report.sessionFile) {
    throw new Error(`${name} is not a session transcript (<session-id>.jsonl); subagent transcripts are not supported`);
  }
  if (pid !== undefined) throw new Error(`session ${sessionId} is running (pid ${pid}); exit it first`);
  if (recentlyModified && !force) {
    throw new Error(`${name} was written in the last two minutes; make sure its session has exited, then pass --force`);
  }

  const fixed = applyPlan(rows, plan);
  const out = lines.map((l, i) => (fixed[i] !== rows[i] ? JSON.stringify(fixed[i]) : l)).join('\n');
  const mode = before.mode & 0o777;
  const temp = `${path}.fix-resume-${process.pid}-${now.getTime()}.tmp`;
  let backup;
  try {
    const fd = openSync(temp, 'wx', mode);
    try {
      fchmodSync(fd, mode);
      writeSync(fd, out);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    backup = copyToBackup(path, now, mode);
    beforeRename?.();
    if (!unchanged(before, statSync(path))) {
      throw new Error(`${path} changed while it was being fixed (is its session running?); nothing was written`);
    }
    renameSync(temp, path);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    if (backup !== undefined && existsSync(backup)) unlinkSync(backup);
    throw error;
  }
  return { ...report, written: true, backup };
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const write = argv.includes('--write');
  const force = argv.includes('--force');
  if (args.length !== 1 || argv.includes('--help')) {
    console.error('usage: node scripts/fix-resume.mjs <session.jsonl> [--write [--force]]');
    return 2;
  }
  let report;
  try {
    report = fixFile(args[0], { write, force });
  } catch (error) {
    console.error(`fix-resume: ${error.message}`);
    return 1;
  }
  if (report.running !== undefined) console.error(`warning: a live process (pid ${report.running}) has this session open`);
  else if (report.recentlyModified) console.error('warning: the file changed in the last two minutes; --write needs --force');
  if (!report.sessionFile) console.error('warning: not a <session-id>.jsonl (a subagent transcript?); --write refuses it');
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
