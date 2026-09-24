export type Role = 'user' | 'assistant';

/** A tool_use block. `text`/`isError` mirror the outcome once Claude Code attaches it. */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  text?: string;
  isError?: boolean;
}

/** A tool_result block of a user message. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/** One transcript message; a subset of Claude Code's `SessionMessage`. */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id (`t1`, `t2`, ...) in transcript order. */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  callIndex: number;
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a target. */
  pinned: boolean;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';
export type RuleName = 'stale_read' | 'repeated_search' | 'failed_then_fixed';

/** A non-keep decision about one call, and who made it. */
export interface Verdict {
  action: 'drop_result' | 'drop_call';
  source: 'rule' | 'claude';
  rule?: RuleName;
}

/**
 * What happened to the Claude stage in one compaction. `unparseable` is only a reply
 * whose text was read and was not the asked-for JSON; `no-fork`, `api-error [status]`,
 * `aborted` and `empty` are the engine's own reasons for having no text; `null` is a
 * pre-2.1.281 engine's empty answer; `error` a fork that threw or an unknown reason.
 */
export type ClaudeStatus =
  | 'ran'
  | 'skipped'
  | 'null'
  | 'unparseable'
  | 'error'
  | 'timeout'
  | 'no-fork'
  | 'api-error'
  | `api-error ${number}`
  | 'aborted'
  | 'empty';

export interface ScoreOutcome {
  /** Keyed by `ToolCall.id`. Calls absent from the map are kept. */
  verdicts: Map<string, Verdict>;
  claude: ClaudeStatus;
}

/** Receives every paired call (pinned ones included, as evidence) and returns verdicts. */
export type Scorer = (calls: readonly ToolCall[]) => Promise<ScoreOutcome>;

export interface CallDecision {
  id: string;
  tool: string;
  action: CallAction;
  source: 'pinned' | 'rule' | 'claude' | 'default';
  rule?: RuleName;
}

export interface CompactOptions {
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Characters of a truncated tool result to retain. Default 300. */
  truncateHeadChars?: number;
}

export interface ResolvedCompactOptions {
  preserveRecentMessages: number;
  truncateHeadChars: number;
}

export interface CompactResult {
  /** The compacted transcript; untouched messages are the input objects. */
  messages: Message[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    byRule: number;
    byClaude: number;
    claude: ClaudeStatus;
    ms: number;
  };
}
