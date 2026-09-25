import { sliceWhole, sliceWholeEnd } from './text.js';

/**
 * Excerpt windows. When a result's later-quoted tokens sit beyond any head a
 * truncation may stretch to, the result need not be kept whole: keeping the
 * head, a short window of lines around each such token and the tail, with the
 * gaps between them marked, holds everything the work went on to use.
 */

export const TRUNCATION_NOTE_PREFIX = '[verbatim-compaction truncated';

/** Characters kept either side of a token, snapped inward to whole lines when they fit. */
export const EXCERPT_RADIUS = 200;
/** Most characters an excerpted result may keep (head, windows and tail); past it the result is kept whole. */
export const MAX_EXCERPT_KEPT = 4000;
/** Pieces this close are joined: a gap marker would cost about as much as the gap. */
const MERGE_GAP = 64;
/** A truncation must save at least this much over the text; mirrors compact.ts. */
const TRUNCATION_SLACK = 120;

/** How a result is cut: a head, a tail, and `[start, end)` windows strictly between them. */
export interface ExcerptPlan {
  head: number;
  tail: number;
  windows: Array<[number, number]>;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The window around `text[at, end)`: whole lines within `radius` of it, or,
 * where the token's own line runs past the radius, the radius itself. Never
 * starts or ends between the halves of a surrogate pair.
 */
function windowAround(text: string, at: number, end: number, radius: number): [number, number] {
  const lo = Math.max(0, at - radius);
  const hi = Math.min(text.length, end + radius);
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  let start = lo;
  if (lineStart >= lo && lo > 0 && text[lo - 1] !== '\n') start = text.indexOf('\n', lo) + 1;
  else if (lineStart < lo && isLow(text.charCodeAt(lo)) && isHigh(text.charCodeAt(lo - 1))) start = lo + 1;
  const lineEnd = text.indexOf('\n', end);
  let stop = hi;
  if (hi < text.length && lineEnd >= 0 && lineEnd <= hi) stop = text.lastIndexOf('\n', hi);
  else if (stop < text.length && isHigh(text.charCodeAt(stop - 1)) && isLow(text.charCodeAt(stop))) stop -= 1;
  return [start, stop];
}

/**
 * The cut that keeps the asked-for head and tail plus a window around the first
 * occurrence of every token they miss. Windows that overlap or nearly touch are
 * joined, and a window reaching the head or tail lengthens it. Undefined when
 * the pieces would keep more than `maxKept` (or than the head and tail alone,
 * if that is larger), or when the rendered result would not be smaller.
 */
export function excerptPlan(
  text: string,
  tokens: readonly string[],
  head: number,
  tail: number,
  limits: { radius?: number; maxKept?: number } = {},
): ExcerptPlan | undefined {
  const radius = limits.radius ?? EXCERPT_RADIUS;
  const headEnd = sliceWhole(text, head).length;
  const tailStart = Math.max(headEnd, text.length - sliceWholeEnd(text, tail).length);
  const spans: Array<[number, number]> = [[0, headEnd], [tailStart, text.length]];
  const covered = (at: number, end: number) => spans.some(([s, e]) => at >= s && end <= e);
  for (const token of tokens) {
    const at = token.length > 0 ? text.indexOf(token) : -1;
    if (at < 0 || covered(at, at + token.length)) continue;
    spans.push(windowAround(text, at, at + token.length, radius));
  }
  spans.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [];
  for (const [s, e] of spans) {
    const last = merged[merged.length - 1];
    if (last && s - last[1] <= MERGE_GAP) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  if (merged.length < 2) return undefined;
  const first = merged[0]!;
  const last = merged[merged.length - 1]!;
  const plan: ExcerptPlan = { head: first[1], tail: text.length - last[0], windows: merged.slice(1, -1) };
  const kept = merged.reduce((sum, [s, e]) => sum + e - s, 0);
  if (kept > Math.max(limits.maxKept ?? MAX_EXCERPT_KEPT, headEnd + text.length - tailStart)) return undefined;
  if (renderTruncation(text, false, plan).length > text.length - TRUNCATION_SLACK) return undefined;
  return plan;
}

const omitted = (chars: number) => `[… ${chars} chars omitted …]`;

/**
 * The truncated form of `text`: the head, the note, then (when there are
 * windows) each window after a marker naming the characters skipped to reach
 * it, and the tail, or a last marker when no tail is kept. `plan` must come
 * from `excerptPlan` or have no windows; head and tail are cut surrogate-safe.
 */
export function renderTruncation(text: string, isError: boolean, plan: ExcerptPlan): string {
  const kept = sliceWhole(text, plan.head);
  const end = sliceWholeEnd(text, plan.tail);
  const inner = plan.windows.reduce((sum, [s, e]) => sum + e - s, 0);
  const head = kept.length > 0 ? `${kept}\n` : '';
  const note = `${TRUNCATION_NOTE_PREFIX} ${text.length - kept.length - end.length - inner} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
  if (plan.windows.length === 0) return `${head}${note}${end.length > 0 ? `\n${end}` : ''}`;
  const parts = [`${head}${note}`];
  let at = kept.length;
  for (const [s, e] of plan.windows) {
    parts.push(omitted(s - at), text.slice(s, e));
    at = e;
  }
  const tailStart = text.length - end.length;
  parts.push(omitted(tailStart - at));
  if (end.length > 0) parts.push(end);
  return parts.join('\n');
}
