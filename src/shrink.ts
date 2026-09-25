import { TRUNCATION_NOTE_PREFIX } from './excerpt.js';
import { distinctiveTokens } from './pin.js';
import { isSalient } from './salient.js';
import { sliceWhole } from './text.js';
import type { Message, ToolCall, ToolUse } from './types.js';

/**
 * Old call inputs, shortened. Tool output is not all a transcript holds: on real sessions the
 * inputs of old calls (Bash heredocs, Write contents, Edit strings, subagent prompts) are up to a
 * third of it, and none of it is needed whole once the call ran: the file is on disk, the command's output follows it, the agent answered.
 * Each such field keeps its start, the lines holding a token something later quotes, a few
 * salient lines (salient.ts), and a note saying what went.
 *
 * Engine facts this rests on (probed live on 2.1.282):
 *  - a row the hook rebuilds is installed as built: a tool_use keeps its id with the new input,
 *    and the API accepts it; the rebuilt row loses the engine's riders and its message id.
 *  - Claude Code checks, per API message, that the NEXT message holds the results of its
 *    tool_uses, and otherwise injects "[Tool result missing due to internal error]" and drops
 *    the real results. The rows of one reply share a message id; a rebuilt row gets a fresh one.
 *    So rebuilding one tool_use row of a parallel group split the group and lost results. The
 *    group's tool_use rows are therefore rebuilt as ONE row, and only when they end the run of
 *    assistant rows (nothing but their results follows them).
 *
 * Old replies are left alone. Rows carry no message id, so a long reply right before a call cannot
 * be told from the previous reply's turn-end text (a Stop-hook continuation writes no row between
 * them); rebuilt, that text would lose its riders, among them the stop-hook feedback quoting the
 * user's goal. Measured, folding replies freed next to nothing anyway.
 */

export const SHRINK_NOTE_PREFIX = '[verbatim-compaction shortened';
/** Input fields shorter than this are left whole. */
export const MIN_SHRINK_FIELD_CHARS = 800;
/** Most characters of one excerpted line; more only to reach a must-keep token. */
const LINE_CHARS = 160;
/** A must-keep token further into its line than this is taken as a window around it. */
const LINE_REACH = 400;
/**
 * Most characters the excerpted lines may keep together, or this share of the text when larger
 * (an orchestrator's prompt quotes many paths the work goes on to use); past it the text is kept whole.
 */
const MAX_KEPT_CHARS = 1200;
const MAX_KEPT_SHARE = 0.35;
/** Of that, most characters salient-but-unquoted lines may take. */
const SALIENT_BUDGET = 400;
/** How far past the head a line may run for the head to end on it. */
const HEAD_LINE_REACH = 120;
/** A shortening must save at least this much; the note costs about 150. */
const MIN_SAVING = 300;
/** Nested input values deeper than this are left alone. */
const MAX_DEPTH = 3;

/** Tools whose input is a decision record the model must keep reading whole. */
const EXCLUDED_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode', 'TodoWrite']);
/** Tools whose result only confirms the input landed on disk: a quoted result needs none of the input. */
const AUTHORING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export interface ShrinkSpec {
  head: number;
  /** What was shortened, for the note ("this old command"). */
  what: string;
  /** Where the whole of it lives, or why it is not needed ("it already ran"). */
  hint: string;
}

export interface ShrinkOptions {
  shrinkOldInputs: boolean;
  staleAfterMessages: number;
  preserveRecentMessages: number;
}

export interface ShrinkOutcome {
  messages: Message[];
  /** Tool inputs shortened. */
  inputs: number;
}

/** Whether an earlier compaction already shortened or truncated this text. */
export function isShrunk(text: string): boolean {
  return text.includes(SHRINK_NOTE_PREFIX) || text.includes(TRUNCATION_NOTE_PREFIX);
}

const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** The part of `line` to keep so every token in `tokens` survives; undefined when none fits. */
function clipLine(line: string, tokens: readonly string[]): string | undefined {
  if (line.length <= LINE_CHARS) return line;
  const spans = tokens.map((t) => [line.indexOf(t), line.indexOf(t) + t.length] as const);
  const end = Math.max(LINE_CHARS, ...spans.map(([, e]) => e));
  if (end <= LINE_REACH) return sliceWhole(line, end);
  let start = Math.max(0, Math.min(...spans.map(([s]) => s)) - 40);
  if (start > 0 && isLow(line.charCodeAt(start))) start += 1;
  if (end - start > LINE_REACH) return undefined;
  return `…${sliceWhole(line.slice(start), end - start)}`;
}

/**
 * `text` cut to its head (ending on a line when one ends near), a note, and the later lines that
 * hold a `mustKeep` token or a salient value, in order. The text itself when it already carries a
 * note, when the lines holding `mustKeep` would not fit, or when the cut would save too little.
 */
export function shrinkText(text: string, spec: ShrinkSpec, mustKeep: readonly string[]): string {
  if (isShrunk(text) || text.length < spec.head + MIN_SAVING) return text;
  let cut = sliceWhole(text, spec.head).length;
  // A must-keep token the cut would split is kept whole in the head: split, it is in neither part.
  for (const t of mustKeep) {
    for (let at = text.indexOf(t); at >= 0 && at < cut; at = text.indexOf(t, at + 1)) {
      if (at + t.length > cut) cut = at + t.length;
    }
  }
  const eol = text.indexOf('\n', cut);
  let head = text.slice(0, eol >= 0 && eol - cut <= HEAD_LINE_REACH ? eol : cut);
  const rest = text.slice(head.length);
  const missing = new Set(mustKeep.filter((t) => t.length > 0 && !head.includes(t) && rest.includes(t)));
  const kept: string[] = [];
  let used = 0;
  let salient = 0;
  for (const line of rest.split('\n')) {
    const tokens = [...missing].filter((t) => line.includes(t));
    let piece: string | undefined;
    if (tokens.length > 0) {
      piece = clipLine(line, tokens);
      if (piece === undefined || !tokens.every((t) => piece!.includes(t))) return text;
      for (const t of tokens) missing.delete(t);
    } else if (salient < SALIENT_BUDGET && line.trim().length > 0) {
      const clipped = sliceWhole(line, LINE_CHARS);
      if (isSalient(clipped) && salient + clipped.length <= SALIENT_BUDGET) {
        piece = clipped;
        salient += clipped.length;
      }
    }
    if (piece === undefined) continue;
    kept.push(piece);
    used += piece.length;
    if (used > Math.max(MAX_KEPT_CHARS, text.length * MAX_KEPT_SHARE)) return text;
  }
  if (missing.size > 0) return text;
  const omitted = text.length - head.length - used;
  const excerpts = kept.length > 0 ? '; the lines after this note are excerpts of the rest' : '';
  const note = `${SHRINK_NOTE_PREFIX} ${spec.what}: ${omitted} of ${text.length} chars omitted${excerpts}; ${spec.hint}]`;
  const out = [head, note, ...kept].join('\n');
  return out.length <= text.length - MIN_SAVING ? out : text;
}

const ON_DISK = 'the file on disk holds the result; Read it if needed';

function specFor(tool: string): ShrinkSpec {
  switch (tool) {
    case 'Bash':
    case 'Monitor':
      return { head: 300, what: 'this old command', hint: 'it already ran; its output is in the tool result' };
    case 'Write':
      return { head: 300, what: "this old Write's content", hint: ON_DISK };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { head: 200, what: 'this old edit text', hint: ON_DISK };
    case 'Agent':
    case 'Task':
      return { head: 600, what: 'this old subagent prompt', hint: 'the agent already ran; its report is in the tool result' };
    case 'SendMessage':
      return { head: 600, what: 'this old message', hint: 'it was already sent' };
    default:
      return { head: 400, what: `this old ${tool} input`, hint: 'the call already ran' };
  }
}

/** Every string at least MIN_SHRINK_FIELD_CHARS long, shortened; the same object when none is. */
function shrinkValue(value: unknown, spec: ShrinkSpec, keep: (text: string) => string[], depth: number): unknown {
  if (typeof value === 'string') {
    return value.length >= MIN_SHRINK_FIELD_CHARS ? shrinkText(value, spec, keep(value)) : value;
  }
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const items = value.map((v) => shrinkValue(v, spec, keep, depth + 1));
    return items.every((v, i) => v === value[i]) ? value : items;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const next = shrinkValue(v, spec, keep, depth + 1);
    if (next !== v) changed = true;
    out[k] = next;
  }
  return changed ? out : value;
}

/** Every string in an input, raw: JSON escapes glue `\n` to the next word (`ls\nsrc/a.ts` → `nsrc/a.ts`). */
function stringLeaves(value: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof value === 'string') out.push(value);
  else if (value !== null && typeof value === 'object' && depth < 8) {
    for (const v of Object.values(value as Record<string, unknown>)) stringLeaves(v, out, depth + 1);
  }
  return out;
}

/** For each distinctive token, the index of the last message whose text or tool input quotes it. */
function lastQuotes(messages: readonly Message[]): Map<string, number> {
  const last = new Map<string, number>();
  messages.forEach((m, i) => {
    for (const t of distinctiveTokens(m.text)) last.set(t, i);
    for (const u of m.toolUses) for (const leaf of stringLeaves(u.input)) for (const t of distinctiveTokens(leaf)) last.set(t, i);
  });
  return last;
}

/**
 * Shortens old tool inputs in `kept` (compact()'s output over
 * `original`). Old means older than `staleAfterMessages` and outside the first row and the
 * preserved tail. A call is shortened only when unpinned; one whose result carries a token quoted
 * later keeps twice the head. Unchanged rows are returned as the objects they came in as.
 */
export function shrinkOld(
  kept: readonly Message[],
  original: readonly Message[],
  calls: readonly ToolCall[],
  options: ShrinkOptions,
): ShrinkOutcome {
  if (!options.shrinkOldInputs) return { messages: [...kept], inputs: 0 };
  const total = original.length;
  const indexOf = new Map<Message, number>();
  original.forEach((m, i) => indexOf.set(m, i));
  const oldEnough = (i: number | undefined): i is number =>
    i !== undefined && i > 0 && i < total - options.preserveRecentMessages && total - 1 - i > options.staleAfterMessages;
  const eligible = new Set(calls.filter((c) => !c.pinned && oldEnough(c.callIndex) && !EXCLUDED_TOOLS.has(c.tool)).map((c) => c.tool_use_id));
  // A result the work went on to quote is read with its call: its input keeps twice the head.
  const quotedResult = new Set(calls.filter((c) => (c.refLater ?? 0) > 0 && !AUTHORING_TOOLS.has(c.tool)).map((c) => c.tool_use_id));
  const callIndex = new Map(calls.map((c) => [c.tool_use_id, c.callIndex]));
  // A pinned call's row is never rebuilt, not even as part of a merged run: its riders (riders.ts)
  // ride on the row object, and a rebuilt row loses them.
  const pinned = new Set(calls.filter((c) => c.pinned).map((c) => c.tool_use_id));
  let quotes: Map<string, number> | undefined;
  const mustKeep = (at: number) => (text: string) => {
    quotes ??= lastQuotes(original);
    return distinctiveTokens(text).filter((t) => (quotes!.get(t) ?? -1) > at);
  };
  const rowIndex = (m: Message) => indexOf.get(m) ?? (m.toolUses.length > 0 ? callIndex.get(m.toolUses[0]!.tool_use_id) : undefined);

  const shrinkUse = (tool: ToolUse): ToolUse => {
    if (!options.shrinkOldInputs || !eligible.has(tool.tool_use_id)) return tool;
    const at = callIndex.get(tool.tool_use_id)!;
    const spec = specFor(tool.tool);
    const head = quotedResult.has(tool.tool_use_id) ? { ...spec, head: spec.head * 2 } : spec;
    const input = shrinkValue(tool.input, head, mustKeep(at), 0) as Record<string, unknown>;
    return input === tool.input ? tool : { ...tool, input };
  };
  /**
   * What rebuilding a run would give, or undefined when it may not be rebuilt. Only the tool_use
   * rows that end the run are ever rebuilt, as ONE row. The run's other rows keep their message
   * id and stay before it: they hold no call, so merged back into their reply's place they cannot
   * split a call from its result. A run with no tool_use is never rebuilt.
   */
  type Plan = { start: number; row: Message; inputs: number };
  const planRun = (run: readonly Message[]): Plan | undefined => {
    const firstTool = run.findIndex((m) => m.toolUses.length > 0);
    if (firstTool < 0) return undefined;
    const tools = run.slice(firstTool);
    // The tool rows must end the run and all be old: then only their results follow them.
    if (!tools.every((m) => m.toolUses.length > 0 && oldEnough(rowIndex(m)))) return undefined;
    if (tools.some((m) => m.toolUses.some((u) => pinned.has(u.tool_use_id)))) return undefined;
    if (tools.length > 1 && tools.some((m) => m.text.length > 0)) return undefined;
    const originals = tools.flatMap((m) => m.toolUses);
    const uses = originals.map(shrinkUse);
    const inputs = uses.filter((u, k) => u !== originals[k]).length;
    const text = tools.length === 1 ? tools[0]!.text : '';
    return { start: firstTool, row: { role: 'assistant', text, toolUses: uses }, inputs };
  };

  // Runs, and whether each holds a call right after nothing but tool results: then it may
  // continue the reply before it. Claude Code writes a streamed parallel reply as use A, result A,
  // use B, result B under one message id, and merges every row of an id into its FIRST row's
  // place (probed live: a rebuilt use A left before the reply's own use B lost both B's and C's
  // results to the pairing repair). So in such a chain a run's calls are rebuilt only if every
  // later run's calls are rebuilt too: then no call of the reply is left after a rebuilt one.
  const runs: Array<{ rows: Message[]; afterResults: boolean }> = [];
  const pieces: Array<Message | number> = [];
  let gap: Message[] = [];
  for (let i = 0; i < kept.length; ) {
    const m = kept[i]!;
    if (m.role !== 'assistant') {
      pieces.push(m);
      gap.push(m);
      i += 1;
      continue;
    }
    let j = i;
    while (j < kept.length && kept[j]!.role === 'assistant') j += 1;
    const rows = kept.slice(i, j);
    const onlyResults = gap.length > 0 && gap.every((g) => (g.toolResults ?? []).length > 0 && g.text.trim().length === 0);
    // A run holding a call after nothing but results may continue the reply, whatever it opens on
    // (measured over local transcripts, all 1,444 real continuations opened on a tool_use, but the
    // rule does not rely on it). A run without a call ends a chain: no row of it holds a call.
    runs.push({ rows, afterResults: runs.length > 0 && onlyResults && rows.some((m) => m.toolUses.length > 0) });
    pieces.push(runs.length - 1);
    gap = [];
    i = j;
  }
  const rebuilt = new Map<number, Plan>();
  for (let c = 0; c < runs.length; ) {
    let end = c + 1;
    while (end < runs.length && runs[end]!.afterResults) end += 1;
    const plans = runs.slice(c, end).map((r) => planRun(r.rows));
    // From the first changed run of the chain's rebuildable tail to the chain's end, all rebuilt.
    let tail = plans.length;
    while (tail > 0 && plans[tail - 1] !== undefined) tail -= 1;
    const first = plans.findIndex((p, k) => k >= tail && p !== undefined && p.inputs > 0);
    if (first >= 0) for (let k = first; k < plans.length; k += 1) rebuilt.set(c + k, plans[k]!);
    c = end;
  }
  let inputs = 0;
  const messages: Message[] = [];
  for (const piece of pieces) {
    if (typeof piece !== 'number') {
      messages.push(piece);
      continue;
    }
    const rows = runs[piece]!.rows;
    const plan = rebuilt.get(piece);
    if (!plan) {
      messages.push(...rows);
      continue;
    }
    inputs += plan.inputs;
    messages.push(...rows.slice(0, plan.start), plan.row);
  }
  return { messages, inputs };
}
