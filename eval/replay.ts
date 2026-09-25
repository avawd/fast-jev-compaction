/**
 * Repeated-compaction replay: walks a long transcript row by row, compacts whenever the modelled
 * context crosses a threshold, carries the compacted transcript forward and keeps appending the
 * real later rows. Answers whether the plugin keeps clearing its gate on the 2nd, 3rd, ... pass,
 * when the old tool output is already truncated and only new output is prunable.
 *
 *   npm run eval:offline -- --replay <label|file> [--whole] [--arms rules,trunc,floor]
 *       [--window 400000] [--compact-at 0.6] [--auto-at 0.92] [--options '<json>'] [--json <out>]
 *
 * Context tokens are modelled as overhead + a·visible chars + b·hidden (thinking) chars, fitted by
 * least squares to the transcript's own API usage rows (`--fit none` uses the corpus-wide fit).
 * The hook never sees thinking, but the model's context carries it, and verbatim pruning never
 * removes it: only a built-in summary does. No model calls are made.
 */
import { contextBlob, factSets, survival, type Fact } from './facts.ts';
import { carriedPrefix, type EvalMessage, type Segment } from './parse.ts';
import { runArm, type Arm, type PluginApi } from './plugin.ts';

/** The prefix of the plugin's truncation note (src/compact.ts TRUNCATION_NOTE_PREFIX). */
const NOTE = '[verbatim-compaction truncated';

export interface TokenModel {
  overhead: number;
  perVisibleChar: number;
  perHiddenChar: number;
}

/**
 * Least-squares fit over this corpus's 5,897 assistant usage rows (median error 5.5%, p90 11.7%):
 * ~69k tokens of system prompt and tools, 1.54 visible chars per token, 0.16 tokens per thinking char.
 */
export const CORPUS_TOKEN_MODEL: TokenModel = { overhead: 69_465, perVisibleChar: 0.648, perHiddenChar: 0.162 };

export function visibleChars(m: EvalMessage): number {
  let n = m.text.length;
  for (const u of m.toolUses) n += JSON.stringify(u.input).length;
  for (const r of m.toolResults ?? []) n += r.text.length;
  return n;
}

export function estimateTokens(messages: readonly EvalMessage[], hidden: ReadonlyMap<EvalMessage, number>, model: TokenModel): number {
  let visible = 0;
  let thinking = 0;
  for (const m of messages) {
    visible += visibleChars(m);
    thinking += hidden.get(m) ?? 0;
  }
  return model.overhead + visible * model.perVisibleChar + thinking * model.perHiddenChar;
}

export interface UsagePoint {
  visible: number;
  hidden: number;
  usage: number;
}

/** Solves the least-squares problem for `rows · x ≈ y` via its normal equations; undefined if singular. */
function leastSquares(rows: readonly number[][], y: readonly number[]): number[] | undefined {
  const n = rows[0]?.length ?? 0;
  const idx = [...Array(n).keys()];
  const m = idx.map((i) => [...idx.map((j) => rows.reduce((s, r) => s + r[i]! * r[j]!, 0)), rows.reduce((s, r, k) => s + r[i]! * y[k]!, 0)]);
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    if (Math.abs(m[p]![c]!) < 1e-9) return undefined;
    [m[c], m[p]] = [m[p]!, m[c]!];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k += 1) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return idx.map((i) => m[i]![n]! / m[i]![i]!);
}

/**
 * Ordinary least squares for usage ≈ o + a·visible + b·hidden. A transcript with no hidden chars
 * (or `visibleOnly`, for the "thinking is not carried" sensitivity run) fits o + a·visible alone.
 */
export function fitTokenModel(points: readonly UsagePoint[], visibleOnly = false): TokenModel | undefined {
  if (points.length < 4) return undefined;
  const y = points.map((p) => p.usage);
  if (visibleOnly || points.every((p) => p.hidden === 0)) {
    const x = leastSquares(points.map((p) => [1, p.visible]), y);
    return x && { overhead: x[0]!, perVisibleChar: x[1]!, perHiddenChar: 0 };
  }
  const x = leastSquares(points.map((p) => [1, p.visible, p.hidden]), y);
  return x && { overhead: x[0]!, perVisibleChar: x[1]!, perHiddenChar: x[2]! };
}

/** Usage points of a stream: cumulative visible/hidden chars at each row that recorded API usage. */
export function usagePoints(stream: Stream): UsagePoint[] {
  const out: UsagePoint[] = [];
  let visible = 0;
  let hidden = 0;
  stream.messages.forEach((m, i) => {
    if (i >= (stream.fitRows ?? Infinity)) return;
    visible += visibleChars(m);
    hidden += stream.hidden[i] ?? 0;
    const usage = stream.usage?.[i] ?? 0;
    if (usage > 0) out.push({ visible, hidden, usage });
  });
  return out;
}

/** Where a turn ends (turn.complete, reason 'answer'): an assistant row followed by a typed prompt, or the last row. */
export function turnEnds(messages: readonly EvalMessage[]): boolean[] {
  return messages.map((m, i) => {
    if (m.role !== 'assistant') return false;
    const next = messages[i + 1];
    return !next || (next.role === 'user' && !(next.toolResults?.length ?? 0));
  });
}

export function noteCount(text: string): number {
  let n = 0;
  for (let at = text.indexOf(NOTE); at >= 0; at = text.indexOf(NOTE, at + NOTE.length)) n += 1;
  return n;
}

export interface Idempotence {
  /** Results that already carried a truncation note going into this pass. */
  truncatedBefore: number;
  /** ...of which this pass shortened again. */
  reshrunk: number;
  /** Results that come out with more than one note. */
  nested: number;
  /** ...previously truncated results this pass removed entirely. */
  dropped: number;
}

function results(messages: readonly EvalMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) for (const r of m.toolResults ?? []) out.set(r.tool_use_id, r.text);
  return out;
}

export function idempotence(before: readonly EvalMessage[], after: readonly EvalMessage[]): Idempotence {
  const a = results(after);
  let truncatedBefore = 0;
  let reshrunk = 0;
  let dropped = 0;
  for (const [id, text] of results(before)) {
    if (noteCount(text) === 0) continue;
    truncatedBefore += 1;
    const now = a.get(id);
    if (now === undefined) dropped += 1;
    else if (now.length < text.length) reshrunk += 1;
  }
  let nested = 0;
  for (const text of a.values()) if (noteCount(text) > 1) nested += 1;
  return { truncatedBefore, reshrunk, nested, dropped };
}

export interface Stream {
  messages: EvalMessage[];
  /** Hidden (thinking) chars per row. */
  hidden: number[];
  /** API usage tokens per row (0 where none). */
  usage?: number[];
  /** Rows whose usage measured this stream's own context: up to the first real compaction. */
  fitRows?: number;
}

/**
 * One uninterrupted row stream. Later segments lose their summary row and whatever rows the
 * compaction carried over (Claude Code keeps a few recent ones), so every real row appears once.
 */
export function buildStream(segments: readonly Segment[]): Stream {
  const out: Stream = { messages: [], hidden: [], usage: [] };
  segments.forEach((seg, i) => {
    let start = 0;
    if (i > 0) {
      start = seg.startsWithSummary ? 1 : 0;
      start += carriedPrefix(out.messages, seg.messages.slice(start)).length;
    }
    for (let k = start; k < seg.messages.length; k += 1) {
      out.messages.push(seg.messages[k]!);
      out.hidden.push(seg.hiddenChars[k] ?? 0);
      out.usage!.push(seg.usageTokens[k] ?? 0);
    }
    if (i === 0) out.fitRows = out.messages.length;
  });
  return out;
}

export interface ReplayConfig {
  model: TokenModel;
  window: number;
  /** The plugin's compactAtPercent / 100: requested at a turn end once context reaches it. */
  compactAt: number;
  /** Claude Code's own auto-compact point: fires at any row, even while the plugin is waiting. */
  autoAt: number;
  minReduction: number;
  options: Record<string, unknown>;
  /** Size of a built-in summary, in tokens (the corpus's summaries were 13k-16k). */
  summaryTokens?: number;
  /** Rows a built-in summary keeps after itself (the corpus's boundaries preserved 6-7). */
  summaryKeeps?: number;
}

export interface Compaction {
  at: number;
  trigger: 'plugin' | 'auto';
  tokensBefore: number;
  tokensAfter: number;
  rowsBefore: number;
  rowsAfter: number;
  gate: number;
  pass: boolean;
  /** Whether the context had already been verbatim-compacted before this pass. */
  prior: boolean;
  /** 2 when compact() escalated to its stricter tier (see src/escalate.ts). */
  tier: 1 | 2;
  /** Tool-result chars in the context before this pass, and how many were already truncated/decided. */
  resultChars: number;
  facts: { survived: number; total: number };
  laterRef: { lost: number; total: number };
  idempotence: Idempotence;
  /** The compaction left the context at or over Claude Code's auto-compact point. */
  overflow: boolean;
}

export interface ReplayReport {
  arm: Arm;
  rows: number;
  compactions: Compaction[];
  /** The plugin's own requests it declined (gate not met, no summary): nothing changed. */
  skips: Array<{ at: number; gate: number }>;
  final: { tokens: number; facts: { survived: number; total: number } };
  /**
   * Never-echoed survival averaged over the session: sampled every `SAMPLE_EVERY` rows, the share of
   * facts introduced so far that the context still holds. Less sensitive than `final` to where the
   * last fallback happens to fall.
   */
  meanSurvival: number;
}

const SAMPLE_EVERY = 25;

function summaryMessage(tokens: number, model: TokenModel): EvalMessage {
  // Filler with no distinctive tokens: a summary's facts are not credited (a conservative bound).
  return { role: 'user', text: 'summary '.repeat(Math.max(1, Math.round(tokens / model.perVisibleChar / 8))), toolUses: [] };
}

function factSurvival(facts: readonly Fact[], upTo: number, context: readonly EvalMessage[]): { survived: number; total: number } {
  const blob = contextBlob(context);
  let survived = 0;
  let total = 0;
  for (const f of facts) {
    if (f.resultIndex > upTo) continue;
    total += 1;
    if (blob.includes(f.token)) survived += 1;
  }
  return { survived, total };
}

function allCalls(messages: readonly EvalMessage[]) {
  const at = new Map<string, number>();
  messages.forEach((m, i) => {
    for (const r of m.toolResults ?? []) at.set(r.tool_use_id, i);
  });
  return messages.flatMap((m) => m.toolUses.flatMap((u) => {
    const resultIndex = at.get(u.tool_use_id);
    return resultIndex === undefined ? [] : [{ tool_use_id: u.tool_use_id, tool: u.tool, resultIndex }];
  }));
}

export async function replay(api: PluginApi, stream: Stream, arm: Arm, cfg: ReplayConfig): Promise<ReplayReport> {
  const ends = turnEnds(stream.messages);
  const neverEchoed = factSets(stream.messages, allCalls(stream.messages)).neverEchoed;
  const hidden = new Map<EvalMessage, number>();
  let context: EvalMessage[] = [];
  let tokens = cfg.model.overhead;
  let awaitingDrop = false;
  let autoThisTurn = false;
  let verbatimPasses = 0;
  const compactions: Compaction[] = [];
  const skips: Array<{ at: number; gate: number }> = [];
  const summaryKeeps = cfg.summaryKeeps ?? 6;

  const compactNow = async (at: number, trigger: Compaction['trigger']): Promise<void> => {
    // escalateBelow: the hook's own option (tier 2 on a compacted transcript); ignored by older branches.
    const run = await runArm(api, context, arm, { ...cfg.options, escalateBelow: cfg.minReduction });
    const gate = api.reductionRatio(run.result);
    const outcome = api.gateOutcome(gate, cfg.minReduction, trigger);
    if (outcome === 'skip') {
      skips.push({ at, gate: Math.round(gate * 1000) / 1000 });
      return;
    }
    const pass = outcome === 'prune';
    const before = context;
    const priorPasses = verbatimPasses;
    const prefix = stream.messages.slice(0, at + 1);
    if (pass) {
      context = [...run.result.messages];
      verbatimPasses += 1;
    } else {
      verbatimPasses = 0;
      context = [summaryMessage(cfg.summaryTokens ?? 15_000, cfg.model), ...before.slice(-summaryKeeps)];
    }
    const after = estimateTokens(context, hidden, cfg.model);
    const later = survival(factSets(prefix, allCalls(prefix)), context, prefix);
    compactions.push({
      at,
      trigger,
      tokensBefore: Math.round(tokens),
      tokensAfter: Math.round(after),
      rowsBefore: before.length,
      rowsAfter: context.length,
      gate: Math.round(gate * 1000) / 1000,
      pass,
      tier: run.result.stats['tier'] === 2 ? 2 : 1,
      prior: pass ? verbatimPasses > 1 : priorPasses > 0,
      resultChars: before.reduce((s, m) => s + (m.toolResults ?? []).reduce((t, r) => t + r.text.length, 0), 0),
      facts: factSurvival(neverEchoed, at, context),
      laterRef: { lost: later.laterRefLost, total: later.laterRefTotal },
      idempotence: idempotence(before, pass ? context : []),
      overflow: after >= cfg.autoAt * cfg.window,
    });
    tokens = after;
  };

  const samples: number[] = [];
  for (let i = 0; i < stream.messages.length; i += 1) {
    if (i > 0 && i % SAMPLE_EVERY === 0) {
      const f = factSurvival(neverEchoed, i - 1, context);
      if (f.total > 0) samples.push(f.survived / f.total);
    }
    const row = stream.messages[i]!;
    context.push(row);
    hidden.set(row, stream.hidden[i] ?? 0);
    tokens += visibleChars(row) * cfg.model.perVisibleChar + (stream.hidden[i] ?? 0) * cfg.model.perHiddenChar;
    // Claude Code's own auto-compact: before a request, at most once per turn here (the engine
    // backs off after failures; a context no compaction brings under it is reported as overflow).
    if (tokens >= cfg.autoAt * cfg.window && !autoThisTurn) {
      autoThisTurn = true;
      await compactNow(i, 'auto');
      continue;
    }
    if (!ends[i]) continue;
    autoThisTurn = false;
    // The hook's turn.complete: clears the wait under the threshold, else requests once per drop.
    if (tokens < cfg.compactAt * cfg.window) awaitingDrop = false;
    else if (!awaitingDrop) {
      await compactNow(i, 'plugin');
      awaitingDrop = true;
    }
  }
  return {
    arm,
    rows: stream.messages.length,
    compactions,
    skips,
    final: { tokens: Math.round(tokens), facts: factSurvival(neverEchoed, stream.messages.length, context) },
    meanSurvival: samples.length === 0 ? 0 : Math.round((samples.reduce((x, y) => x + y, 0) / samples.length) * 1000) / 10,
  };
}
