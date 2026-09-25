import { sliceWhole, sliceWholeEnd } from './text.js';

export const TRUNCATION_NOTE_PREFIX = '[verbatim-compaction truncated';

/** Not global: a shared /g regex carries `lastIndex` from one call into the next (`matchAll` copies it). */
const NOTE_RE = /\[verbatim-compaction truncated (\d+) chars of this tool result( \(error\))?; re-run the tool if needed\]/;

function note(removed: number, isError: boolean): string {
  return `${TRUNCATION_NOTE_PREFIX} ${removed} chars of this tool result${isError ? ' (error)' : ''}; re-run the tool if needed]`;
}

function join(head: string, removed: number, isError: boolean, tail: string): string {
  return `${head.length > 0 ? `${head}\n` : ''}${note(removed, isError)}${tail.length > 0 ? `\n${tail}` : ''}`;
}

/** A result this short is left whole: the note would cost about as much as it saves. */
export function shrinks(resultChars: number, headChars: number, tailChars = 0): boolean {
  return resultChars > headChars + tailChars + 120;
}

/** An earlier pass's truncation: the kept head and tail around its one note, and its count. */
export interface Truncated {
  head: string;
  tail: string;
  removed: number;
  /** Where the note (with the newlines joining it) starts and ends in the text. */
  start: number;
  end: number;
}

/** Whether an earlier compaction already truncated this result (it carries at least one note). */
export function isTruncated(text: string): boolean {
  return NOTE_RE.test(text);
}

/** The earlier truncation this result carries, if it carries exactly one note. */
export function priorTruncation(text: string): Truncated | undefined {
  const found = earlierTruncation(text);
  return found === 'nested' ? undefined : found;
}

function earlierTruncation(text: string): Truncated | 'nested' | undefined {
  const found = [...text.matchAll(new RegExp(NOTE_RE.source, 'g'))];
  if (found.length === 0) return undefined;
  if (found.length > 1) return 'nested';
  const m = found[0]!;
  const at = m.index;
  const close = at + m[0].length;
  // join() puts one newline between a non-empty head/tail and the note.
  const head = at > 0 && text[at - 1] === '\n' ? text.slice(0, at - 1) : text.slice(0, at);
  const tail = close < text.length && text[close] === '\n' ? text.slice(close + 1) : text.slice(close);
  if ((at > 0 && head.length === at) || (close < text.length && tail.length === text.length - close)) return undefined;
  return { head, tail, removed: Number(m[1]), start: head.length, end: text.length - tail.length };
}

/**
 * A result truncated by an earlier compaction (a long session compacts many times) is cut again
 * within its own head and tail: one note, whose count adds what this pass removes to what the
 * earlier one did. A window that reaches across the old note (a pin stretched past it) leaves the
 * result as it is, since cutting either side could lose what the window holds; so does a result
 * already carrying more than one note.
 */
function retruncated(text: string, earlier: Truncated, isError: boolean, headChars: number, tailChars: number): string {
  const headEnd = Math.min(headChars, text.length);
  const tailStart = text.length - Math.min(tailChars, text.length);
  if (headEnd > earlier.end || tailStart < earlier.start) return text;
  const head = headEnd >= earlier.head.length ? earlier.head : sliceWhole(earlier.head, headEnd);
  const tail = tailStart <= earlier.end ? earlier.tail : sliceWholeEnd(earlier.tail, text.length - tailStart);
  const removed = earlier.removed + (earlier.head.length - head.length) + (earlier.tail.length - tail.length);
  const out = join(head, removed, isError, tail);
  return out.length < text.length ? out : text;
}

/**
 * The result cut to `headChars` from its start plus `tailChars` from its end, with a note in
 * between saying how much went; `text` itself when that would not shrink it.
 */
export function truncatedResultText(text: string, isError: boolean, headChars: number, tailChars = 0): string {
  // The length test comes first for a re-cut too: the pin's window (pin.ts `covers`) counts on a
  // result this short never being cut.
  if (!shrinks(text.length, headChars, tailChars)) return text;
  const earlier = earlierTruncation(text);
  if (earlier === 'nested') return text;
  if (earlier) return retruncated(text, earlier, isError, headChars, tailChars);
  const kept = sliceWhole(text, headChars);
  const end = sliceWholeEnd(text, tailChars);
  return join(kept, text.length - kept.length - end.length, isError, end);
}
