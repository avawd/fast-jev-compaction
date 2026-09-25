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

const REMINDER = /^\s*<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>\s*$/;

function isEphemeral(block: Record<string, unknown>): boolean {
  if (block['type'] !== 'text' || typeof block['text'] !== 'string') return false;
  const inner = REMINDER.exec(block['text'])?.[1];
  return inner !== undefined && EPHEMERAL.some((re) => re.test(inner));
}

/**
 * What carries a non-ephemeral rider: calls (by tool_use_id, from the result it follows) and user
 * text rows (by object, from the text block that is that row). `rows` are the messages the hook
 * sees; a user row's text starts that row, and whatever follows it before the next result or row
 * hangs on it. Rows with identical text are all protected when one is (the view cannot tell them apart).
 */
export function riderProtected(
  api: readonly ApiLike[],
  rows: readonly Message[],
): { callIds: Set<string>; rows: Set<Message> } {
  const byText = new Map<string, Message[]>();
  for (const m of rows) {
    if (m.role !== 'user' || !m.text.trim() || (m.toolResults ?? []).length > 0) continue;
    byText.set(m.text, [...(byText.get(m.text) ?? []), m]);
  }
  const callIds = new Set<string>();
  const protectedRows = new Set<Message>();
  for (const message of api) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    let current: { id: string } | { rows: Message[] } | undefined;
    for (const block of message.content) {
      if (block['type'] === 'tool_result') {
        current = typeof block['tool_use_id'] === 'string' ? { id: block['tool_use_id'] } : undefined;
        continue;
      }
      const own = block['type'] === 'text' && typeof block['text'] === 'string' ? byText.get(block['text']) : undefined;
      if (own) {
        current = { rows: own };
        continue;
      }
      if (current === undefined || isEphemeral(block)) continue;
      if ('id' in current) callIds.add(current.id);
      else for (const m of current.rows) protectedRows.add(m);
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
