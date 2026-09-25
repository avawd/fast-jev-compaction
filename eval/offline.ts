/**
 * Offline eval of verbatim-compaction over real transcripts. No model calls.
 *
 *   npm run eval:offline -- [--src <worktree>] [--corpus <file>]   (default $VC_EVAL_CORPUS, then eval/corpus.local.json)
 *                           [--only <label,...>] [--json <out.json>]
 *                           [--options '<plugin options json>'] [--min-reduction 0.25]
 *   npm run eval:offline -- --compare <a.json> <b.json>
 *   npm run eval:offline -- --facts <label> [--limit 40]   (prints never-echoed facts; private data, stdout only)
 *
 * See eval/README.md for what every column means.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contextBlob, factSets, resultsById, survival, type FactSets, type Survival } from './facts.ts';
import { carriedPrefix, loadSegments, type Segment } from './parse.ts';
import { ARMS, loadPlugin, runArm, type Arm, type PluginApi } from './plugin.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface CorpusEntry {
  label: string;
  file: string;
  segment: number;
  live?: boolean;
}

export interface ArmReport {
  removedBytes: number;
  removedPct: number;
  reductionRatio: number;
  gatePass: boolean;
  messagesAfter: number;
  decisions: Record<string, number>;
  neverEchoed: { survived: number; total: number; pct: number };
  laterRef: { lost: number; total: number };
  /** Unpinned result bytes a referenced-later pin kept whole (source 'pinned' on an unpinned call). */
  pinnedWholeBytes?: number;
  filled: number;
  unfilled: number;
}

export interface SegmentReport {
  label: string;
  live: boolean;
  file: string;
  segment: number;
  /** The cwd passed to compact() (from the transcript), if any. */
  cwd?: string;
  messages: number;
  calls: number;
  unpinned: number;
  unpinnedResultBytes: number;
  arms: Record<Arm, ArmReport>;
  /** What the NEXT segment of the same file actually holds (a live outcome, when one exists). */
  next?: { kind: 'summary' | 'verbatim'; neverEchoed: { survived: number; total: number; pct: number }; laterRef?: { lost: number; total: number } };
}

export interface OfflineReport {
  generatedAt: string;
  src: string;
  head: string;
  gateMeasure?: string;
  options: Record<string, unknown>;
  minReduction: number;
  segments: SegmentReport[];
  skipped: Array<{ label: string; reason: string }>;
}

function args(argv: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let key = '_';
  for (const a of argv) {
    if (a.startsWith('--')) {
      key = a.slice(2);
      if (!out.has(key)) out.set(key, []);
    } else {
      (out.get(key) ?? out.set(key, []).get(key)!).push(a);
    }
  }
  return out;
}

function pct(a: number, b: number): number {
  return b === 0 ? 0 : Math.round((a / b) * 1000) / 10;
}

function kb(n: number): string {
  return `${(n / 1024).toFixed(1)}k`;
}

/**
 * The corpus names private transcripts, so it is never tracked (this repo is public):
 * --corpus, else $VC_EVAL_CORPUS, else the gitignored eval/corpus.local.json.
 */
function resolveConfig(flag: string | undefined, env: string, name: string): string {
  const path = resolve(flag ?? process.env[env] ?? join(HERE, `${name}.local.json`));
  if (!existsSync(path)) {
    throw new Error(`${path} not found. Copy eval/${name}.example.json to eval/${name}.local.json (gitignored), or pass --${name} / set ${env}.`);
  }
  return path;
}

function loadCorpus(path: string): CorpusEntry[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { segments?: CorpusEntry[] };
  if (!Array.isArray(parsed.segments)) throw new Error(`${path}: expected { "segments": [...] }`);
  for (const s of parsed.segments) {
    if (typeof s.label !== 'string' || typeof s.file !== 'string' || !Number.isInteger(s.segment)) {
      throw new Error(`${path}: every segment needs label (string), file (string), segment (integer)`);
    }
  }
  return parsed.segments;
}

function nextReport(segs: Segment[], seg: Segment, facts: FactSets): SegmentReport['next'] {
  const next = segs[seg.index + 1];
  if (!next) return undefined;
  if (next.startsWithSummary) {
    const s = survival(facts, next.messages.slice(0, 1), seg.messages);
    return { kind: 'summary', neverEchoed: { survived: s.neverEchoedSurvived, total: s.neverEchoedTotal, pct: pct(s.neverEchoedSurvived, s.neverEchoedTotal) } };
  }
  const s = survival(facts, carriedPrefix(seg.messages, next.messages), seg.messages);
  return {
    kind: 'verbatim',
    neverEchoed: { survived: s.neverEchoedSurvived, total: s.neverEchoedTotal, pct: pct(s.neverEchoedSurvived, s.neverEchoedTotal) },
    laterRef: { lost: s.laterRefLost, total: s.laterRefTotal },
  };
}

async function evalSegment(
  api: PluginApi,
  entry: CorpusEntry,
  segs: Segment[],
  options: Record<string, unknown>,
  minReduction: number,
): Promise<SegmentReport> {
  const seg = segs[entry.segment]!;
  // The hook passes $.session.cwd() so rules can match paths exactly (branches without the option ignore it).
  options = seg.cwd && options['cwd'] === undefined ? { ...options, cwd: seg.cwd } : options;
  const preserve = typeof options['preserveRecentMessages'] === 'number' ? (options['preserveRecentMessages'] as number) : 6;
  const calls = api.collectToolCalls(seg.messages, preserve);
  const unpinned = calls.filter((c) => !c.pinned);
  const unpinnedResultBytes = unpinned.reduce((s, c) => s + c.resultChars, 0);
  const facts = factSets(seg.messages, unpinned);

  const arms = {} as Record<Arm, ArmReport>;
  for (const arm of ARMS) {
    const run = await runArm(api, seg.messages, arm, options);
    const after = resultsById(run.result.messages);
    let removed = 0;
    for (const c of unpinned) removed += c.resultChars - (after.get(c.tool_use_id)?.length ?? 0);
    const s: Survival = survival(facts, run.result.messages, seg.messages);
    const decisions: Record<string, number> = {};
    const unpinnedIds = new Map(unpinned.map((c) => [c.id, c]));
    let pinnedWholeBytes = 0;
    for (const d of run.result.decisions) {
      if (d.source === 'pinned') pinnedWholeBytes += unpinnedIds.get(d.id)?.resultChars ?? 0;
      const key = d.source === 'pinned' ? 'pinned' : `${d.action}:${d.rule ?? d.source}`;
      decisions[key] = (decisions[key] ?? 0) + 1;
    }
    const ratio = api.reductionRatio(run.result);
    arms[arm] = {
      removedBytes: removed,
      removedPct: pct(removed, unpinnedResultBytes),
      reductionRatio: Math.round(ratio * 1000) / 1000,
      gatePass: ratio >= minReduction,
      messagesAfter: run.result.messages.length,
      decisions,
      neverEchoed: { survived: s.neverEchoedSurvived, total: s.neverEchoedTotal, pct: pct(s.neverEchoedSurvived, s.neverEchoedTotal) },
      laterRef: { lost: s.laterRefLost, total: s.laterRefTotal },
      pinnedWholeBytes,
      filled: run.filled,
      unfilled: run.unfilled,
    };
    if (run.unfilled > 0) {
      console.warn(`WARN ${entry.label}: arm ${arm} left ${run.unfilled} unpinned calls at 'default' — the Scorer contract may have changed; floor/trunc are not what they claim`);
    }
  }
  const report: SegmentReport = {
    label: entry.label,
    live: entry.live === true,
    file: entry.file,
    segment: entry.segment,
    ...(typeof options['cwd'] === 'string' ? { cwd: options['cwd'] as string } : {}),
    messages: seg.messages.length,
    calls: calls.length,
    unpinned: unpinned.length,
    unpinnedResultBytes,
    arms,
  };
  const next = nextReport(segs, seg, facts);
  if (next) report.next = next;
  return report;
}

function printTable(r: OfflineReport): void {
  console.log(`\nverbatim-compaction offline eval — src ${r.src} (${r.head}); gate minReduction ${r.minReduction}; options ${JSON.stringify(r.options)}`);
  const head = [
    'segment', 'msgs', 'calls/unp', 'unpinned res', 'rules rm%', 'gate(ratio)', 'facts',
    'surv ceil=rules', 'surv trunc', 'surv floor', 'next (live)', 'laterRef lost r/t/f',
  ];
  const rows = r.segments.map((s) => [
    `${s.label}${s.live ? '*' : ''} [${s.segment}]`,
    String(s.messages),
    `${s.calls}/${s.unpinned}`,
    kb(s.unpinnedResultBytes),
    `${s.arms.rules.removedPct}%`,
    `${s.arms.rules.gatePass ? 'pass' : 'FAIL'} (${s.arms.rules.reductionRatio})`,
    String(s.arms.rules.neverEchoed.total),
    `${s.arms.rules.neverEchoed.pct}%`,
    `${s.arms.trunc.neverEchoed.pct}%`,
    `${s.arms.floor.neverEchoed.pct}%`,
    s.next ? `${s.next.neverEchoed.pct}% ${s.next.kind}` : '-',
    `${s.arms.rules.laterRef.lost}/${s.arms.trunc.laterRef.lost}/${s.arms.floor.laterRef.lost} of ${s.arms.rules.laterRef.total}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  console.log(line(head));
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const row of rows) console.log(line(row));
  console.log('* = live segment (the spec gate: never-echoed survival >= 70% there). rm% = unpinned tool-result bytes removed.');
  console.log('trunc/floor also remove: ' + r.segments.map((s) => `${s.label} ${s.arms.trunc.removedPct}%/${s.arms.floor.removedPct}%`).join(', '));
  for (const s of r.segments) {
    const d = Object.entries(s.arms.rules.decisions).filter(([k]) => !k.startsWith('keep')).map(([k, v]) => `${k}=${v}`).join(' ');
    const whole = s.arms.rules.pinnedWholeBytes;
    const pinned = whole ? ` (kept whole by a later-ref pin: ${kb(whole)} = ${pct(whole, s.unpinnedResultBytes)}% of unpinned)` : '';
    console.log(`  ${s.label} rules decisions: ${d || '(none)'}${pinned}`);
  }
  for (const k of r.skipped) console.log(`  skipped ${k.label}: ${k.reason}`);
}

function compare(aPath: string, bPath: string): void {
  const a = JSON.parse(readFileSync(aPath, 'utf8')) as OfflineReport;
  const b = JSON.parse(readFileSync(bPath, 'utf8')) as OfflineReport;
  console.log(`A = ${a.head} (${aPath})\nB = ${b.head} (${bPath})`);
  const head = ['segment', 'rules rm% A→B', 'gate A→B', 'surv rules A→B', 'surv trunc A→B', 'surv floor A→B', 'laterRef lost (rules) A→B'];
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map(() => '---').join('|')}|`);
  for (const sa of a.segments) {
    const sb = b.segments.find((x) => x.label === sa.label && x.segment === sa.segment);
    if (!sb) {
      console.log(`| ${sa.label} | (absent in B) |`);
      continue;
    }
    const d = (x: number, y: number) => `${x}→${y} (${y - x >= 0 ? '+' : ''}${Math.round((y - x) * 10) / 10})`;
    console.log(`| ${sa.label} | ${d(sa.arms.rules.removedPct, sb.arms.rules.removedPct)} | ${sa.arms.rules.reductionRatio}→${sb.arms.rules.reductionRatio} | ${d(sa.arms.rules.neverEchoed.pct, sb.arms.rules.neverEchoed.pct)} | ${d(sa.arms.trunc.neverEchoed.pct, sb.arms.trunc.neverEchoed.pct)} | ${d(sa.arms.floor.neverEchoed.pct, sb.arms.floor.neverEchoed.pct)} | ${sa.arms.rules.laterRef.lost}→${sb.arms.rules.laterRef.lost} of ${sb.arms.rules.laterRef.total} |`);
  }
}

async function printFacts(api: PluginApi, entry: CorpusEntry, limit: number): Promise<void> {
  const segs = await loadSegments(entry.file);
  const seg = segs[entry.segment];
  if (!seg) throw new Error(`${entry.label}: segment ${entry.segment} does not exist (${segs.length} segments)`);
  const calls = api.collectToolCalls(seg.messages, 6).filter((c) => !c.pinned);
  const facts = factSets(seg.messages, calls);
  const results = resultsById(seg.messages);
  const rules = await runArm(api, seg.messages, 'rules', seg.cwd ? { cwd: seg.cwd } : {});
  const kept = contextBlob(rules.result.messages);
  const input = new Map<string, string>();
  for (const m of seg.messages) for (const u of m.toolUses) input.set(u.tool_use_id, `${u.tool} ${JSON.stringify(u.input).slice(0, 100)}`);
  console.log(`${entry.label} [${entry.segment}]: ${facts.neverEchoed.length} never-echoed facts (showing ${Math.min(limit, facts.neverEchoed.length)}); msgs=${seg.messages.length}`);
  for (const f of facts.neverEchoed.slice(-limit)) {
    const text = results.get(f.tool_use_id) ?? '';
    const at = text.indexOf(f.token);
    const ctx = text.slice(Math.max(0, at - 70), at + f.token.length + 50).replace(/\s+/g, ' ');
    console.log(`- ${f.kind.padEnd(5)} ${f.token}  msg#${f.resultIndex} rules:${kept.includes(f.token) ? 'kept' : 'LOST'}  call: ${input.get(f.tool_use_id)}\n    …${ctx}…`);
  }
}

async function main(): Promise<void> {
  const a = args(process.argv.slice(2));
  if (a.has('compare')) {
    const [x, y] = a.get('compare')!;
    if (!x || !y) throw new Error('--compare needs two JSON files');
    compare(x, y);
    return;
  }
  const api = await loadPlugin(a.get('src')?.[0]);
  const corpusPath = resolveConfig(a.get('corpus')?.[0], 'VC_EVAL_CORPUS', 'corpus');
  let corpus = loadCorpus(corpusPath);
  const options = a.has('options') ? (JSON.parse(a.get('options')![0] ?? '{}') as Record<string, unknown>) : {};
  const minReduction = Number(a.get('min-reduction')?.[0] ?? (options['minReductionRatio'] as number | undefined) ?? 0.25);

  if (a.has('facts')) {
    const label = a.get('facts')![0];
    const entry = corpus.find((c) => c.label === label) ?? (label && existsSync(label) ? { label: basename(label), file: label, segment: Number(a.get('segment')?.[0] ?? -1) } : undefined);
    if (!entry) throw new Error(`--facts ${label}: not a corpus label or a file`);
    if (entry.segment < 0) entry.segment = (await loadSegments(entry.file)).length - 1;
    await printFacts(api, entry, Number(a.get('limit')?.[0] ?? 40));
    return;
  }

  const only = a.get('only')?.[0]?.split(',');
  if (only) corpus = corpus.filter((c) => only.includes(c.label));
  const report: OfflineReport = {
    generatedAt: new Date().toISOString(),
    src: api.srcDir,
    head: api.head,
    gateMeasure: api.gateMeasure,
    options,
    minReduction,
    segments: [],
    skipped: [],
  };
  for (const entry of corpus) {
    if (!existsSync(entry.file)) {
      console.warn(`WARN skipping ${entry.label}: ${entry.file} not found`);
      report.skipped.push({ label: entry.label, reason: 'file not found' });
      continue;
    }
    const segs = await loadSegments(entry.file);
    if (!segs[entry.segment]) {
      console.warn(`WARN skipping ${entry.label}: segment ${entry.segment} absent (${segs.length} segments)`);
      report.skipped.push({ label: entry.label, reason: `segment ${entry.segment} absent (${segs.length})` });
      continue;
    }
    const started = Date.now();
    report.segments.push(await evalSegment(api, entry, segs, options, minReduction));
    console.error(`  ${entry.label}: ${Date.now() - started}ms`);
  }
  printTable(report);
  const jsonPath = resolve(a.get('json')?.[0] ?? join(HERE, 'out', `offline-${api.head.replace(/[^\w.@+-]/g, '_')}.json`));
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`\nJSON: ${jsonPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
