import type { Message } from './types.js';

/**
 * Riders. Claude Code records attachments (reminders, hook output, a prompt the user typed while a
 * tool ran, a queued agent or task message) as entries of their own and hangs each on the message
 * recorded before it. A `session.compact` hook sees only the messages. One it returns unchanged
 * keeps what hangs on it; one it rebuilds (a truncated tool result) loses it, and the hook is not
 * told (2.1.282 `messagesOf`: a rebuilt row is built from its own blocks alone). Measured live: a
 * prompt typed while a Bash call ran rode on that call's result, and truncating the result removed
 * the prompt from the transcript.
 *
 * The hook cannot read the riders on a row, but `$.session.messages({ as: "api" })` shows them as
 * they reach the model: blocks after a row's tool_result in the same user message. A result
 * followed, before the next result, by anything but an ephemeral reminder is protected: its call
 * is kept whole, so its rows come back unchanged.
 */

/** A Messages API message as `$.session.messages({ as: "api" })` returns it. */
export interface ApiLike {
  role: string;
  content: ReadonlyArray<Record<string, unknown>>;
}

/**
 * Reminders whose loss changes nothing the model needs: the token count, hook context and hook
 * success lines, and the task/todo nags. Anything else after a result is treated as content.
 */
const EPHEMERAL = [
  /^<total_tokens>/,
  /^\S+ hook (?:additional context|success):/,
  /^The task tools haven't been used recently/,
  /^The TodoWrite tool hasn't been used recently/,
];

const REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;

/**
 * Whether `text` holds nothing but ephemeral reminders: every `<system-reminder>` in it is one, and
 * nothing but whitespace lies outside them. An empty text is ephemeral.
 */
function ephemeralText(text: string): boolean {
  const outside = text.replace(REMINDER, '');
  if (outside.trim() !== '') return false;
  for (const m of text.matchAll(REMINDER)) {
    const inner = m[1]!.trim();
    if (!EPHEMERAL.some((re) => re.test(inner))) return false;
  }
  return true;
}

function isEphemeral(block: Record<string, unknown>): boolean {
  return block['type'] === 'text' && typeof block['text'] === 'string' && ephemeralText(block['text']);
}

/** A tool_result block's content as text: a string, or its text blocks joined; other blocks count as content of their own. */
function resultContent(block: Record<string, unknown>): { text: string; other: boolean } {
  const content = block['content'];
  if (typeof content === 'string') return { text: content, other: false };
  if (!Array.isArray(content)) return { text: '', other: false };
  const parts = content as Array<Record<string, unknown>>;
  return {
    text: parts.filter((p) => p['type'] === 'text' && typeof p['text'] === 'string').map((p) => p['text'] as string).join('\n'),
    other: parts.some((p) => p['type'] !== 'text'),
  };
}

/**
 * Whether a result's API content carries more than the row's own text: 2.1.282's normalizer folds
 * text that follows a tool_result INTO its content (a verified Slack prompt stays a sibling). What
 * remains once the row's text is taken out must be ephemeral reminders only. When the two do not
 * line up (a different join), only the reminders the row's text lacks are judged.
 */
function foldedRider(block: Record<string, unknown>, rowText: string | undefined): boolean {
  const { text } = resultContent(block);
  if (rowText !== undefined && text.includes(rowText)) return !ephemeralText(text.replace(rowText, ''));
  const own = rowText ?? '';
  for (const m of text.matchAll(REMINDER)) {
    if (own.includes(m[0])) continue;
    if (!EPHEMERAL.some((re) => re.test(m[1]!.trim()))) return true;
  }
  return false;
}

/**
 * What carries a non-ephemeral rider, read from the API view (`$.session.messages({ as: "api" })`):
 * calls (by tool_use_id) and user text rows (by object). `rows` are the messages the hook sees.
 *
 * - A rider folded into a result's content protects that result.
 * - A sibling block protects every result of its message (the normalizer hoists results to the
 *   front, so position does not say which one it rode on), unless it follows a user row's own
 *   text: then it rides on that row. Texts are compared trimmed (a merge appends a newline).
 * - Rows with identical text are all protected when one is.
 *
 * The view holds at most 4096 messages; a result outside it is judged unprotected.
 */
export function riderProtected(
  api: readonly ApiLike[],
  rows: readonly Message[],
): { callIds: Set<string>; rows: Set<Message> } {
  const byText = new Map<string, Message[]>();
  const resultText = new Map<string, string>();
  for (const m of rows) {
    for (const r of m.toolResults ?? []) resultText.set(r.tool_use_id, r.text);
    if (m.role !== 'user' || !m.text.trim() || (m.toolResults ?? []).length > 0) continue;
    const key = m.text.trim();
    byText.set(key, [...(byText.get(key) ?? []), m]);
  }
  const callIds = new Set<string>();
  const protectedRows = new Set<Message>();
  for (const message of api) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    const results: string[] = [];
    let current: Message[] | undefined;
    for (const block of message.content) {
      if (block['type'] === 'tool_result') {
        const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined;
        if (id === undefined) continue;
        results.push(id);
        if (foldedRider(block, resultText.get(id))) callIds.add(id);
        current = undefined;
        continue;
      }
      const own = block['type'] === 'text' && typeof block['text'] === 'string' ? byText.get(block['text'].trim()) : undefined;
      if (own) {
        current = own;
        continue;
      }
      if (isEphemeral(block)) continue;
      if (current) for (const m of current) protectedRows.add(m);
      else for (const id of results) callIds.add(id);
    }
  }
  return { callIds, rows: protectedRows };
}

/** tool_use_ids whose results carry a non-ephemeral rider (see riderProtected). */
export function riderProtectedIds(api: readonly ApiLike[], rows: readonly Message[]): Set<string> {
  return riderProtected(api, rows).callIds;
}

/**
 * `ids` grown to every call sharing a row with one of them, until nothing changes: a row comes back
 * unchanged only if none of its calls is cut, and one cut sibling would rebuild it.
 */
export function protectRows(messages: readonly Message[], ids: Iterable<string>): Set<string> {
  const out = new Set(ids);
  if (out.size === 0) return out;
  const rows = messages
    .map((m) => [...m.toolUses.map((u) => u.tool_use_id), ...(m.toolResults ?? []).map((r) => r.tool_use_id)])
    .filter((row) => row.length > 1);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows) {
      if (!row.some((id) => out.has(id)) || row.every((id) => out.has(id))) continue;
      for (const id of row) out.add(id);
      grew = true;
    }
  }
  return out;
}
