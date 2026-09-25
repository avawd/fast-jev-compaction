/**
 * `npm run eval:offline -- --replay <label|file>`: the command-line side of eval/replay.ts.
 * See that file and eval/README.md ("Replay") for the model and the columns.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSegments } from './parse.ts';
import { ARMS, type Arm, type PluginApi } from './plugin.ts';
import {
  buildStream,
  CORPUS_TOKEN_MODEL,
  fitTokenModel,
  replay,
  usagePoints,
  type ReplayConfig,
  type ReplayReport,
  type Stream,
  type TokenModel,
} from './replay.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface Entry {
  label: string;
  file: string;
  segment: number;
}

function num(a: Map<string, string[]>, key: string, fallback: number): number {
  const v = a.get(key)?.[0];
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${key} ${v}: not a number`);
  return n;
}

function k(n: number): string {
  return `${Math.round(n / 1000)}k`;
}

function pct(a: number, b: number): string {
  return b === 0 ? '-' : `${Math.round((a / b) * 1000) / 10}%`;
}

function modelError(stream: Stream, model: TokenModel): string {
  const errs = usagePoints(stream)
    .map((p) => Math.abs(model.overhead + p.visible * model.perVisibleChar + p.hidden * model.perHiddenChar - p.usage) / p.usage)
    .sort((x, y) => x - y);
  if (errs.length === 0) return 'no usage rows';
  return `median error ${pct(errs[Math.floor(errs.length / 2)]!, 1)}, p90 ${pct(errs[Math.floor(errs.length * 0.9)]!, 1)} over ${errs.length} usage rows`;
}

function printReport(r: ReplayReport, cfg: ReplayConfig): void {
  const passes = r.compactions.filter((c) => c.pass);
  const fallbacks = r.compactions.filter((c) => !c.pass);
  console.log(
    `\narm ${r.arm}: ${r.compactions.length} compactions, ${passes.length} verbatim, ${fallbacks.length} fallbacks ` +
      `(${fallbacks.filter((c) => c.prior).length} after a verbatim pass), ${r.skips.length} skipped, ${r.compactions.filter((c) => c.overflow).length} left context over auto-compact; ` +
      `never-echoed survival: mean ${r.meanSurvival}% over the session, final ${pct(r.final.facts.survived, r.final.facts.total)} of ${r.final.facts.total}`,
  );
  const head = ['#', 'row', 'trig', 'prior', 'tier', 'ctx before→after', 'gate', 'outcome', 'res chars', 'never-echoed surv', 'laterRef lost', 'truncated in / re-shrunk / nested / dropped'];
  const rows = r.compactions.map((c, i) => [
    String(i + 1),
    String(c.at),
    c.trigger,
    c.prior ? 'yes' : '-',
    String(c.tier),
    `${k(c.tokensBefore)}→${k(c.tokensAfter)}${c.overflow ? ' OVER' : ''}`,
    c.gate.toFixed(3),
    c.pass ? 'verbatim' : 'FALLBACK',
    k(c.resultChars),
    `${pct(c.facts.survived, c.facts.total)} of ${c.facts.total}`,
    `${c.laterRef.lost}/${c.laterRef.total}`,
    `${c.idempotence.truncatedBefore} / ${c.idempotence.reshrunk} / ${c.idempotence.nested} / ${c.idempotence.dropped}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  console.log(line(head));
  console.log(`|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`);
  for (const row of rows) console.log(line(row));
  void cfg;
}

export async function replayMain(api: PluginApi, a: Map<string, string[]>, corpus: readonly Entry[]): Promise<void> {
  const target = a.get('replay')?.[0];
  if (!target) throw new Error('--replay needs a corpus label or a transcript path');
  const entry = corpus.find((c) => c.label === target) ?? (existsSync(target) ? { label: basename(target), file: target, segment: -1 } : undefined);
  if (!entry) throw new Error(`--replay ${target}: not a corpus label or a file`);
  const segs = await loadSegments(entry.file);
  const whole = a.has('whole');
  const index = entry.segment < 0 ? segs.length - 1 : entry.segment;
  const seg = segs[index];
  if (!whole && !seg) throw new Error(`${entry.label}: segment ${index} absent (${segs.length} segments)`);
  const stream = whole ? buildStream(segs) : buildStream([seg!]);

  // --fit corpus: the corpus-wide model; --fit visible: no hidden term (a sensitivity run).
  const fit = a.get('fit')?.[0];
  const fitted = fit === 'corpus' ? undefined : fitTokenModel(usagePoints(stream), fit === 'visible');
  const model = fitted ?? (fit === 'visible' ? { ...CORPUS_TOKEN_MODEL, perHiddenChar: 0 } : CORPUS_TOKEN_MODEL);
  const options = a.has('options') ? (JSON.parse(a.get('options')![0] ?? '{}') as Record<string, unknown>) : {};
  const cwd = [...segs].reverse().find((s) => s.cwd)?.cwd;
  const cfg: ReplayConfig = {
    model,
    window: num(a, 'window', 400_000),
    compactAt: num(a, 'compact-at', 0.6),
    autoAt: num(a, 'auto-at', 0.92),
    minReduction: num(a, 'min-reduction', (options['minReductionRatio'] as number | undefined) ?? 0.25),
    options: cwd && options['cwd'] === undefined ? { ...options, cwd } : options,
  };
  const arms = (a.get('arms')?.[0]?.split(',') ?? [...ARMS]) as Arm[];

  console.log(`verbatim-compaction replay — src ${api.srcDir} (${api.head}); ${entry.label}${whole ? ` (whole file, ${segs.length} segments)` : ` [${index}]`}: ${stream.messages.length} rows`);
  console.log(
    `token model (${fitted ? 'fitted to this transcript' : 'corpus fit'}): ${Math.round(model.overhead)} + ${model.perVisibleChar.toFixed(3)}·visible + ` +
      `${model.perHiddenChar.toFixed(3)}·hidden (thinking-char proxy); ${modelError(stream, model)}`,
  );
  console.log(`window ${k(cfg.window)}; plugin requests at ${cfg.compactAt * 100}% (${k(cfg.window * cfg.compactAt)}), Claude Code auto-compacts at ${cfg.autoAt * 100}%; gate ${cfg.minReduction}; options ${JSON.stringify(options)}`);

  const reports: ReplayReport[] = [];
  for (const arm of arms) {
    const started = Date.now();
    const r = await replay(api, stream, arm, cfg);
    reports.push(r);
    printReport(r, cfg);
    console.error(`  ${arm}: ${Date.now() - started}ms`);
  }
  const jsonPath = resolve(a.get('json')?.[0] ?? join(HERE, 'out', `replay-${entry.label}${whole ? '-whole' : ''}-${api.head.replace(/[^\w.@+-]/g, '_')}.json`));
  mkdirSync(dirname(jsonPath), { recursive: true });
  const { options: _o, ...shown } = cfg;
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), head: api.head, label: entry.label, whole, config: { ...shown, options }, reports }, null, 2) + '\n');
  console.log(`\nJSON: ${jsonPath}`);
}
