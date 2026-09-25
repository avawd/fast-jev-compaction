import { distinctiveTokens } from './pin.js';
import { isSalient } from './salient.js';
import { sliceWhole } from './text.js';
import type { Message, ResolvedCompactOptions } from './types.js';

/**
 * Teammate rows. In a multi-agent session the other agents' messages arrive as user rows
 * (`<teammate-message teammate_id="…">`), and on the orchestration session the review measured
 * they were 28% of what the hook sees: more than the tool output it prunes. Three repeats are cut:
 *
 * - an agent's `idle_notification` carries its closing reply as `result`, which restates the
 *   report it has just sent (same facts, reworded); the report stays, the restatement becomes a
 *   note plus the lines holding a value the report lacks;
 * - a message sent twice word for word keeps its newer copy;
 * - the peer-message notice Claude Code appends to every teammate row stays on the newest one.
 *
 * And, like a stale tool result, a teammate message older than `staleAfterMessages` keeps its
 * head, its salient lines and every line holding a token quoted later.
 *
 * Typed prompts are never touched. A changed row is rebuilt, and a rebuilt row loses what the
 * engine hangs on it unseen (attachments recorded after it). After a summary compaction Claude
 * Code re-sends the instructions (CLAUDE.md, memory) as attachments right after the first new
 * row, so the first user row after a summary is never rebuilt.
 */

/** Every note this module writes starts with it; a block holding one is never cut again. */
export const USER_ROW_NOTE = '[verbatim-compaction:';
/** The start of the notice Claude Code appends to every teammate row. */
export const PEER_NOTICE = 'This came from another Claude session — not typed by your user, but very likely working on their behalf.';
const SUMMARY_PREFIX = 'This session is being continued from a previous conversation';
const TEAMMATE_HEADER = 'Another Claude session sent a message:';
const BLOCK = /<teammate-message teammate_id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/teammate-message>/g;
/** A cut must save at least this share of a block, or the block is left whole. */
const MIN_SAVING = 0.3;
/** Past this many characters a line holding a quoted token keeps a window around the token. */
const LINE_CAP = 240;
const TOKEN_WINDOW = 60;
/**
 * Most characters of salient lines one cut block keeps. More than a tool result's 400: a report is
 * dense with shas, keys and counts, and what it says is the orchestrator's only copy.
 */
const SALIENT_BUDGET = 1000;
/** Blocks shorter than this are never cut. */
const MIN_BLOCK = 400;

export interface UserRowStats {
  /** Characters of every teammate row before the pass: beside tool output, what the plugin can shrink. */
  teammateChars: number;
  /** Rows rebuilt. */
  rows: number;
  charsSaved: number;
  restated: number;
  repeated: number;
  stale: number;
  notices: number;
}

interface Block {
  row: number;
  from: string;
  /** Offsets of the body inside the row's text. */
  start: number;
  end: number;
  body: string;
  /** The parsed idle notification, when the body is one with a string result. */
  idle?: Record<string, unknown> & { result: string };
}

type Quotes = Map<string, number[]>;

function parseIdle(body: string): Block['idle'] {
  if (!body.startsWith('{')) return undefined;
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    if (value['type'] === 'idle_notification' && typeof value['result'] === 'string') return value as Block['idle'];
  } catch {
    // Not JSON: a plain message.
  }
  return undefined;
}

function blocksOf(text: string, row: number): Block[] {
  if (!text.includes('<teammate-message')) return [];
  const out: Block[] = [];
  for (const m of text.matchAll(BLOCK)) {
    const body = m[2]!;
    const start = m.index! + m[0].indexOf('>\n') + 2;
    const block: Block = { row, from: m[1]!, start, end: start + body.length, body };
    const idle = parseIdle(body);
    if (idle) block.idle = idle;
    out.push(block);
  }
  return out;
}

/**
 * A teammate row is exactly what Claude Code writes: the header, then teammate blocks and nothing
 * else, then at most the notice paragraph. A typed prompt that pastes a block or the notice is not
 * one, and is never touched.
 */
const isTeammateRow = (m: Message) =>
  m.role === 'user' && (m.toolResults ?? []).length === 0 && m.text.startsWith(TEAMMATE_HEADER) && onlyBlocks(m.text);

function onlyBlocks(text: string): boolean {
  let rest = text.slice(TEAMMATE_HEADER.length);
  const notice = rest.indexOf(`\n\n${PEER_NOTICE}`);
  if (notice >= 0) {
    if (rest.indexOf('\n\n', notice + 2) >= 0) return false;
    rest = rest.slice(0, notice);
  }
  const stripped = rest.replace(BLOCK, '');
  return stripped.trim() === '' && rest.includes('<teammate-message');
}
const isUserText = (m: Message) => m.role === 'user' && (m.toolResults ?? []).length === 0 && m.text.trim().length > 0;

/** Where each distinctive token is quoted: assistant text and non-authoring tool inputs, by row. */
function quoteIndex(messages: readonly Message[]): Quotes {
  const quotes: Quotes = new Map();
  const add = (text: string, row: number) => {
    for (const t of distinctiveTokens(text)) {
      const rows = quotes.get(t) ?? quotes.set(t, []).get(t)!;
      if (rows[rows.length - 1] !== row) rows.push(row);
    }
  };
  messages.forEach((m, row) => {
    if (m.role === 'assistant' && m.text) add(m.text, row);
    for (const u of m.toolUses) {
      if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(u.tool)) continue;
      try {
        add(JSON.stringify(u.input) ?? '', row);
      } catch {
        // An input that cannot be serialised quotes nothing.
      }
    }
  });
  return quotes;
}

/** Whether `token` is quoted in a row after `after` and before `before`. */
function quotedBetween(quotes: Quotes, token: string, after: number, before = Infinity): boolean {
  return (quotes.get(token) ?? []).some((row) => row > after && row < before);
}

/**
 * The lines of `text` worth keeping past a cut, in text order: every line holding a `must` token,
 * then, within the salient budget, lines holding a sha, key, URL or number `known` lacks, then
 * lines holding any other distinctive token it lacks (a path, an identifier). A long line keeps a
 * window around each such token. `undefined` when the must-lines alone are too many for a cut to pay.
 */
function keptLines(text: string, must: (t: string) => boolean, known: string, skip: number): string[] | undefined {
  const picked: Array<{ index: number; piece: string; tier: number }> = [];
  let at = 0;
  text.split('\n').forEach((line, index) => {
    const lineStart = at;
    at += line.length + 1;
    if (lineStart + line.length <= skip) return;
    const tokens = distinctiveTokens(line);
    const needed = tokens.filter(must);
    const novel = needed.length > 0 ? needed : tokens.filter((t) => !known.includes(t));
    if (novel.length === 0) return;
    const tier = needed.length > 0 ? 0 : novel.some(isSalient) ? 1 : 2;
    const shown = tier === 1 ? novel.filter(isSalient) : novel;
    const piece = line.length <= LINE_CAP ? line : shown.map((t) => windowAround(line, t)).join(' … ');
    picked.push({ index, piece, tier });
  });
  const mustUsed = picked.filter((p) => p.tier === 0).reduce((sum, p) => sum + p.piece.length, 0);
  if (mustUsed > text.length * (1 - MIN_SAVING)) return undefined;
  const kept = new Set(picked.filter((p) => p.tier === 0));
  let used = 0;
  for (const tier of [1, 2]) {
    for (const p of picked.filter((x) => x.tier === tier)) {
      if (used + p.piece.length > SALIENT_BUDGET) continue;
      kept.add(p);
      used += p.piece.length;
    }
  }
  return picked.filter((p) => kept.has(p)).map((p) => p.piece);
}

function windowAround(line: string, token: string): string {
  const at = line.indexOf(token);
  const start = Math.max(0, at - TOKEN_WINDOW);
  return sliceWhole(line.slice(start), token.length + 2 * TOKEN_WINDOW);
}

function withLines(note: string, kept: readonly string[]): string {
  return kept.length === 0 ? note : `${note}\n${kept.join('\n')}`;
}

/** The body cut to its head, a note, and the kept lines; undefined when that saves too little. */
function staleBody(body: string, head: number, must: (t: string) => boolean): string | undefined {
  const headText = sliceWhole(body, head);
  const kept = keptLines(body, must, headText, headText.length);
  if (!kept) return undefined;
  const omitted = body.length - headText.length;
  const note = `${USER_ROW_NOTE} ${omitted} chars of this message omitted; the lines below hold its ids and numbers]`;
  const out = `${headText}\n${withLines(note, kept)}`;
  return out.length < body.length * (1 - MIN_SAVING) ? out : undefined;
}

function idleBody(idle: NonNullable<Block['idle']>, result: string): string {
  return JSON.stringify({ ...idle, result });
}

/** Characters of the teammate rows of `messages`. */
export function teammateChars(messages: readonly Message[]): number {
  return messages.reduce((sum, m) => sum + (isTeammateRow(m) ? m.text.length : 0), 0);
}

/** Rewrites rows by block edits (body replacements) and notice removals. */
export function compactUserRows(
  messages: readonly Message[],
  options: ResolvedCompactOptions,
): { messages: Message[]; stats: UserRowStats } {
  const stats: UserRowStats = { teammateChars: teammateChars(messages), rows: 0, charsSaved: 0, restated: 0, repeated: 0, stale: 0, notices: 0 };
  const { dedupeTeammates, trimStaleTeammates, dedupePeerNotice } = options;
  if (!dedupeTeammates && !trimStaleTeammates && !dedupePeerNotice) return { messages: [...messages], stats };
  const total = messages.length;
  const guarded = guardedRows(messages, options);
  const quotes = quoteIndex(messages);
  const blocks = messages.flatMap((m, row) => (isTeammateRow(m) ? blocksOf(m.text, row) : []));
  const edits = new Map<Block, string>();
  const editable = (b: Block) => !guarded.has(b.row) && !b.body.includes(USER_ROW_NOTE);

  if (dedupeTeammates) {
    // Linear lookups: the next identical copy of each block, and each sender's previous block.
    const nextSame = new Map<Block, Block>();
    const newest = new Map<string, Block>();
    for (const b of [...blocks].reverse()) {
      const key = `${b.from}\u0000${b.body}`;
      const later = newest.get(key);
      if (later) nextSame.set(b, later);
      newest.set(key, b);
    }
    const previousOf = new Map<Block, Block>();
    const lastFrom = new Map<string, Block>();
    for (const b of blocks) {
      const previous = lastFrom.get(b.from);
      if (previous) previousOf.set(b, previous);
      lastFrom.set(b.from, b);
    }
    for (const b of blocks) {
      if (!editable(b)) continue;
      // An exact repeat: the newer copy stays; the older goes unless a token of it is quoted in between.
      const later = nextSame.get(b);
      if (later && b.body.length >= MIN_BLOCK) {
        const quoted = distinctiveTokens(b.idle ? `${b.idle.result}\n${b.body}` : b.body).some((t) => quotedBetween(quotes, t, b.row, later.row));
        if (!quoted) {
          const note = `${USER_ROW_NOTE} repeated in a later message from ${b.from}]`;
          edits.set(b, b.idle ? idleBody(b.idle, note) : note);
          stats.repeated += 1;
          continue;
        }
      }
      // A restated idle: the same agent's previous block is a message (its report).
      if (!b.idle || b.idle.result.length < MIN_BLOCK) continue;
      const previous = previousOf.get(b);
      if (!previous || previous.idle) continue;
      const kept = keptLines(b.idle.result, (t) => quotedBetween(quotes, t, b.row) && !previous.body.includes(t), previous.body, 0);
      if (!kept) continue;
      const note = `${USER_ROW_NOTE} ${b.from}'s closing reply, restating its message above; ${b.idle.result.length} chars omitted]`;
      const body = idleBody(b.idle, withLines(note, kept));
      if (body.length >= b.body.length * (1 - MIN_SAVING)) continue;
      edits.set(b, body);
      stats.restated += 1;
    }
  }

  if (trimStaleTeammates) {
    for (const b of blocks) {
      if (edits.has(b) || !editable(b) || b.row >= total - options.staleAfterMessages) continue;
      const text = b.idle ? b.idle.result : b.body;
      if (text.length < MIN_BLOCK + options.teammateHeadChars) continue;
      const cut = staleBody(text, options.teammateHeadChars, (t) => quotedBetween(quotes, t, b.row));
      if (!cut) continue;
      edits.set(b, b.idle ? idleBody(b.idle, cut) : cut);
      stats.stale += 1;
    }
  }

  const byRow = new Map<number, Block[]>();
  for (const b of blocks) byRow.set(b.row, [...(byRow.get(b.row) ?? []), b]);
  const newestTeammate = messages.reduce((last, m, row) => (isTeammateRow(m) ? row : last), -1);
  const out = messages.map((m, row) => {
    if (guarded.has(row) || !isTeammateRow(m)) return m;
    let text = m.text;
    const rowEdits = (byRow.get(row) ?? []).filter((b) => edits.has(b)).sort((a, b) => b.start - a.start);
    for (const b of rowEdits) text = text.slice(0, b.start) + edits.get(b)! + text.slice(b.end);
    if (dedupePeerNotice && row !== newestTeammate) {
      const at = text.lastIndexOf(`\n\n${PEER_NOTICE}`);
      if (at >= 0 && text.lastIndexOf('</teammate-message>') < at) {
        // The notice's own paragraph only.
        const end = text.indexOf('\n\n', at + 2);
        text = text.slice(0, at) + (end < 0 ? '' : text.slice(end));
        stats.notices += 1;
      }
    }
    if (text === m.text || text.length >= m.text.length) return m;
    stats.rows += 1;
    stats.charsSaved += m.text.length - text.length;
    return { role: m.role, text, toolUses: [] } satisfies Message;
  });
  return { messages: out, stats };
}

/**
 * Rows never rebuilt: the first, the preserved tail, from the `keepRecentUserTurns`-th newest
 * user text row on, and the first user text row of the transcript and after each summary
 * (see the module comment).
 */
function guardedRows(messages: readonly Message[], options: ResolvedCompactOptions): Set<number> {
  const guarded = new Set<number>([0]);
  const total = messages.length;
  for (let row = Math.max(0, total - options.preserveRecentMessages); row < total; row += 1) guarded.add(row);
  const userRows = messages.flatMap((m, row) => (isUserText(m) ? [row] : []));
  if (options.keepRecentUserTurns > 0 && userRows.length > 0) {
    const from = userRows[Math.max(0, userRows.length - options.keepRecentUserTurns)]!;
    for (let row = from; row < total; row += 1) guarded.add(row);
  }
  let afterSummary = true;
  messages.forEach((m, row) => {
    if (!isUserText(m)) return;
    if (afterSummary) guarded.add(row);
    afterSummary = m.text.startsWith(SUMMARY_PREFIX);
  });
  return guarded;
}
