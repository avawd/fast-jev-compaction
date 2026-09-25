/**
 * Why a recall fact did or did not survive a compaction, per fact: the one
 * result that carried it (see recall-gen.ts, single carrier) is looked up in the
 * compacted context and classified.
 *
 *  - whole: the result is there, untouched
 *  - truncated-kept / truncated-cut: the truncation note is there; the token is
 *    inside / outside the kept head + tail window
 *  - dropped: no result for the call remains (drop_call)
 *  - stripped: the result is there without a note but lost the token (MCP
 *    furniture stripping is the only other rewrite)
 *  - summary-kept / summary-lost: the context is a built-in summary
 *
 * `by` names the decision: `rule:<name>`, `claude`, `pinned`, or for a live run
 * the attribution from the offline rules arm (see attributeLive).
 */
import { contextBlob } from './facts.ts';
import type { EvalMessage } from './parse.ts';

/** Mirrors src/compact.ts TRUNCATION_NOTE_PREFIX; the eval never imports a branch's src statically. */
export const TRUNCATION_NOTE = '[verbatim-compaction truncated';

export type How = 'whole' | 'truncated-kept' | 'truncated-cut' | 'dropped' | 'stripped' | 'summary-kept' | 'summary-lost';

export interface DecisionLike {
  action: string;
  source: string;
  rule?: string;
  headChars?: number;
}

export interface FactFate {
  inContext: boolean;
  how: How;
  by: string;
  detail?: string;
}

export function decisionLabel(d: DecisionLike | undefined): string {
  if (!d) return 'unknown';
  if (d.source === 'rule') return `rule:${d.rule ?? '?'}`;
  return d.source;
}

/**
 * A live run's decisions are not logged, but the rules are deterministic: when the offline rules arm
 * over the same messages made a non-keep decision for the call, the rule made the live cut too;
 * otherwise the only other source of a cut is the Claude stage.
 */
export function attributeLive(how: How, ruleDecision: DecisionLike | undefined): string {
  if (how === 'whole' || how === 'summary-kept' || how === 'summary-lost') return how === 'whole' ? '-' : 'built-in summary';
  if (how === 'stripped') return 'stripMcpFurniture';
  if (ruleDecision && ruleDecision.action !== 'keep') return decisionLabel(ruleDecision);
  return 'claude';
}

export function factFate(
  token: string,
  toolUseId: string,
  originalResult: string,
  compacted: readonly EvalMessage[],
  summary: boolean,
  decision?: DecisionLike,
): FactFate {
  const inContext = contextBlob(compacted).includes(token);
  if (summary) return { inContext, how: inContext ? 'summary-kept' : 'summary-lost', by: 'built-in summary' };
  let text: string | undefined;
  for (const m of compacted) for (const r of m.toolResults ?? []) if (r.tool_use_id === toolUseId) text = r.text;
  const by = decisionLabel(decision);
  if (text === undefined) return { inContext, how: 'dropped', by };
  const note = text.indexOf(TRUNCATION_NOTE);
  if (note < 0) return text.includes(token) ? { inContext, how: 'whole', by } : { inContext, how: 'stripped', by: 'stripMcpFurniture' };
  const close = text.indexOf(']', note);
  const head = Math.max(0, note - 1); // the note follows a '\n' when a head was kept
  const tail = close < 0 ? 0 : Math.max(0, text.length - close - 2);
  const at = originalResult.indexOf(token);
  const keptHead = note > 0 ? head : 0;
  const detail = `at ${at}/${originalResult.length}; kept head ${keptHead} + tail ${tail}`;
  if (text.includes(token)) return { inContext, how: 'truncated-kept', by, detail };
  // Inside the head window yet gone: MCP furniture stripping removed it before the cut (it runs first,
  // on the text that is then truncated), so the truncation is not what lost it.
  if (at >= 0 && at + token.length <= keptHead) return { inContext, how: 'stripped', by: 'stripMcpFurniture', detail };
  return { inContext, how: 'truncated-cut', by, detail };
}

export interface LiveFact {
  hit: boolean;
  /** In the forked transcript before compaction. */
  before: boolean;
  /** In the context after compaction (carried rows or summary). */
  after: boolean;
  how: How;
  by: string;
  detail?: string;
}

/** One line on what happened to a fact in a live run, most basic explanation first. */
export function liveVerdict(f: LiveFact): string {
  if (f.hit) return f.after ? 'recalled' : 'recalled (not in context: guessed or re-derived)';
  if (!f.before) return 'not in pre-compact context';
  if (f.after) return 'in context, model missed';
  return `${f.how} by ${f.by}${f.detail ? ` (${f.detail})` : ''}`;
}

function pct(a: number, b: number): string {
  return b === 0 ? '-' : `${Math.round((a / b) * 100)}%`;
}

/** A markdown table: `kept/total (pct)` per value of `key`, one column per name in `columns`. */
export function strataLines<F>(
  rows: ReadonlyArray<{ fact: F; ok: Record<string, boolean> }>,
  columns: readonly string[],
  key: (f: F) => string,
): string[] {
  const groups = new Map<string, Array<(typeof rows)[number]>>();
  for (const r of rows) (groups.get(key(r.fact)) ?? groups.set(key(r.fact), []).get(key(r.fact))!).push(r);
  const out = [`| stratum | n | ${columns.join(' | ')} |`, `|---|---|${columns.map(() => '---|').join('')}`];
  for (const [k, g] of [...groups].sort(([x], [y]) => x.localeCompare(y))) {
    const cells = columns.map((c) => {
      const n = g.filter((r) => r.ok[c]).length;
      return `${n}/${g.length} (${pct(n, g.length)})`;
    });
    out.push(`| ${k} | ${g.length} | ${cells.join(' | ')} |`);
  }
  return out;
}
