import { sliceWhole, sliceWholeEnd } from './text.js';

/**
 * Salient lines. A truncation keeps a result's head (and a tail for log-like
 * output); a value further in is lost, and no later quote pins it when the work
 * never repeated it. The recall eval measured this as the rules' main loss: a
 * stale file read cut to its head dropped the ticket keys, shas and numbers
 * past it. Keeping the few lines that carry such a value, each capped, keeps
 * them for a small share of what the cut saves.
 */

/** Most characters kept of one salient line. */
export const SALIENT_LINE_CHARS = 120;
/** Most characters all of a result's salient lines may keep together. */
export const SALIENT_MAX_CHARS = 400;

const VALUE = [
  /https?:\/\/[^\s"'<>)\]}\\`]+/,
  /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/,
  /#\d{2,}\b/,
  /\b[A-Z][A-Z0-9]+-\d+\b/,
  /\$\d/,
];
/** Not global: a shared /g regex carries `lastIndex` from one call into the next. */
const NUMBER = /(?<![\w.])\d{4,}(?!\w)/g;
const YEAR = /^(?:19|20)\d{2}$/;

/** Whether `line` carries a sha, #PR, ticket key, URL, dollar amount or a 4+ digit number (not a year). */
export function isSalient(line: string): boolean {
  if (VALUE.some((re) => re.test(line))) return true;
  for (const m of line.matchAll(new RegExp(NUMBER.source, 'g'))) if (!YEAR.test(m[0])) return true;
  return false;
}

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * `[start, end)` windows over the salient lines strictly between the kept head and tail (a gap
 * of at least one character on each side), in
 * order, for `renderTruncation`: each line from its start, at most `lineChars` of it (never
 * ending inside a surrogate pair), and at most `maxChars` in all. A line is taken only when its
 * kept part itself carries the value.
 */
export function salientWindows(
  text: string,
  head: number,
  tail: number,
  limits: { lineChars?: number; maxChars?: number } = {},
): Array<[number, number]> {
  const lineChars = limits.lineChars ?? SALIENT_LINE_CHARS;
  const maxChars = limits.maxChars ?? SALIENT_MAX_CHARS;
  const headEnd = sliceWhole(text, head).length;
  const tailStart = Math.max(headEnd, text.length - sliceWholeEnd(text, tail).length);
  const out: Array<[number, number]> = [];
  let used = 0;
  let start = text.lastIndexOf('\n', headEnd - 1) + 1;
  while (start < tailStart) {
    const nl = text.indexOf('\n', start);
    const lineEnd = nl < 0 ? text.length : nl;
    // A window needs a real gap on both sides: a gap marker of 0 chars is no excerpt.
    if (start > headEnd) {
      let end = Math.min(lineEnd, start + lineChars);
      if (end < text.length && isHigh(text.charCodeAt(end - 1))) end -= 1;
      if (end >= tailStart) break;
      if (end > start && isSalient(text.slice(start, end))) {
        if (used + (end - start) > maxChars) break;
        out.push([start, end]);
        used += end - start;
      }
    }
    if (nl < 0) break;
    start = nl + 1;
  }
  return out;
}
