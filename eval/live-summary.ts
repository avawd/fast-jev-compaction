/**
 * Summarises an eval/live.sh output directory: one row per run, from the
 * debug log (which plugin copy loaded, forks, outcome, fallback) and the
 * stream-json output (compact_boundary tokens, recall answers). It also opens
 * the FORKED transcript the run left behind and checks, without any model:
 *  - parser fidelity: eval/parse.ts's pre-compact message count equals the
 *    hook's "kept X/Y" Y, and the carried prefix equals X;
 *  - retention: each expected recall token present before / after compaction.
 *
 *   node_modules/.bin/tsx eval/live-summary.ts <out-dir> [--config <recall.json>]   (default: the one live.sh used)
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { contextBlob } from './facts.ts';
import { carriedPrefix, loadSegments } from './parse.ts';

interface RecallSet {
  name: string;
  question: string;
  expected: string[];
}
interface RecallConfig {
  session: string;
  cwd: string;
  sets: RecallSet[];
}

export interface LogFacts {
  pluginLoads: Array<{ enabled: boolean; hooksJson: string }>;
  forks: Array<{ ms?: number; line: string }>;
  forkRequests: number;
  outcome?: string;
  kept?: number;
  total?: number;
  reductionPct?: number;
  claudeStatus?: string;
  hookAnswered: boolean;
  coreRan: boolean;
  hookSettledMs?: number;
  hookErrors: string[];
  pluginConfigKey?: string;
}

const PLUGIN = 'verbatim-compaction';

export function parseDebugLog(text: string): LogFacts {
  const out: LogFacts = { pluginLoads: [], forks: [], forkRequests: 0, hookAnswered: false, coreRan: false, hookErrors: [] };
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    let m = line.match(/Read hooks\.json for plugin (\S+) \(enabled=(true|false)\): (\S+)/);
    if (m && m[1] === PLUGIN && !seen.has(`${m[2]}${m[3]}`)) {
      seen.add(`${m[2]}${m[3]}`);
      out.pluginLoads.push({ enabled: m[2] === 'true', hooksJson: m[3]! });
    }
    m = line.match(/\$\.model\.fork \(verbatim-compaction\): (.*)$/);
    if (m) {
      const ms = m[1]!.match(/^(\d+)ms/);
      out.forks.push({ ms: ms ? Number(ms[1]) : undefined, line: m[1]! });
    }
    if (line.includes('API REQUEST') && line.includes('source=hook_prompt')) out.forkRequests += 1;
    m = line.match(/\[verbatim-compaction\] \$\.ui\.log: (.*)$/);
    if (m && /^(kept|fallback)/.test(m[1]!)) {
      out.outcome = m[1]!;
      const k = m[1]!.match(/kept (\d+)\/(\d+) messages/);
      if (k) {
        out.kept = Number(k[1]);
        out.total = Number(k[2]);
      }
      const r = m[1]!.match(/(\d+)% reduction/);
      if (r) out.reductionPct = Number(r[1]);
      const c = m[1]!.match(/claude \d+ \(([^)]*)\)/);
      if (c) out.claudeStatus = c[1];
    }
    if (/session\.compact \(\w+\): a hook's \d+ messages stand/.test(line)) out.hookAnswered = true;
    if (/session\.compact \(\w+\):.*core ran|source=compact\b.*API REQUEST|API REQUEST.*source=compact\b/.test(line)) out.coreRan = true;
    m = line.match(/verbatim-compaction@\S+ session\.compact settled in ([\d.]+)ms/);
    if (m) out.hookSettledMs = Number(m[1]);
    if (/verbatim-compaction/.test(line) && /hook failed|threw|timed out|budget/i.test(line)) out.hookErrors.push(line.slice(24, 220));
    m = line.match(/plugin verbatim-compaction: (.*pluginConfigs\[[^\]]+\].*)$/);
    if (m) out.pluginConfigKey = m[1]!.slice(0, 160);
  }
  return out;
}

export interface StreamFacts {
  sessionId?: string;
  preTokens?: number;
  postTokens?: number;
  boundaryMs?: number;
  answers: string[];
  recallToolUses: string[];
  results: number;
}

export function parseStream(text: string): StreamFacts {
  const out: StreamFacts = { answers: [], recallToolUses: [], results: 0 };
  let afterBoundary = false;
  let compactResultSeen = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(line) as Record<string, any>;
    } catch {
      continue;
    }
    out.sessionId ??= typeof o['session_id'] === 'string' ? o['session_id'] : undefined;
    if (o['type'] === 'system' && o['subtype'] === 'compact_boundary') {
      const cm = (o['compact_metadata'] ?? {}) as Record<string, number>;
      out.preTokens = cm['pre_tokens'];
      out.postTokens = cm['post_tokens'];
      out.boundaryMs = cm['duration_ms'];
      afterBoundary = true;
      continue;
    }
    if (o['type'] === 'assistant' && afterBoundary && compactResultSeen) {
      for (const b of (o['message']?.['content'] ?? []) as Array<Record<string, unknown>>) {
        if (b['type'] === 'tool_use') out.recallToolUses.push(String(b['name']));
      }
    }
    if (o['type'] === 'result') {
      out.results += 1;
      if (!afterBoundary) continue;
      // The first result after the boundary is /compact's own (num_turns 0); the rest answer the recall sets.
      if (!compactResultSeen) {
        compactResultSeen = true;
        continue;
      }
      out.answers.push(typeof o['result'] === 'string' ? o['result'] : '');
    }
  }
  return out;
}

export function scoreAnswer(answer: string, expected: readonly string[]): { hit: string[]; miss: string[] } {
  const a = answer.toLowerCase();
  const hit = expected.filter((t) => a.includes(t.toLowerCase()));
  return { hit, miss: expected.filter((t) => !hit.includes(t)) };
}

function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

interface Retention {
  preMessages: number;
  carried: number;
  summary: boolean;
  byToken: Record<string, { before: boolean; after: boolean }>;
}

async function retention(transcript: string, tokens: string[]): Promise<Retention | undefined> {
  if (!existsSync(transcript)) return undefined;
  const segs = await loadSegments(transcript);
  const lastBoundary = segs.map((s) => s.boundary !== undefined).lastIndexOf(true);
  if (lastBoundary < 0 || !segs[lastBoundary + 1]) return undefined;
  const pre = segs[lastBoundary]!.messages;
  const next = segs[lastBoundary + 1]!;
  // After a summary fallback the context is the summary message; after a verbatim compaction, the carried rows.
  const carried = next.startsWithSummary ? next.messages.slice(0, 1) : carriedPrefix(pre, next.messages);
  const before = contextBlob(pre);
  const after = contextBlob(carried);
  const byToken: Retention['byToken'] = {};
  for (const t of tokens) byToken[t] = { before: before.includes(t), after: after.includes(t) };
  return { preMessages: pre.length, carried: carried.length, summary: next.startsWithSummary, byToken };
}

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? '');
  if (!process.argv[2] || !existsSync(dir)) throw new Error('usage: live-summary.ts <out-dir> [--config <recall.json>]');
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { pluginDir: string; sets: string; config: string; session: string };
  const ci = process.argv.indexOf('--config');
  const config = JSON.parse(readFileSync(ci > 0 ? process.argv[ci + 1]! : meta.config, 'utf8')) as RecallConfig;
  const sets = meta.sets === 'all' ? config.sets : config.sets.filter((s) => meta.sets.split(',').includes(s.name));
  const runs = readdirSync(dir).filter((f) => /^run\d+\.jsonl$/.test(f)).sort((a, b) => parseInt(a.slice(3)) - parseInt(b.slice(3)));

  const rows: Record<string, unknown>[] = [];
  for (const file of runs) {
    const n = file.match(/\d+/)![0];
    const logPath = join(dir, `run${n}.debug.log`);
    const log = parseDebugLog(existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');
    const stream = parseStream(readFileSync(join(dir, file), 'utf8'));
    const loaded = log.pluginLoads.filter((p) => p.enabled).map((p) => dirname(dirname(p.hooksJson)));
    const wrongCopy = loaded.some((d) => resolve(d) !== resolve(meta.pluginDir));
    // Queued stream-json prompts can be coalesced into one turn (seen live: both recall sets answered in one
    // reply), so every set is scored against all post-compaction answers; the expected tokens are set-specific.
    const answered = stream.answers.join('\n');
    const recall = sets.map((s) => ({ set: s.name, ...scoreAnswer(answered, s.expected), answer: answered }));
    const transcript = stream.sessionId ? join(homedir(), '.claude', 'projects', projectSlug(config.cwd), `${stream.sessionId}.jsonl`) : '';
    const ret = transcript ? await retention(transcript, sets.flatMap((s) => s.expected)) : undefined;
    const fallback = (log.outcome?.startsWith('fallback') ?? false) || log.coreRan || !log.hookAnswered;
    rows.push({
      run: Number(n),
      forkedSession: stream.sessionId,
      pluginLoaded: loaded,
      wrongCopyLoaded: wrongCopy,
      pluginConfig: log.pluginConfigKey,
      forks: log.forks,
      forkRequests: log.forkRequests,
      outcome: log.outcome,
      claudeStatus: log.claudeStatus,
      fallback,
      timeout: log.claudeStatus === 'timeout' || /timeout/.test(log.outcome ?? ''),
      hookSettledMs: log.hookSettledMs,
      hookErrors: log.hookErrors,
      preTokens: stream.preTokens,
      postTokens: stream.postTokens,
      recall,
      recallToolUses: stream.recallToolUses,
      // Only a verbatim outcome prints the hook's message count ("kept X/Y"); a fallback has nothing to check against.
      parserCheck: ret
        ? log.total !== undefined
          ? { hookSaw: log.total, parsed: ret.preMessages, hookKept: log.kept, carried: ret.carried, ok: ret.preMessages === log.total && ret.carried === log.kept }
          : { parsed: ret.preMessages, ok: null }
        : undefined,
      retention: ret?.byToken,
    });
  }

  console.log(`\nlive eval ${dir}\nplugin-dir ${meta.pluginDir}; session ${meta.session}; sets ${sets.map((s) => s.name).join(',')}`);
  console.log('| run | loaded from | forks (ms) | outcome | fallback | pre→post tok | hook ms (incl. next) | ' + sets.map((s) => `recall ${s.name}`).join(' | ') + ' | ' + sets.map((s) => `ctx ${s.name} before→after`).join(' | ') + ' | parser |');
  console.log('|' + '---|'.repeat(7 + sets.length * 2 + 1));
  for (const r of rows as Array<Record<string, any>>) {
    const loaded = (r.pluginLoaded as string[]).map((d) => (d === meta.pluginDir ? 'plugin-dir' : d)).join(',') || 'NONE';
    const forks = `${r.forks.length}: ${r.forks.map((f: { ms?: number; line: string }) => f.ms ?? f.line.slice(0, 30)).join('/')}`;
    const recall = (r.recall as Array<{ hit: string[]; miss: string[] }>).map((x) => `${x.hit.length}/${x.hit.length + x.miss.length}`);
    const ctx = sets.map((s) => {
      if (!r.retention) return '-';
      const b = s.expected.filter((t) => r.retention[t]?.before).length;
      const a = s.expected.filter((t) => r.retention[t]?.after).length;
      return `${b}→${a}/${s.expected.length}`;
    });
    const parser = !r.parserCheck ? '-' : r.parserCheck.ok === null ? `n/a (parsed ${r.parserCheck.parsed})` : `${r.parserCheck.ok ? 'ok' : 'MISMATCH'} ${r.parserCheck.parsed}/${r.parserCheck.hookSaw}`;
    console.log(`| ${r.run} | ${loaded}${r.wrongCopyLoaded ? ' (WRONG COPY)' : ''} | ${forks} | ${(r.outcome ?? 'NO OUTCOME LINE').slice(0, 110)} | ${r.fallback ? 'YES' : 'no'} | ${r.preTokens ?? '-'}→${r.postTokens ?? '-'} | ${r.hookSettledMs ?? '-'} | ${recall.join(' | ')} | ${ctx.join(' | ')} | ${parser} |`);
  }
  const all = rows as Array<Record<string, any>>;
  console.log(`\nruns ${all.length}; fallbacks ${all.filter((r) => r.fallback).length}; timeouts ${all.filter((r) => r.timeout).length}; wrong copy ${all.filter((r) => r.wrongCopyLoaded).length}; tool use during recall ${all.filter((r) => r.recallToolUses.length).length}`);
  for (const r of all) {
    for (const x of r.recall as Array<{ set: string; miss: string[]; answer: string }>) {
      console.log(`  run${r.run} ${x.set}: missed [${x.miss.join(', ')}]`);
    }
    console.log(`  run${r.run} answer(s): ${(r.recall[0]?.answer ?? '').replace(/\s+/g, ' ').slice(0, 600)}`);
    if (r.hookErrors.length) console.log(`  run${r.run} hook errors: ${r.hookErrors.join(' || ')}`);
    if (r.recallToolUses.length) console.log(`  run${r.run} WARNING recall turn used tools: ${r.recallToolUses.join(',')}`);
  }
  const summaryPath = join(dir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify({ meta, rows }, null, 2) + '\n');
  console.log(`\nJSON: ${summaryPath}\nforked transcripts left behind: ${all.map((r) => r.forkedSession).filter(Boolean).join(' ')}`);
}

if (process.argv[1]?.endsWith('live-summary.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
