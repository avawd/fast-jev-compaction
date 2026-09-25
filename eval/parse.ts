/**
 * Claude Code session JSONL -> the plugin's Message[] shape, split into
 * segments at `compact_boundary` rows. Each segment approximates the
 * `event.messages` one `session.compact` dispatch over that stretch would see.
 *
 * Row model, calibrated against 2.1.281 (see eval/README.md, "Parser fidelity"):
 * the engine hands a hook ONE SessionMessage PER TRANSCRIPT ROW. Claude Code
 * writes an assistant turn as one row per content block (thinking, text,
 * tool_use), all sharing `message.id`, and one user row per tool_result; the
 * engine does not merge them. A thinking-only row is a message with text ''.
 * `isMeta` rows, sidechain rows and `attachment` rows are not messages.
 * Measured: a fork whose pre-compact segment has 419 user/assistant rows, 2 of
 * them isMeta, was handed to the hook as 417 messages ("kept 259/417").
 *
 * No import from the plugin: the output is structurally its `Message`, so the
 * same parse feeds any branch's src/.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface EvalToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

export interface EvalToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

export interface EvalMessage {
  role: 'user' | 'assistant';
  text: string;
  toolUses: EvalToolUse[];
  toolResults?: EvalToolResult[];
}

export interface Boundary {
  trigger?: string;
  preTokens?: number;
  postTokens?: number;
  [key: string]: unknown;
}

export interface Segment {
  file: string;
  index: number;
  messages: EvalMessage[];
  /** The compact_boundary that ENDED this segment; absent for the last one. */
  boundary?: Boundary;
  /**
   * `cwd` of the segment's last main-thread user/assistant row: what `$.session.cwd()` would have
   * returned when this stretch was compacted. Absent when no row records one.
   */
  cwd?: string;
  /** Whether message 0 is the built-in compaction summary (`isCompactSummary`). */
  startsWithSummary: boolean;
  thinkingRows: number;
  metaRowsSkipped: number;
  skippedLines: number;
}

type Block = { type?: string; [key: string]: unknown };

/**
 * Tool result content as text. A string is used as is; an array of blocks has
 * its text blocks joined with '\n' and an image counted as '[image]'. The join
 * separator for multi-block results is NOT calibrated (every calibrated result
 * was a string); see README.
 */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: Block) => (b?.type === 'text' ? String(b['text'] ?? '') : b?.type === 'image' ? '[image]' : ''))
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (content == null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(blocks: Block[]): string {
  return blocks
    .filter((b) => b.type === 'text')
    .map((b) => String(b['text'] ?? ''))
    .join('\n');
}

function newSegment(file: string, index: number): Segment {
  return { file, index, messages: [], startsWithSummary: false, thinkingRows: 0, metaRowsSkipped: 0, skippedLines: 0 };
}

export async function loadSegments(file: string): Promise<Segment[]> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const segments: Segment[] = [];
  let seg = newSegment(file, 0);
  // tool_use_id -> the ToolUse object, so its outcome can be attached when the result row arrives.
  let pendingUses = new Map<string, EvalToolUse>();

  const flush = (boundary?: Boundary): void => {
    if (seg.messages.length > 0 || boundary) {
      if (boundary) seg.boundary = boundary;
      segments.push(seg);
    }
    seg = newSegment(file, segments.length);
    pendingUses = new Map();
  };

  for await (const line of rl) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      seg.skippedLines += 1;
      continue;
    }
    if (row['type'] === 'system' && row['subtype'] === 'compact_boundary') {
      flush((row['compactMetadata'] ?? row['compact_metadata'] ?? {}) as Boundary);
      continue;
    }
    if (row['type'] !== 'user' && row['type'] !== 'assistant') continue;
    if (row['isSidechain'] === true) continue;
    if (typeof row['cwd'] === 'string' && row['cwd'].length > 0) seg.cwd = row['cwd'];
    if (row['isMeta'] === true) {
      seg.metaRowsSkipped += 1;
      continue;
    }
    const msg = row['message'] as { content?: unknown } | undefined;
    if (!msg) continue;
    const blocks = blocksOf(msg.content);

    if (row['type'] === 'assistant') {
      const message: EvalMessage = { role: 'assistant', text: textOf(blocks), toolUses: [] };
      for (const b of blocks) {
        if (b.type === 'thinking' || b.type === 'redacted_thinking') seg.thinkingRows += 1;
        if (b.type !== 'tool_use') continue;
        const use: EvalToolUse = {
          tool_use_id: String(b['id']),
          tool: String(b['name']),
          input: (b['input'] as Record<string, unknown>) ?? {},
        };
        message.toolUses.push(use);
        pendingUses.set(use.tool_use_id, use);
      }
      seg.messages.push(message);
      continue;
    }

    const message: EvalMessage = { role: 'user', text: textOf(blocks), toolUses: [] };
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (results.length > 0) {
      message.toolResults = results.map((b) => {
        const result: EvalToolResult = { tool_use_id: String(b['tool_use_id']), text: resultText(b['content']) };
        if (b['is_error'] === true) result.isError = true;
        const use = pendingUses.get(result.tool_use_id);
        if (use) {
          use.text = result.text;
          if (result.isError) use.isError = true;
        }
        return result;
      });
    }
    if (seg.messages.length === 0 && row['isCompactSummary'] === true) seg.startsWithSummary = true;
    seg.messages.push(message);
  }
  flush(undefined);
  return segments;
}

/** A row's identity for matching across segments: its tool ids, or its role and text when it has none. */
function rowKey(m: EvalMessage): string {
  const tools = [...m.toolUses.map((u) => `u:${u.tool_use_id}`), ...(m.toolResults ?? []).map((r) => `r:${r.tool_use_id}`)];
  return tools.length > 0 ? `tools\u0000${tools.join(',')}` : `${m.role}\u0000${m.text}`;
}

/**
 * The part of the next segment that a verbatim compaction carried over: its
 * prefix of rows that match the previous segment's rows IN ORDER (same tool
 * ids, or same role and text). Compaction keeps order and never re-adds a row,
 * so matching is a forward walk; a row that matches nothing at or after the
 * walk's position (the `/compact` command row, a recall question, an empty
 * thinking row after the carried ones) ends the prefix. A rebuilt row keeps
 * its tool ids, so a truncated result still matches.
 */
export function carriedPrefix(prev: readonly EvalMessage[], next: readonly EvalMessage[]): EvalMessage[] {
  const prevKeys = prev.map(rowKey);
  const out: EvalMessage[] = [];
  let j = 0;
  for (const m of next) {
    const key = rowKey(m);
    const tools = [...m.toolUses.map((u) => u.tool_use_id), ...(m.toolResults ?? []).map((r) => r.tool_use_id)];
    let found = -1;
    for (let k = j; k < prevKeys.length; k += 1) {
      // A rebuilt row may have lost a dropped sibling's id; any shared id places it.
      const hit = tools.length > 0 ? tools.some((id) => prevKeys[k]!.includes(id)) : prevKeys[k] === key;
      if (hit) {
        found = k;
        break;
      }
    }
    if (found < 0) break;
    out.push(m);
    j = found + 1;
  }
  return out;
}

/**
 * What the model sees after the compaction that ended `prev`: the carried rows of a verbatim
 * compaction, or the summary message of a summary one. `nextStartsWithSummary` alone cannot tell
 * them apart: a verbatim compaction of a segment that itself began with an older summary carries
 * that summary row first. A summary compaction's first row is new, so it carries nothing.
 */
export function compactedContext(
  prev: readonly EvalMessage[],
  next: readonly EvalMessage[],
  nextStartsWithSummary: boolean,
): { summary: boolean; context: EvalMessage[] } {
  const carried = carriedPrefix(prev, next);
  if (nextStartsWithSummary && carried.length === 0) return { summary: true, context: next.slice(0, 1) };
  return { summary: false, context: carried };
}
