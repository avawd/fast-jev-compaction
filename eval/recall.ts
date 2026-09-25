/**
 * Large recall sets: generate them, and diagnose them offline. No model calls.
 *
 *   npm run eval:recall -- gen <corpus-label|session.jsonl> --out eval/recall-<name>.local.json
 *                          [--ne 25] [--echoed 10] [--batch 10] [--seed 1] [--src <worktree>]
 *   npm run eval:recall -- diagnose <recall.json> [--src <worktree>] [--options '<json>'] [--json <out>]
 *
 * `gen` picks never-echoed facts (single-carrier tokens) and echoed controls from the LAST
 * segment of the transcript (the one a live `--resume` compacts), stratified by tool and age,
 * and writes a recall config for eval/live.sh. The file names a private session and holds
 * private values: write it only under a gitignored name (eval/*.local.json or eval/out/).
 *
 * `diagnose` runs the rules / trunc / floor arms over the same segment and prints, per fact,
 * whether it is still in the compacted context and why not (see diagnose.ts).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { factFate, strataLines, type FactFate } from './diagnose.ts';
import { loadSegments, type EvalMessage } from './parse.ts';
import { ARMS, loadPlugin, runArm, type Arm, type PluginApi } from './plugin.ts';
import { CATEGORIES, recallSets, selectRecallFacts, type Pool, type RecallFact, type RecallSet } from './recall-gen.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface RecallConfigFile {
  /** Candidate calls per tool category (raw never-echoed / askable single-carrier / echoed). */
  pool?: Pool;
  description: string;
  session: string;
  cwd: string;
  /** The transcript the facts came from (private; this file is gitignored). */
  file: string;
  segment: number;
  generatedAt: string;
  sets: RecallSet[];
}

function args(argv: string[]): { pos: string[]; flags: Map<string, string> } {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a.startsWith('--')) flags.set(a.slice(2), argv[i + 1] ?? '');
    else if (i === 0 || !argv[i - 1]!.startsWith('--')) pos.push(a);
  }
  return { pos, flags };
}

function transcriptOf(target: string): string {
  if (existsSync(target)) return resolve(target);
  const corpusPath = process.env['VC_EVAL_CORPUS'] ?? join(HERE, 'corpus.local.json');
  const corpus = existsSync(corpusPath) ? (JSON.parse(readFileSync(corpusPath, 'utf8')) as { segments: Array<{ label: string; file: string }> }) : { segments: [] };
  const entry = corpus.segments.find((s) => s.label === target);
  if (!entry) throw new Error(`${target}: not a file or a corpus label`);
  return entry.file;
}

/** Unpinned calls of a segment, as the branch's own collectToolCalls sees them. */
function unpinnedCalls(api: PluginApi, messages: readonly EvalMessage[]) {
  return api.collectToolCalls(messages, 6).filter((c) => !c.pinned);
}

export async function generate(api: PluginApi, file: string, opts: { ne: number; echoed: number; batch: number; seed: number }): Promise<RecallConfigFile> {
  const segs = await loadSegments(file);
  const seg = segs[segs.length - 1]!;
  let pool: Pool | undefined;
  const facts = selectRecallFacts(seg.messages, unpinnedCalls(api, seg.messages), { neverEchoed: opts.ne, echoed: opts.echoed, seed: opts.seed, onPool: (p) => (pool = p) });
  return {
    pool,
    description:
      'GENERATED recall set (eval/recall.ts gen). PRIVATE: keep gitignored. Never-echoed facts are single-carrier tokens of one unpinned tool result; echoed facts are the control. Scored per token as a case-insensitive substring of the joined answers.',
    session: basename(file).replace(/\.jsonl$/, ''),
    cwd: seg.cwd ?? '',
    file,
    segment: seg.index,
    generatedAt: new Date().toISOString(),
    sets: recallSets(facts, opts.batch, opts.seed),
  };
}

/** Generates a set and writes it; refuses a path git would track (the file holds private values). */
export async function writeRecallSet(api: PluginApi, file: string, out: string, opts: { ne: number; echoed: number; batch: number; seed: number }): Promise<void> {
  if (!out || !/(\.local\.json$|\/out\/)/.test(resolve(out))) {
    throw new Error('the recall set needs an output named *.local.json or under eval/out/ (gitignored: it holds private values)');
  }
  const config = await generate(api, file, opts);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), JSON.stringify(config, null, 2) + '\n');
  const facts = config.sets.flatMap((s) => s.facts ?? []);
  const count = (pred: (f: RecallFact) => boolean) => facts.filter(pred).length;
  console.log(`wrote ${out}: ${config.sets.length} sets, ${count((f) => !f.echoed)} never-echoed + ${count((f) => f.echoed)} echoed facts from segment ${config.segment}`);
  for (const c of CATEGORIES) {
    const p = config.pool?.[c];
    console.log(`  ${c}: chose ${count((f) => !f.echoed && f.category === c)} ne / ${count((f) => f.echoed && f.category === c)} echoed; candidate calls ${p ? `${p.rawNeverEchoed} raw → ${p.neverEchoed} askable ne, ${p.echoed} echoed` : '-'}`);
  }
}

export interface FactRow {
  fact: RecallFact;
  arms: Record<Arm, FactFate>;
}

export async function diagnose(api: PluginApi, config: RecallConfigFile, options: Record<string, unknown>): Promise<{ rows: FactRow[]; messages: number }> {
  const segs = await loadSegments(config.file);
  const seg = segs[segs.length - 1]!;
  const opts = seg.cwd && options['cwd'] === undefined ? { ...options, cwd: seg.cwd } : options;
  const results = new Map<string, string>();
  for (const m of seg.messages) for (const r of m.toolResults ?? []) results.set(r.tool_use_id, r.text);
  const calls = api.collectToolCalls(seg.messages, 6);
  const idOf = new Map(calls.map((c) => [c.tool_use_id, c.id]));
  const facts = config.sets.flatMap((s) => s.facts ?? []);
  const rows: FactRow[] = facts.map((fact) => ({ fact, arms: {} as Record<Arm, FactFate> }));
  for (const arm of ARMS) {
    const run = await runArm(api, seg.messages, arm, opts);
    const decisions = new Map(run.result.decisions.map((d) => [d.id, d]));
    for (const row of rows) {
      const d = decisions.get(idOf.get(row.fact.tool_use_id) ?? '');
      row.arms[arm] = factFate(row.fact.token, row.fact.tool_use_id, results.get(row.fact.tool_use_id) ?? '', run.result.messages, false, d);
    }
  }
  return { rows, messages: seg.messages.length };
}

function printDiagnosis(rows: FactRow[], messages: number, head: string): void {
  console.log(`\nrecall diagnosis — src ${head}; segment ${messages} msgs; ${rows.length} facts`);
  console.log('| # | set | kind | category | bucket(age) | rules | trunc | floor |');
  console.log('|---|---|---|---|---|---|---|---|');
  const cell = (f: FactFate) => (f.inContext ? `ok ${f.how}` : `LOST ${f.how} by ${f.by}${f.detail ? ` (${f.detail})` : ''}`);
  rows.forEach((r, i) => {
    const f = r.fact;
    console.log(`| ${i + 1} | ${f.echoed ? 'echoed' : 'never-echoed'} | ${f.kind} | ${f.category} ${f.tool.startsWith('mcp__') ? '' : ''}| ${f.bucket}(${f.age}) | ${cell(r.arms.rules)} | ${cell(r.arms.trunc)} | ${cell(r.arms.floor)} |`);
  });
  const ok = rows.map((r) => ({ fact: r.fact, ok: Object.fromEntries(ARMS.map((a) => [a, r.arms[a].inContext])) }));
  for (const [title, key] of [
    ['set', (f: RecallFact) => (f.echoed ? 'echoed' : 'never-echoed')],
    ['category (never-echoed)', (f: RecallFact) => f.category],
    ['age bucket (never-echoed)', (f: RecallFact) => f.bucket],
  ] as const) {
    const subset = title === 'set' ? ok : ok.filter((r) => !r.fact.echoed);
    console.log(`\nin context by ${title}`);
    for (const l of strataLines(subset, ARMS, key)) console.log(l);
  }
}

async function main(): Promise<void> {
  const { pos, flags } = args(process.argv.slice(2));
  const [cmd, target] = pos;
  const api = await loadPlugin(flags.get('src'));
  if (cmd === 'gen' && target) {
    await writeRecallSet(api, transcriptOf(target), flags.get('out') ?? '', {
      ne: Number(flags.get('ne') ?? 25),
      echoed: Number(flags.get('echoed') ?? 10),
      batch: Number(flags.get('batch') ?? 10),
      seed: Number(flags.get('seed') ?? 1),
    });
    return;
  }
  if (cmd === 'diagnose' && target) {
    const config = JSON.parse(readFileSync(target, 'utf8')) as RecallConfigFile;
    const options = flags.has('options') ? (JSON.parse(flags.get('options')!) as Record<string, unknown>) : {};
    const { rows, messages } = await diagnose(api, config, options);
    printDiagnosis(rows, messages, api.head);
    const json = resolve(flags.get('json') ?? join(HERE, 'out', `diagnose-${config.session.slice(0, 8)}-${api.head.replace(/[^\w.@+-]/g, '_')}.json`));
    mkdirSync(dirname(json), { recursive: true });
    writeFileSync(json, JSON.stringify({ head: api.head, messages, rows }, null, 2) + '\n');
    console.log(`\nJSON: ${json}`);
    return;
  }
  throw new Error('usage: recall.ts gen <label|session.jsonl> --out <file.local.json> | diagnose <recall.json>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
