import type { Message, ToolCall } from './types.js';

/**
 * Referenced-later pins. A result that carries a distinctive token (a sha, a
 * ticket, a path, an identifier...) which the conversation had not seen
 * before, and which later assistant text or a later tool input quotes, holds
 * something the work went on to use. Such a result is never dropped, and is
 * truncated only to a window that still contains every such token.
 */

/** Truncation leaves text this close to head + tail alone; mirrors compact.ts. */
const TRUNCATION_SLACK = 120;

const TOKEN_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s"'<>)\]}\\]+/g,
  // The lookbehind starts a match only at a run's first character; without it a long
  // slash-free run is rescanned from every position (quadratic).
  /(?<![\w.@/-])(?:\.{0,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+/g,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g,
  /#\d{2,}\b/g,
  /\b[A-Z][A-Z0-9]+-\d+\b/g,
  /(?<![\w.])\d{4,}(?![\w])/g,
  /\b(?=[A-Za-z0-9_]*(?:[a-z][A-Z]|_[A-Za-z0-9]|[A-Za-z]\d))[A-Za-z_][A-Za-z0-9_]{11,}\b/g,
];

const YEAR = /^(?:19|20)\d{2}$/;
const MIN_TOKEN = 4;
/** Paths shorter than this are too generic to pin on (`a/b`, `./x`). */
const MIN_PATH = 6;
/** Bounds work on pathological text; far more than any real result needs. */
const MAX_MATCHES_PER_PATTERN = 5000;

/** Tools whose input authors content rather than quoting it back. */
const AUTHORING_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** Distinct distinctive tokens of `text`, in first-seen order. */
export function distinctiveTokens(text: string): string[] {
  const out = new Set<string>();
  for (const pattern of TOKEN_PATTERNS) {
    pattern.lastIndex = 0;
    let count = 0;
    for (const match of text.matchAll(pattern)) {
      count += 1;
      if (count > MAX_MATCHES_PER_PATTERN) break;
      const token = match[0].replace(/[.,:;]+$/, '');
      if (token.length < MIN_TOKEN || YEAR.test(token)) continue;
      if (token.includes('/') && !token.includes('://') && token.length < MIN_PATH) continue;
      out.add(token);
    }
  }
  return [...out];
}

function inputText(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}

/**
 * For each unpinned call, the tokens its result carried that are quoted later
 * and not available from anything the conversation keeps regardless (user or
 * assistant text, tool inputs, pinned results). A token carried by several
 * results is credited to the newest one before the quote, so older copies
 * stay droppable. Calls with no such token are absent from the map.
 */
export function analyzeReferences(calls: readonly ToolCall[], messages: readonly Message[]): Map<string, string[]> {
  const byUse = new Map(calls.map((c) => [c.tool_use_id, c]));
  const known = new Set<string>();
  const carrier = new Map<string, string>();
  const refs = new Map<string, Set<string>>();
  const learn = (tokens: string[]) => {
    for (const t of tokens) known.add(t);
  };
  const quote = (tokens: string[]) => {
    for (const t of tokens) {
      const id = known.has(t) ? undefined : carrier.get(t);
      if (id) (refs.get(id) ?? refs.set(id, new Set()).get(id)!).add(t);
    }
    learn(tokens);
  };
  for (const message of messages) {
    const textTokens = distinctiveTokens(message.text);
    if (message.role === 'assistant') quote(textTokens);
    else learn(textTokens);
    for (const tool of message.toolUses) {
      const tokens = distinctiveTokens(inputText(tool.input));
      if (AUTHORING_TOOLS.has(tool.tool)) learn(tokens);
      else quote(tokens);
    }
    for (const result of message.toolResults ?? []) {
      const call = byUse.get(result.tool_use_id);
      const tokens = distinctiveTokens(result.text);
      if (!call || call.pinned) {
        learn(tokens);
        continue;
      }
      for (const t of tokens) if (!known.has(t)) carrier.set(t, call.id);
    }
  }
  return new Map([...refs].map(([id, tokens]) => [id, [...tokens]]));
}

/** How many later-quoted tokens each call's result carries (calls with none are absent). */
export function refLaterCounts(calls: readonly ToolCall[], messages: readonly Message[]): Map<string, number> {
  return new Map([...analyzeReferences(calls, messages)].map(([id, tokens]) => [id, tokens.length]));
}

function covers(text: string, tokens: readonly string[], head: number, tail: number): boolean {
  if (text.length <= head + tail + TRUNCATION_SLACK) return true;
  return tokens.every((token) => {
    const at = text.indexOf(token);
    return at < 0 || at + token.length <= head || at >= text.length - tail;
  });
}

/**
 * The tail to truncate `text` with so that the first occurrence of every
 * pinned token survives: `preferredTail` if that window already covers them,
 * else `maxTail`, else undefined (the result must be kept verbatim).
 */
export function pinnedTail(
  text: string,
  tokens: readonly string[],
  head: number,
  preferredTail: number,
  maxTail: number,
): number | undefined {
  if (covers(text, tokens, head, preferredTail)) return preferredTail;
  if (maxTail > preferredTail && covers(text, tokens, head, maxTail)) return maxTail;
  return undefined;
}
