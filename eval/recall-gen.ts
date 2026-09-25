/**
 * Builds a recall question set for the live eval from one segment, with enough
 * facts to carry statistical weight and strata to say where recall is lost.
 *
 *  - never-echoed facts (the test): a token only ONE tool result in the whole
 *    segment carries, which no assistant text, user text or tool input repeats.
 *    Only verbatim retention of that one result can answer it, so a miss has one
 *    place to look.
 *  - echoed facts (the control): introduced by a tool result and repeated in
 *    later assistant text, so a summary can keep them as well.
 *
 * Facts are stratified by tool category and by age bucket (position quartile in
 * the segment), one fact per call, deterministically for a seed. Each becomes a
 * cloze item: the call, and its line with the token blanked. Every other chosen
 * token is masked in every item, so no question gives away another's answer.
 * The output names private sessions and holds private values, so it is written
 * only to gitignored files (eval/*.local.json, eval/out/).
 */
import { factSets, type Fact } from './facts.ts';
import type { EvalMessage, EvalToolUse } from './parse.ts';

export const CATEGORIES = ['Bash', 'Read', 'Grep', 'MCP', 'Agent', 'Other'] as const;
export type Category = (typeof CATEGORIES)[number];
export const BUCKETS = ['oldest', 'old', 'recent', 'newest'] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Kinds worth asking about, best first: a recalled one of these cannot be a guess. */
const KIND_RANK = ['jira', 'pr', 'sha', 'url', 'money', 'num'];
const KIND_NOUN: Record<string, string> = {
  jira: 'a ticket key',
  pr: 'a #number',
  sha: 'a hex id / sha',
  url: 'a URL',
  money: 'a dollar amount',
  num: 'a number',
};
/** Line context each side of the blank; enough to find the line, too little to carry another fact. */
const CONTEXT_CHARS = 48;
const MIN_CONTEXT = 8;
const DESC_CHARS = 100;
const MASK = '…';
/**
 * Lines holding transport ids nobody would ask about (invocation, message, request, agent ids), and
 * MCP self links, which the plugin strips as furniture on purpose (stripMcpFurniture).
 */
const PLUMBING = /\b(?:agentId|msg_id|invocationId|requestId|request_id|traceId|trace_id|toolu_|session_?id)\b|"self":/i;
/** Punctuation a URL or path match can swallow (markdown backticks, bold, sentence ends). */
const TRAILING = /[`'"*.,;:!?)\]]+$/;

export function toolCategory(tool: string): Category {
  if (tool === 'Bash') return 'Bash';
  if (tool === 'Read') return 'Read';
  if (tool === 'Grep' || tool === 'Glob' || tool === 'LS') return 'Grep';
  if (tool.startsWith('mcp__')) return 'MCP';
  if (tool === 'Agent' || tool === 'Task') return 'Agent';
  return 'Other';
}

export function ageBucket(resultIndex: number, total: number): Bucket {
  const q = Math.min(3, Math.max(0, Math.floor((4 * resultIndex) / Math.max(1, total))));
  return BUCKETS[q]!;
}

function inputJson(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

/** True when `token` occurs in the result of `toolUseId` and nowhere else in the segment. */
export function singleCarrier(token: string, toolUseId: string, messages: readonly EvalMessage[]): boolean {
  let carriers = 0;
  for (const m of messages) {
    if (m.text.includes(token)) return false;
    for (const u of m.toolUses) if (inputJson(u.input).includes(token)) return false;
    for (const r of m.toolResults ?? []) {
      if (!r.text.includes(token)) continue;
      if (r.tool_use_id !== toolUseId) return false;
      carriers += 1;
    }
  }
  return carriers === 1;
}

// Same elision the scorer applies to what it forwards (src/jev-scorer.ts elideSecrets); duplicated so the
// eval never depends on a branch's src/ for the questions it writes.
const ENV_ASSIGNMENT = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g;
const HEADER = /(-H|--header)(\s+)(["'])([A-Za-z0-9-]+):[^"']*\3/g;
const HEREDOC = /<<-?\s*(["']?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g;

function elide(command: string): string {
  return command
    .replace(HEREDOC, (_m, _q: string, tag: string) => `<<${tag} …>`)
    .replace(HEADER, (_m, flag: string, space: string, quote: string, name: string) => `${flag}${space}${quote}${name}: …${quote}`)
    .replace(ENV_ASSIGNMENT, (_m, lead: string, name: string) => `${lead}${name}=…`);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** How a question names the call: `Bash <command>`, `Read <path>`, `<mcpTool> <input>`. */
export function callDescription(use: Pick<EvalToolUse, 'tool_use_id' | 'tool' | 'input'>): string {
  let body: string;
  const tool = use.tool.startsWith('mcp__') ? use.tool.split('__').pop()! : use.tool;
  if (use.tool === 'Bash' && typeof use.input['command'] === 'string') body = elide(use.input['command']);
  else if (typeof use.input['file_path'] === 'string') body = use.input['file_path'];
  else if (typeof use.input['pattern'] === 'string') body = `pattern ${use.input['pattern']}${typeof use.input['path'] === 'string' ? ` in ${use.input['path']}` : ''}`;
  else if (typeof use.input['description'] === 'string') body = use.input['description'];
  else body = inputJson(use.input);
  const text = oneLine(`${tool} ${body}`);
  return text.length <= DESC_CHARS ? text : `${text.slice(0, DESC_CHARS - 1)}…`;
}

function maskAll(text: string, tokens: readonly string[]): string {
  let out = text;
  for (const t of tokens) if (t.length > 0) out = out.split(t).join(MASK);
  return out;
}

/**
 * One cloze item: "In the result of `<call>`, fill the blank: “<before> ___ <after>” (<kind>)".
 * Undefined when the token's line has too little context to locate it.
 */
function lineOf(text: string, at: number): string {
  const end = text.indexOf('\n', at);
  return text.slice(text.lastIndexOf('\n', at) + 1, end < 0 ? undefined : end);
}

export function clozeItem(
  fact: Pick<Fact, 'token' | 'kind'>,
  resultText: string,
  description: string,
  mask: readonly string[],
): string | undefined {
  const at = resultText.indexOf(fact.token);
  if (at < 0) return undefined;
  const others = [...mask.filter((t) => t !== fact.token), fact.token];
  // The window may cross lines (a value alone on its line is common: `ℹ tests 9283`); ⏎ marks a break.
  const around = (text: string) => maskAll(text.replace(/\r?\n/g, ' ⏎ ').replace(/\s+/g, ' ').trim(), others);
  const before = around(resultText.slice(Math.max(0, at - CONTEXT_CHARS), at));
  const after = around(resultText.slice(at + fact.token.length, at + fact.token.length + CONTEXT_CHARS));
  if (before.replace(/[^A-Za-z0-9]/g, '').length + after.replace(/[^A-Za-z0-9]/g, '').length < MIN_CONTEXT) return undefined;
  const call = maskAll(description, others).replace(/`/g, "'");
  return `In the result of \`${call}\`, fill the blank: “${before} ___ ${after}” (${KIND_NOUN[fact.kind] ?? 'a value'}).`;
}

export interface RecallFact {
  token: string;
  kind: string;
  tool: string;
  category: Category;
  bucket: Bucket;
  tool_use_id: string;
  resultIndex: number;
  /** Messages after the result, at generation time. */
  age: number;
  echoed: boolean;
  item: string;
}

export interface RecallSet {
  name: string;
  question: string;
  expected: string[];
  facts?: RecallFact[];
}

/** mulberry32: a tiny deterministic PRNG, so a seed reproduces a selection. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Interleaves lists round-robin: [a1,b1,c1,a2,b2,...]. */
function interleave<T>(lists: readonly T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i += 1) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

/** Best fact per call (kind rank, then earliest), stratified: categories round-robin, buckets round-robin within each. */
function stratify(facts: readonly Fact[], total: number, n: number, rand: () => number): Fact[] {
  const perCall = new Map<string, Fact>();
  const rank = (k: string) => KIND_RANK.indexOf(k);
  for (const f of facts) {
    const cur = perCall.get(f.tool_use_id);
    if (!cur || rank(f.kind) < rank(cur.kind)) perCall.set(f.tool_use_id, f);
  }
  const byCategory = CATEGORIES.map((c) => {
    const mine = [...perCall.values()].filter((f) => toolCategory(f.tool) === c);
    return interleave(BUCKETS.map((b) => shuffle(mine.filter((f) => ageBucket(f.resultIndex, total) === b), rand)));
  });
  return interleave(byCategory).slice(0, n);
}

/** Candidates per category before selection: raw never-echoed facts, then after the askable/single-carrier filters. */
export type Pool = Record<Category, { rawNeverEchoed: number; neverEchoed: number; echoed: number }>;

export interface SelectOptions {
  neverEchoed: number;
  echoed: number;
  seed: number;
  /** Receives the candidate pool, so a report can say whether an empty stratum is rare or filtered. */
  onPool?: (pool: Pool) => void;
}

/**
 * Chooses the recall facts of one segment. `calls` are its unpinned calls (the plugin's own
 * collectToolCalls), so a fact is never one the compaction was not allowed to touch.
 */
export function selectRecallFacts(
  messages: readonly EvalMessage[],
  calls: ReadonlyArray<{ tool_use_id: string; tool: string; resultIndex: number }>,
  options: SelectOptions,
): RecallFact[] {
  const rand = prng(options.seed);
  const sets = factSets(messages, calls);
  const results = new Map<string, string>();
  const uses = new Map<string, EvalToolUse>();
  for (const m of messages) {
    for (const r of m.toolResults ?? []) results.set(r.tool_use_id, r.text);
    for (const u of m.toolUses) uses.set(u.tool_use_id, u);
  }
  const assistantBlob = messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');
  const askable = (f: Fact) => {
    const text = results.get(f.tool_use_id) ?? '';
    const at = text.indexOf(f.token);
    if (at < 0 || !uses.has(f.tool_use_id)) return false;
    // A number of 4 digits is too easy to hit by accident in an answer; keep 5+.
    if (f.kind === 'num' && f.token.length < 5) return false;
    // A hex run glued to more word or uuid characters is a fragment (a uuid's first group), not a value.
    if (/[\w-]/.test(text[at - 1] ?? '') || /[\w-]/.test(text[at + f.token.length] ?? '')) return false;
    if (PLUMBING.test(lineOf(text, at))) return false;
    // A link ending in a number the assistant quoted (`…/pull/912` after "#912") can be rebuilt from a summary.
    const tail = f.kind === 'url' ? f.token.match(/\/(\d{2,})\/?$/)?.[1] : undefined;
    return !tail || !new RegExp(`(?<![\\w.])${tail}(?![\\w])`).test(assistantBlob);
  };
  const clean = (list: Fact[]) => list.map((f) => ({ ...f, token: f.token.replace(TRAILING, '') })).filter(askable);
  const neAll = clean(sets.neverEchoed).filter((f) => singleCarrier(f.token, f.tool_use_id, messages));
  const ecAll = clean(sets.echoed);
  if (options.onPool) {
    const count = (list: Fact[], c: Category) => new Set(list.filter((f) => toolCategory(f.tool) === c).map((f) => f.tool_use_id)).size;
    options.onPool(Object.fromEntries(CATEGORIES.map((c) => [c, { rawNeverEchoed: count(sets.neverEchoed, c), neverEchoed: count(neAll, c), echoed: count(ecAll, c) }])) as Pool);
  }
  // Items are built for every candidate first, so a call whose best-ranked token cannot be asked
  // (no context around it) still offers its next one, and masking covers every token that might be chosen.
  const mask = [...neAll, ...ecAll].map((f) => f.token);
  const items = new Map<Fact, string>();
  for (const f of [...neAll, ...ecAll]) {
    const item = clozeItem(f, results.get(f.tool_use_id) ?? '', callDescription(uses.get(f.tool_use_id)!), mask);
    if (item) items.set(f, item);
  }
  const ne = stratify(neAll.filter((f) => items.has(f)), messages.length, options.neverEchoed, rand);
  const neCalls = new Set(ne.map((f) => f.tool_use_id));
  const ec = stratify(ecAll.filter((f) => items.has(f) && !neCalls.has(f.tool_use_id)), messages.length, options.echoed, rand);
  const build = (f: Fact, echoed: boolean): RecallFact => ({
    token: f.token,
    kind: f.kind,
    tool: f.tool,
    category: toolCategory(f.tool),
    bucket: ageBucket(f.resultIndex, messages.length),
    tool_use_id: f.tool_use_id,
    resultIndex: f.resultIndex,
    age: messages.length - 1 - f.resultIndex,
    echoed,
    item: items.get(f)!,
  });
  return [...ne.map((f) => build(f, false)), ...ec.map((f) => build(f, true))];
}

const HEADER_TEXT =
  'Without using any tools, answer from this conversation only. For each numbered item give just the missing value on its own line as `N: value`, or `N: unknown` if you cannot recall it exactly. Do not guess.';

/**
 * Splits the facts into question batches of at most `batch`, never-echoed and echoed facts
 * mixed (seeded) so a batch's position affects both alike. Items are numbered globally.
 */
export function recallSets(facts: readonly RecallFact[], batch: number, seed = 0): RecallSet[] {
  const order = shuffle(facts, prng(seed + 7));
  const all = order.map((f) => f.token);
  const sets: RecallSet[] = [];
  for (let i = 0; i < order.length; i += batch) {
    const chunk = order.slice(i, i + batch);
    const lines = chunk.map((f, j) => `${i + j + 1}. ${maskAll(f.item, all.filter((t) => t !== f.token))}`);
    sets.push({
      name: `recall-${sets.length + 1}`,
      question: `${HEADER_TEXT}\n${lines.join('\n')}`,
      expected: chunk.map((f) => f.token),
      facts: chunk,
    });
  }
  // Guard the invariant the scoring rests on: no question carries any expected token.
  const text = sets.map((s) => s.question).join('\n');
  const leaked = all.filter((t) => text.includes(t));
  if (leaked.length > 0) throw new Error(`recall questions leak ${leaked.length} expected token(s)`);
  return sets;
}
