/**
 * Per-fact results of one live run, for recall configs written by recall.ts gen (sets with `facts`).
 * For every fact: was it answered, was it in the forked transcript before compaction, is it in the
 * context after, and if not, what cut it. The cut is read from the carried rows (see diagnose.ts);
 * its author comes from re-running the plugin's rules arm over the same pre-compact messages, since
 * a live run's decisions are not logged (attributeLive).
 */
import { attributeLive, factFate, liveVerdict, type How } from './diagnose.ts';
import { carriedPrefix, loadSegments } from './parse.ts';
import { loadPlugin, runArm } from './plugin.ts';
import type { RecallFact } from './recall-gen.ts';

export interface LiveFactRow {
  set: string;
  token: string;
  kind: string;
  category: string;
  bucket: string;
  age: number;
  echoed: boolean;
  hit: boolean;
  before: boolean;
  after: boolean;
  how: How;
  by: string;
  detail?: string;
  verdict: string;
}

export async function liveFactRows(
  transcript: string,
  sets: ReadonlyArray<{ name: string; facts?: RecallFact[] }>,
  answer: string,
  failed: boolean,
  /** The plugin dir the run loaded, for rule attribution; undefined for a no-plugin baseline. */
  pluginDir: string | undefined,
): Promise<LiveFactRow[] | undefined> {
  const facts = sets.flatMap((s) => (s.facts ?? []).map((f) => ({ set: s.name, fact: f })));
  if (facts.length === 0) return undefined;
  const segs = await loadSegments(transcript);
  const lastBoundary = segs.map((s) => s.boundary !== undefined).lastIndexOf(true);
  if (lastBoundary < 0 || !segs[lastBoundary + 1]) return undefined;
  const pre = segs[lastBoundary]!;
  const next = segs[lastBoundary + 1]!;
  const summary = next.startsWithSummary;
  const context = summary ? next.messages.slice(0, 1) : carriedPrefix(pre.messages, next.messages);
  const results = new Map<string, string>();
  for (const m of pre.messages) for (const r of m.toolResults ?? []) results.set(r.tool_use_id, r.text);

  let rules: Map<string, { action: string; source: string; rule?: string }> | undefined;
  if (pluginDir && !summary) {
    const api = await loadPlugin(pluginDir);
    const run = await runArm(api, pre.messages, 'rules', pre.cwd ? { cwd: pre.cwd } : {});
    const byId = new Map(api.collectToolCalls(pre.messages, 6).map((c) => [c.id, c.tool_use_id]));
    rules = new Map(run.result.decisions.map((d) => [byId.get(d.id) ?? '', d]));
  }
  const a = answer.toLowerCase();
  return facts.map(({ set, fact }) => {
    const original = results.get(fact.tool_use_id);
    const fate = factFate(fact.token, fact.tool_use_id, original ?? '', context, summary);
    const by = summary ? fate.by : attributeLive(fate.how, rules?.get(fact.tool_use_id));
    const row = {
      hit: !failed && a.includes(fact.token.toLowerCase()),
      before: original?.includes(fact.token) ?? false,
      after: fate.inContext,
      how: fate.how,
      by,
      ...(fate.detail ? { detail: fate.detail } : {}),
    };
    return {
      set,
      token: fact.token,
      kind: fact.kind,
      category: fact.category,
      bucket: fact.bucket,
      age: fact.age,
      echoed: fact.echoed,
      ...row,
      verdict: liveVerdict(row),
    };
  });
}
