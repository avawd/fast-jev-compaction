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
  /** The result text; attached by `annotateCalls` for the rules that read it. */
  resultText?: string;
  /** Messages after the one holding the result. */
  age?: number;
  /** Older than `staleAfterMessages`. */
  stale?: boolean;
  /** Distinct tokens this result carries that later assistant text or tool input quotes (see pin.ts). */
  refTokens?: string[];
  /** `refTokens.length`; shown to the scorer as `ref-later:n`. */
  refLater?: number;
}

export type CallAction = 'keep' | 'drop_result' | 'drop_call';
export type RuleName =
  | 'stale_read'
  | 'repeated_search'
  | 'failed_then_fixed'
  | 'mcp_write_echo'
  | 'bash_read_superseded'
  | 'readonly_superseded'
  | 'agent_boilerplate'
  | 'stale_age';

/** A non-keep decision about one call, and who made it. */
export interface Verdict {
  action: 'drop_result' | 'drop_call';
  source: 'rule' | 'claude';
  rule?: RuleName;
  /**
   * For a rule verdict, the id of the later call that justified it (the re-read, the repeated
   * search, the successful retry). That call is the only remaining copy of what this one is
   * losing, so it must never itself be offered for dropping.
   */
  evidence?: string;
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
  /** How long the Claude stage waited, when it ran at all. */
  claudeMs?: number;
}

/** Receives every paired call (pinned ones included, as evidence) and returns verdicts. */
export type Scorer = (calls: readonly ToolCall[]) => Promise<ScoreOutcome>;

export interface CallDecision {
  id: string;
  tool: string;
  action: CallAction;
  source: 'pinned' | 'rule' | 'claude' | 'default';
  rule?: RuleName;
  /** Characters of the result to keep when it differs from `truncateHeadChars`. */
  headChars?: number;
}

export interface CompactOptions {
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Characters of a truncated tool result to retain. Default 300. */
  truncateHeadChars?: number;
  /** Extra characters kept from the end of a log-like result (test/build/deploy...). Default 1000. */
  truncateTailChars?: number;
  /** Read and Bash file-read results older than this many messages are truncated. Default 60. */
  staleAfterMessages?: number;
  /** Never drop a result whose introduced tokens are quoted later. Default true. */
  pinReferenced?: boolean;
  /** Strip JSON furniture (self links, avatars, feature flags...) from MCP results. Default true. */
  stripMcpFurniture?: boolean;
}

export interface ResolvedCompactOptions {
  preserveRecentMessages: number;
  truncateHeadChars: number;
  truncateTailChars: number;
  staleAfterMessages: number;
  pinReferenced: boolean;
  stripMcpFurniture: boolean;
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
    /** Tool-result characters before compaction; the denominator of `gateRatio`. */
    resultCharsBefore: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    byRule: number;
    byClaude: number;
    claude: ClaudeStatus;
    /** How long the Claude stage waited; absent when it never started. */
    claudeMs?: number;
    ms: number;
  };
}
