/**
 * Where a transcript's hook-visible characters are: tool results, tool_use inputs by tool, the
 * kinds of user-row text (typed prompts, teammate messages, idle notifications, injected reminders,
 * task notifications, command rows, the built-in summary) and assistant text.
 *
 * `categorize` counts the same characters the plugin's `messageChars` does (text, JSON of each
 * tool input, each result's text), so the categories of a segment sum to its `charsBefore`.
 * Thinking is not here: the hook never sees it (`Segment.hiddenChars` holds it).
 */
import type { EvalMessage } from './parse.ts';

export type Categories = Record<string, number>;

/** Tools whose inputs get their own category; everything else is `input:other`. */
const NAMED_INPUT_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'SendMessage', 'Agent']);
const TOOL_ALIASES: Record<string, string> = { Task: 'Agent' };

const TAGGED_BLOCK =
  /<(teammate-message|agent-message|task-notification|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)\b[^>]*>[\s\S]*?<\/\1>/g;

const SUMMARY_PREFIX = 'This session is being continued from a previous conversation';
/** Lines shorter than this are too generic to call a repeat. */
const DUP_MIN_LINE = 40;

function add(into: Categories, key: string, n: number): void {
  if (n > 0) into[key] = (into[key] ?? 0) + n;
}

function tagCategory(tag: string, block: string): string {
  switch (tag) {
    case 'teammate-message':
    case 'agent-message': {
      const body = block.slice(block.indexOf('>') + 1).trimStart();
      return body.startsWith('{"type":') ? 'user:idle' : 'user:teammate';
    }
    case 'task-notification':
      return 'user:task';
    case 'system-reminder':
      return 'user:reminder';
    default:
      return 'user:command';
  }
}

/** One user row's text, split by kind. The values sum to `text.length`. */
export function classifyUserText(text: string): Categories {
  const out: Categories = {};
  for (const piece of userPieces(text)) add(out, piece.category, piece.text.length);
  return out;
}

function inputChars(input: unknown): number {
  try {
    return JSON.stringify(input).length;
  } catch {
    return 20;
  }
}

function inputKey(tool: string): string {
  const name = TOOL_ALIASES[tool] ?? tool;
  return `input:${NAMED_INPUT_TOOLS.has(name) ? name : 'other'}`;
}

/** Hook-visible chars per category over `messages`. */
export function categorize(messages: readonly EvalMessage[]): Categories {
  const out: Categories = {};
  for (const m of messages) {
    if (m.role === 'assistant') add(out, 'assistant_text', m.text.length);
    else for (const [k, v] of Object.entries(classifyUserText(m.text))) add(out, k, v);
    for (const u of m.toolUses) add(out, inputKey(u.tool), inputChars(u.input));
    for (const r of m.toolResults ?? []) add(out, 'tool_result', r.text.length);
  }
  return out;
}

/** Chars removed per category going from `before` to `after` (every key of `before`). */
export function categoryDelta(before: Categories, after: Categories): Categories {
  const out: Categories = {};
  for (const [k, v] of Object.entries(before)) out[k] = v - (after[k] ?? 0);
  return out;
}

function stringsOf(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, into);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) stringsOf(v, into);
}

/** An idle notification's JSON, unescaped: its `result` holds the agent's report as plain text. */
function readableText(piece: { category: string; text: string }): string {
  if (piece.category !== 'user:idle') return piece.text;
  const start = piece.text.indexOf('{');
  const end = piece.text.lastIndexOf('}');
  try {
    const parsed = JSON.parse(piece.text.slice(start, end + 1)) as Record<string, unknown>;
    const strings: string[] = [];
    stringsOf(parsed, strings);
    return strings.join('\n');
  } catch {
    return piece.text;
  }
}

function longLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= DUP_MIN_LINE);
}

/**
 * Chars of user-row text lines (≥ 40 chars, trimmed) that repeat a line already in the context:
 * an earlier user row, assistant text, tool input or tool result. By the user category of the
 * block the repeat sits in. This is the most a line-level dedupe of user rows could remove.
 */
export function duplicateUserCharsByCategory(messages: readonly EvalMessage[]): Categories {
  const seen = new Set<string>();
  const out: Categories = {};
  const remember = (text: string) => {
    for (const l of longLines(text)) seen.add(l);
  };
  for (const m of messages) {
    if (m.role === 'user' && m.text) {
      for (const piece of userPieces(m.text)) {
        for (const l of longLines(readableText(piece))) {
          if (seen.has(l)) add(out, piece.category, l.length);
          else seen.add(l);
        }
      }
    } else remember(m.text);
    for (const u of m.toolUses) {
      const strings: string[] = [];
      stringsOf(u.input, strings);
      strings.forEach(remember);
    }
    for (const r of m.toolResults ?? []) remember(r.text);
  }
  return out;
}

export function duplicateUserChars(messages: readonly EvalMessage[]): number {
  return Object.values(duplicateUserCharsByCategory(messages)).reduce((a, b) => a + b, 0);
}

/**
 * A user row's text cut into its tagged blocks and the text between them, each with its category.
 * Text between blocks is boilerplate in a row that carries a teammate message, part of the command
 * in a row of command blocks only, and typed otherwise.
 */
function userPieces(text: string): Array<{ category: string; text: string }> {
  if (text.startsWith(SUMMARY_PREFIX)) return [{ category: 'user:summary', text }];
  const blocks: Array<{ category: string; text: string }> = [];
  const gaps: string[] = [];
  let last = 0;
  for (const m of text.matchAll(TAGGED_BLOCK)) {
    gaps.push(text.slice(last, m.index));
    blocks.push({ category: tagCategory(m[1]!, m[0]), text: m[0] });
    last = m.index + m[0].length;
  }
  gaps.push(text.slice(last));
  const cats = new Set(blocks.map((b) => b.category));
  const gapCategory =
    cats.has('user:teammate') || cats.has('user:idle')
      ? 'user:boilerplate'
      : cats.size === 1 && cats.has('user:command')
        ? 'user:command'
        : 'user:typed';
  const pieces: Array<{ category: string; text: string }> = [];
  gaps.forEach((gap, i) => {
    if (gap) pieces.push({ category: gapCategory, text: gap });
    if (blocks[i]) pieces.push(blocks[i]!);
  });
  return pieces;
}

/**
 * Real tokens per hook-visible char, by category: least squares of the change in API usage
 * (input + cache read + cache creation) between consecutive requests on the chars each category
 * added, 6,978 requests over ten local sessions (2026-09-24). Categories not listed use `default`.
 * Thinking (not a hook category) measured 0.28, and the engine carries it whatever rows the hook
 * returns.
 */
export const TOKENS_PER_CHAR: Readonly<Record<string, number>> = {
  tool_result: 0.44,
  'input:Bash': 0.42,
  'input:Write': 0.41,
  'input:Edit': 0.43,
  'input:MultiEdit': 0.43,
  'input:SendMessage': 0.34,
  'input:Agent': 0.4,
  'input:other': 0.43,
  'user:teammate': 0.39,
  'user:idle': 0.39,
  'user:boilerplate': 0.39,
  'user:task': 0.42,
  assistant_text: 0.35,
  default: 0.4,
};

export interface CategoryRow {
  category: string;
  chars: number;
  sharePct: number;
  estTokens: number;
  removed: Record<string, number>;
  removedPct: Record<string, number>;
}

const pct1 = (a: number, b: number) => (b === 0 ? 0 : Math.round((1000 * a) / b) / 10);

/** One row per non-empty category of `before`, largest first, then a `total` row. */
export function categoryRows(before: Categories, removedByArm: Record<string, Categories>): CategoryRow[] {
  const arms = Object.keys(removedByArm);
  const total = Object.values(before).reduce((a, b) => a + b, 0);
  const row = (category: string, chars: number, removed: Record<string, number>, estTokens: number): CategoryRow => ({
    category,
    chars,
    sharePct: pct1(chars, total),
    estTokens,
    removed,
    removedPct: Object.fromEntries(arms.map((a) => [a, pct1(removed[a] ?? 0, chars)])),
  });
  const rows = Object.entries(before)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) =>
      row(k, v, Object.fromEntries(arms.map((a) => [a, removedByArm[a]![k] ?? 0])), Math.round(v * (TOKENS_PER_CHAR[k] ?? TOKENS_PER_CHAR['default']!))),
    );
  const sum = (f: (r: CategoryRow) => number) => rows.reduce((s, r) => s + f(r), 0);
  rows.push(row('total', total, Object.fromEntries(arms.map((a) => [a, sum((r) => r.removed[a] ?? 0)])), sum((r) => r.estTokens)));
  return rows;
}
