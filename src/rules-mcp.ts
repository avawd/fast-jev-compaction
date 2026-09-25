import type { Message, ToolCall, Verdict } from './types.js';

/** Results at or below this size are cheap enough to leave alone. */
const MCP_MIN_CHARS = 500;

const WRITE_VERBS = new Set(['create', 'edit', 'update', 'transition', 'add', 'comment']);
/** A name holding one of these reads, whatever it starts with (`comment_search`). */
const READ_VERBS = new Set(['get', 'read', 'list', 'search', 'fetch', 'lookup', 'find', 'query']);

/** Keys that carry links, images or client plumbing rather than business data. */
const FURNITURE_KEYS = new Set(['avatarUrls', 'expand', 'featureFlags', 'iconUrl']);
/** `self` is furniture only as a link; `"self": true` (a reaction by me) is data. */
const SELF_LINK = /^https?:\/\//;

/** Keys that mark a top-level `context` object as an MCP server's request envelope. */
const ENVELOPE_KEYS = ['invocationId', 'toolName', 'mcpClientName', 'cloudId'];

/** Leaf names that start with a write verb but read: Atlassian's graph-context lookup. */
const READS_DESPITE_NAME = new Set(['addteamworkgraphcontext']);

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/**
 * The words of an MCP tool's own name, without a leading repeat of its server's name:
 * `mcp__srv__addCommentToJiraIssue` → add, comment, to, jira, issue;
 * `mcp__claude_ai_Slack__slack_add_reaction` → add, reaction.
 */
function leafWords(tool: string): string[] {
  const parts = tool.split('__');
  const server = new Set(words(parts[1] ?? ''));
  const leaf = words(parts[parts.length - 1] ?? '');
  let i = 0;
  while (i < leaf.length - 1 && server.has(leaf[i]!)) i += 1;
  return leaf.slice(i);
}

/**
 * An MCP tool whose name LEADS with a write verb (create, edit, update, transition, add,
 * comment). A verb later in the name does not count: `getComment`, `comment_search` and
 * `list_recent_updates` read, and so does any name holding a read verb.
 */
export function isMcpWriteTool(tool: string): boolean {
  if (!tool.startsWith('mcp__')) return false;
  const leaf = (tool.split('__').pop() ?? '').toLowerCase();
  if (READS_DESPITE_NAME.has(leaf)) return false;
  const leafs = leafWords(tool);
  return WRITE_VERBS.has(leafs[0] ?? '') && !leafs.some((w) => READ_VERBS.has(w));
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


/**
 * Whether every number literal in `json` (outside strings) is written exactly as
 * JSON.stringify would write it back. `1.0`, `1e400`, `-0`, `1E5` and digits past a
 * double's precision all fail: re-serialising them would change the text of a value.
 */
function numbersRoundTrip(json: string): boolean {
  let inString = false;
  for (let i = 0; i < json.length; i += 1) {
    const ch = json[i]!;
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const literal = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(json.slice(i, i + 400))?.[0] ?? ch;
      if (JSON.stringify(Number(literal)) !== literal) return false;
      i += literal.length - 1;
    }
  }
  return true;
}

function stripValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripValue);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FURNITURE_KEYS.has(key)) continue;
    if (key === 'self' && typeof child === 'string' && SELF_LINK.test(child)) continue;
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
 * `self` goes only when it is a URL. Text that is not JSON, that holds a number
 * literal JSON.stringify would write differently (`1.0`, `-0`, `1e400`, digits
 * past a double's precision), or that would not get shorter, is returned as
 * the same string.
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
  if (!numbersRoundTrip(text)) return text;
  let stripped = stripValue(parsed);
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
