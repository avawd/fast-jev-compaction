import type { Message, ToolCall, Verdict } from './types.js';

/** Results at or below this size are cheap enough to leave alone. */
const MCP_MIN_CHARS = 500;

const WRITE_VERBS = new Set(['create', 'edit', 'update', 'transition', 'add', 'comment']);

/** Keys that carry links, images or client plumbing rather than business data. */
const FURNITURE_KEYS = new Set(['self', 'avatarUrls', 'expand', 'featureFlags', 'iconUrl']);

/** Keys that mark a top-level `context` object as an MCP server's request envelope. */
const ENVELOPE_KEYS = ['invocationId', 'toolName', 'mcpClientName', 'cloudId'];

/** The words of an MCP tool's own name: `mcp__srv__addCommentToJiraIssue` → add, comment, to, jira, issue. */
function leafWords(tool: string): string[] {
  const leaf = tool.split('__').pop() ?? '';
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** An MCP tool whose name says it writes something (create, edit, update, transition, add, comment). */
export function isMcpWriteTool(tool: string): boolean {
  return tool.startsWith('mcp__') && leafWords(tool).some((w) => WRITE_VERBS.has(w));
}

/**
 * A write's result is the server echoing back what was just written: the call
 * (and its input) is the record that it happened, the echo is not needed.
 */
export function mcpWriteEcho(call: ToolCall): Verdict | undefined {
  if (call.pinned || call.isError || call.resultChars <= MCP_MIN_CHARS) return undefined;
  if (!isMcpWriteTool(call.tool)) return undefined;
  return { action: 'drop_result', source: 'rule', rule: 'mcp_write_echo' };
}

function isEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return ENVELOPE_KEYS.some((k) => k in (value as Record<string, unknown>));
}

function without(record: Record<string, unknown>, omit: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key !== omit) Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Thrown when re-serializing would change a value (an integer beyond 2^53). */
const INEXACT = Symbol('inexact');

function stripValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripValue);
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) throw INEXACT;
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FURNITURE_KEYS.has(key)) continue;
    if (child === null && /^customfield_\d+$/.test(key)) continue;
    // defineProperty, not assignment: a `__proto__` key is data here, not the prototype.
    Object.defineProperty(out, key, { value: stripValue(child), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * Removes JSON furniture from an MCP result: self links, avatar and icon URLs,
 * `expand` hints, feature flags, empty custom fields, and the server's
 * top-level request envelope (`context`). Every other value is kept exactly.
 * Text that is not a JSON object, or that would not get shorter, is returned
 * as the same string.
 */
export function stripMcpFurniture(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  let stripped: unknown;
  try {
    stripped = stripValue(parsed);
  } catch (error) {
    if (error === INEXACT) return text;
    throw error;
  }
  if (stripped !== null && typeof stripped === 'object' && !Array.isArray(stripped)) {
    const record = stripped as Record<string, unknown>;
    if (Object.hasOwn(record, 'context') && isEnvelope(record['context'])) {
      stripped = without(record, 'context');
    }
  }
  const out = JSON.stringify(stripped);
  return out.length < text.length ? out : text;
}

/**
 * Applies `stripMcpFurniture` to every unpinned, successful MCP result of at
 * least MCP_MIN_CHARS, unless the strip would remove a token quoted later.
 * Untouched messages are returned as the same objects.
 */
export function stripFurnitureInMessages(messages: readonly Message[], calls: readonly ToolCall[]): Message[] {
  const targets = new Map(
    calls
      .filter((c) => !c.pinned && !c.isError && c.tool.startsWith('mcp__') && c.resultChars >= MCP_MIN_CHARS)
      .map((c) => [c.tool_use_id, c]),
  );
  if (targets.size === 0) return [...messages];
  return messages.map((message) => {
    const results = message.toolResults;
    if (!results || !results.some((r) => targets.has(r.tool_use_id))) return message;
    let changed = false;
    const toolResults = results.map((result) => {
      const call = targets.get(result.tool_use_id);
      if (!call) return result;
      const text = stripMcpFurniture(result.text);
      if (text === result.text) return result;
      if ((call.refTokens ?? []).some((token) => !text.includes(token))) return result;
      changed = true;
      return { ...result, text };
    });
    return changed ? { ...message, toolResults } : message;
  });
}
