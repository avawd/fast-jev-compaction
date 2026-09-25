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
import { strataLines } from './diagnose.ts';
import { contextBlob } from './facts.ts';
import { liveFactRows, type LiveFactRow } from './live-facts.ts';
import { compactedContext, loadSegments } from './parse.ts';
import type { RecallFact } from './recall-gen.ts';

interface RecallSet {
  name: string;
  question: string;
  expected: string[];
  /** Per-fact metadata, when the config came from recall.ts gen. */
  facts?: RecallFact[];
}
interface RecallConfig {
  session: string;
  cwd: string;
  sets: RecallSet[];
}

export interface LogFacts {
  pluginLoads: Array<{ enabled: boolean; hooksJson: string }>;
  forks: Array<{ ms?: number; line: string }>;
  /** Fork lines reporting an API error (e.g. invalid_request); the target is 0. */
  forkApiErrors: number;
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
  const out: LogFacts = { pluginLoads: [], forks: [], forkApiErrors: 0, forkRequests: 0, hookAnswered: false, coreRan: false, hookErrors: [] };
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
      if (/api error/i.test(m[1]!)) out.forkApiErrors += 1;
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
      const r = m[1]!.match(/(\d+)% (?:reduction|of tool output)/); // pre- and post-gateRatio wording
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
  /**
   * Real context, from API usage (input + cache read + cache creation): the last request before the
   * compact_boundary and the first one after it. `postTokens` undercounts by ~120-140k; this does not.
   */
  realBefore?: number;
  realAfter?: number;
  answers: string[];
  recallToolUses: string[];
  results: number;
}

function requestTokens(message: Record<string, any> | undefined): number {
  if (!message || message['model'] === '<synthetic>') return 0;
  const u = (message['usage'] ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : 0);
  return n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens');
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
    if (o['type'] === 'assistant') {
      const tokens = requestTokens(o['message']);
      if (tokens > 0) {
        if (!afterBoundary) out.realBefore = tokens;
        else out.realAfter ??= tokens;
      }
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

export interface RecallScore {
  set: string;
  hit: string[];
  miss: string[];
  /** A recall turn that used a tool answered from the tool, not from context: scored 0. */
  failed: boolean;
  answer: string;
}

/**
 * Scores every set against all post-compaction answers joined: queued stream-json prompts can be
 * coalesced into one turn (seen live), and the expected tokens are set-specific.
 */
export function scoreRecall(answers: readonly string[], sets: readonly RecallSet[], toolUses: readonly string[]): RecallScore[] {
  const answer = answers.join('\n');
  const failed = toolUses.length > 0;
  return sets.map((s) => {
    if (failed) return { set: s.name, hit: [], miss: [...s.expected], failed, answer };
    return { set: s.name, ...scoreAnswer(answer, s.expected), failed, answer };
  });
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
  const { summary, context } = compactedContext(pre, next.messages, next.startsWithSummary);
  const before = contextBlob(pre);
  const after = contextBlob(context);
  const byToken: Retention['byToken'] = {};
  for (const t of tokens) byToken[t] = { before: before.includes(t), after: after.includes(t) };
  return { preMessages: pre.length, carried: context.length, summary, byToken };
}

async function main(): Promise<void> {
  const dir = resolve(process.argv[2] ?? '');
  if (!process.argv[2] || !existsSync(dir)) throw new Error('usage: live-summary.ts <out-dir> [--config <recall.json>]');
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as { pluginDir: string; noPlugin?: boolean; sets: string; config: string; session: string };
  // A --no-plugin baseline loads neither copy: any enabled load is the wrong copy.
  const expectedDir = meta.noPlugin ? undefined : meta.pluginDir;
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
    const wrongCopy = loaded.some((d) => !expectedDir || resolve(d) !== resolve(expectedDir));
    const recall = scoreRecall(stream.answers, sets, stream.recallToolUses);
    const transcript = stream.sessionId ? join(homedir(), '.claude', 'projects', projectSlug(config.cwd), `${stream.sessionId}.jsonl`) : '';
    const ret = transcript ? await retention(transcript, sets.flatMap((s) => s.expected)) : undefined;
    const fallback = (log.outcome?.startsWith('fallback') ?? false) || log.coreRan || !log.hookAnswered;
    const facts = transcript && existsSync(transcript)
      ? await liveFactRows(transcript, sets, stream.answers.join('\n'), stream.recallToolUses.length > 0, expectedDir)
      : undefined;
    rows.push({
      run: Number(n),
      forkedSession: stream.sessionId,
      pluginLoaded: loaded,
      wrongCopyLoaded: wrongCopy,
      pluginConfig: log.pluginConfigKey,
      forks: log.forks,
      forkRequests: log.forkRequests,
      forkApiErrors: log.forkApiErrors,
      outcome: log.outcome,
      claudeStatus: log.claudeStatus,
      fallback,
      timeout: /^timeout/.test(log.claudeStatus ?? '') || /timeout/.test(log.outcome ?? ''),
      hookSettledMs: log.hookSettledMs,
      hookErrors: log.hookErrors,
      preTokens: stream.preTokens,
      postTokens: stream.postTokens,
      realBefore: stream.realBefore,
      realAfter: stream.realAfter,
      recall,
      recallToolUses: stream.recallToolUses,
      // Only a verbatim outcome prints the hook's message count ("kept X/Y"); a fallback has nothing to check against.
      parserCheck: ret
        ? log.total !== undefined
          ? { hookSaw: log.total, parsed: ret.preMessages, hookKept: log.kept, carried: ret.carried, ok: ret.preMessages === log.total && ret.carried === log.kept }
          : { parsed: ret.preMessages, ok: null }
        : undefined,
      retention: ret?.byToken,
      ...(facts ? { facts } : {}),
    });
  }

  console.log(`\nlive eval ${dir}\nplugin-dir ${meta.noPlugin ? 'NONE (baseline: built-in summary)' : meta.pluginDir}; session ${meta.session}; sets ${sets.map((s) => s.name).join(',')}`);
  console.log('| run | loaded from | forks (ms) | outcome | fork api-err | fallback | pre→post tok | real ctx before→after (API usage) | hook ms (incl. next) | ' + sets.map((s) => `recall ${s.name}`).join(' | ') + ' | ' + sets.map((s) => `ctx ${s.name} before→after`).join(' | ') + ' | parser |');
  console.log('|' + '---|'.repeat(9 + sets.length * 2 + 1));
  for (const r of rows as Array<Record<string, any>>) {
    const loaded = (r.pluginLoaded as string[]).map((d) => (d === meta.pluginDir ? 'plugin-dir' : d)).join(',') || (meta.noPlugin ? 'none (baseline)' : 'NONE');
    const forks = `${r.forks.length}: ${r.forks.map((f: { ms?: number; line: string }) => f.ms ?? f.line.slice(0, 30)).join('/')}`;
    const recall = (r.recall as RecallScore[]).map((x) => (x.failed ? `FAILED (tool use) 0/${x.miss.length}` : `${x.hit.length}/${x.hit.length + x.miss.length}`));
    const ctx = sets.map((s) => {
      if (!r.retention) return '-';
      const b = s.expected.filter((t) => r.retention[t]?.before).length;
      const a = s.expected.filter((t) => r.retention[t]?.after).length;
      return `${b}→${a}/${s.expected.length}`;
    });
    const parser = !r.parserCheck ? '-' : r.parserCheck.ok === null ? `n/a (parsed ${r.parserCheck.parsed})` : `${r.parserCheck.ok ? 'ok' : 'MISMATCH'} ${r.parserCheck.parsed}/${r.parserCheck.hookSaw}`;
    console.log(`| ${r.run} | ${loaded}${r.wrongCopyLoaded ? ' (WRONG COPY)' : ''} | ${forks} | ${(r.outcome ?? 'NO OUTCOME LINE').slice(0, 110)} | ${r.forkApiErrors} | ${r.fallback ? 'YES' : 'no'} | ${r.preTokens ?? '-'}→${r.postTokens ?? '-'} | ${realCtx(r.realBefore, r.realAfter)} | ${r.hookSettledMs ?? '-'} | ${recall.join(' | ')} | ${ctx.join(' | ')} | ${parser} |`);
  }
  const all = rows as Array<Record<string, any>>;
  console.log(`\nruns ${all.length}; fork api-errors ${all.reduce((n, r) => n + r.forkApiErrors, 0)}; fallbacks ${all.filter((r) => r.fallback).length}; timeouts ${all.filter((r) => r.timeout).length}; wrong copy ${all.filter((r) => r.wrongCopyLoaded).length}; recall FAILED by tool use ${all.filter((r) => r.recallToolUses.length).length}`);
  for (const r of all) {
    for (const x of r.recall as Array<{ set: string; miss: string[]; answer: string }>) {
      console.log(`  run${r.run} ${x.set}: missed [${x.miss.join(', ')}]`);
    }
    console.log(`  run${r.run} answer(s): ${(r.recall[0]?.answer ?? '').replace(/\s+/g, ' ').slice(0, 600)}`);
    if (r.hookErrors.length) console.log(`  run${r.run} hook errors: ${r.hookErrors.join(' || ')}`);
    if (r.recallToolUses.length) console.log(`  run${r.run} WARNING recall turn used tools: ${r.recallToolUses.join(',')}`);
  }
  printFacts(all.filter((r) => r.facts).map((r) => ({ run: r.run as number, facts: r.facts as LiveFactRow[] })));
  const summaryPath = join(dir, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify({ meta, rows }, null, 2) + '\n');
  console.log(`\nJSON: ${summaryPath}\nforked transcripts left behind: ${all.map((r) => r.forkedSession).filter(Boolean).join(' ')}`);
}

/** `266k→231k (-13%)`: real context before and after, from API usage. */
export function realCtx(before?: number, after?: number): string {
  if (!before || !after) return `${before ?? '-'}→${after ?? '-'}`;
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  return `${k(before)}→${k(after)} (${Math.round((100 * (after - before)) / before)}%)`;
}

/** Per-fact recall and retention over all runs, by stratum, and every missed never-echoed fact with its cause. */
export function printFacts(runs: ReadonlyArray<{ run: number; facts: LiveFactRow[] }>): void {
  if (runs.length === 0) return;
  const rows = runs.flatMap((r) => r.facts.map((f) => ({ fact: f, ok: { recalled: f.hit, 'in ctx after': f.after, 'in ctx before': f.before } })));
  const cols = ['recalled', 'in ctx after', 'in ctx before'];
  console.log(`\nper-fact results over ${runs.length} run(s) (${rows.length} fact-runs)`);
  for (const [title, key, subset] of [
    ['set', (f: LiveFactRow) => (f.echoed ? 'echoed (control)' : 'never-echoed'), rows],
    ['tool category (never-echoed)', (f: LiveFactRow) => f.category, rows.filter((r) => !r.fact.echoed)],
    ['age bucket (never-echoed)', (f: LiveFactRow) => f.bucket, rows.filter((r) => !r.fact.echoed)],
    ['kind (never-echoed)', (f: LiveFactRow) => f.kind, rows.filter((r) => !r.fact.echoed)],
  ] as const) {
    console.log(`\nby ${title}`);
    for (const l of strataLines(subset, cols, key)) console.log(l);
  }
  const causes = new Map<string, number>();
  for (const { fact } of rows) if (!fact.hit && !fact.echoed) {
    const k = fact.verdict.replace(/ \(at .*\)$/, '');
    causes.set(k, (causes.get(k) ?? 0) + 1);
  }
  console.log('\nnever-echoed misses by cause');
  for (const [k, n] of [...causes].sort((x, y) => y[1] - x[1])) console.log(`  ${n}  ${k}`);
  console.log('\nmissed facts');
  for (const r of runs) for (const f of r.facts) if (!f.hit) console.log(`  run${r.run} ${f.echoed ? 'E' : 'N'} ${f.category}/${f.bucket}(${f.age}) ${f.kind} ${f.token.slice(0, 60)} — ${f.verdict}`);
}

if (process.argv[1]?.endsWith('live-summary.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
