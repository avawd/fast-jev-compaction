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

/**
 * The part of the next segment that a verbatim compaction carried over: its
 * prefix of rows that also exist in the previous segment (same tool ids, or
 * same role and text). It stops at the first new row (the `/compact` command
 * row, a recall question...), which could re-introduce a token.
 */
export function carriedPrefix(prev: readonly EvalMessage[], next: readonly EvalMessage[]): EvalMessage[] {
  const ids = new Set<string>();
  const texts = new Set<string>();
  for (const m of prev) {
    for (const u of m.toolUses) ids.add(u.tool_use_id);
    for (const r of m.toolResults ?? []) ids.add(r.tool_use_id);
    texts.add(`${m.role}\u0000${m.text}`);
  }
  const out: EvalMessage[] = [];
  for (const m of next) {
    const tools = [...m.toolUses.map((u) => u.tool_use_id), ...(m.toolResults ?? []).map((r) => r.tool_use_id)];
    const carried = tools.length > 0 ? tools.every((id) => ids.has(id)) : texts.has(`${m.role}\u0000${m.text}`);
    if (!carried) break;
    out.push(m);
  }
  return out;
}
