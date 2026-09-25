import type { UserRowStats } from './user-rows.js';

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
  /** The first characters of the result, for the scorer's preview. */
  resultHead?: string;
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
  /** The session's working directory, when known: relative paths in Bash commands resolve against it. */
  cwd?: string;
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
  | 'stale_age'
  /** Tier 2 only: a result an earlier compaction truncated, older than the tier's age, cut further. */
  | 'stale_truncation';

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
  /** Further evidence when one later call was not enough (a multi-file read, a multi-step chain). */
  moreEvidence?: string[];
}

/**
 * What happened to the Claude stage in one compaction. `unparseable` is only a reply
 * whose text was read and was not the asked-for JSON; `no-fork`, `api-error [status]`,
 * `aborted` and `empty` are the engine's own reasons for having no text; `null` is a
 * pre-2.1.281 engine's empty answer; `error` a fork that threw or an unknown reason.
 */
export type ClaudeStatus =
  | 'ran'
  /** Some of the concurrent forks answered, some did not. */
  | 'partial'
  | 'skipped'
  | 'null'
  | 'unparseable'
  | 'error'
  | 'timeout'
  | 'no-fork'
  | 'api-error'
  /** A safeguard refusal: a status-less `invalid_request` error frame (2.1.281 lQe). */
  | 'refused'
  | `api-error ${number}`
  | 'aborted'
  | 'empty';

/** What one fork of a chunked Claude run did. */
export interface ForkRun {
  candidates: number;
  ms: number;
  status: ClaudeStatus;
  /** A re-ask after the chunk's first fork failed: `whole` once, then its two `half`s. */
  retry?: 'whole' | 'half';
}

export interface ScoreOutcome {
  /** Keyed by `ToolCall.id`. Calls absent from the map are kept. */
  verdicts: Map<string, Verdict>;
  claude: ClaudeStatus;
  /** How long the Claude stage waited, when it ran at all. */
  claudeMs?: number;
  /** One entry per fork, in chunk order; absent when none ran. */
  forks?: ForkRun[];
  /** `race`: the short timeout applied (rules alone cleared the gate); `await`: the long ceiling did. */
  wait?: 'race' | 'await';
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
  /** Keep no tail, whatever the tool: a Claude `drop` keeps its head only (see compact.ts preferTruncation). */
  headOnly?: boolean;
  /**
   * `[start, end)` excerpts of the result to keep between its head and tail, in order and
   * disjoint, around later-quoted tokens no head could reach (see `excerptPlan`).
   */
  windows?: Array<[number, number]>;
}

export interface CompactOptions {
  /** Newest messages never touched (the first message is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Characters of a truncated tool result to retain. Default 300. */
  truncateHeadChars?: number;
  /** Extra characters kept from the end of a log-like result (test/build/deploy...). Default 1000. */
  truncateTailChars?: number;
  /** Read and Bash file-read results older than this many messages (one per content block) are truncated. Default 100. */
  staleAfterMessages?: number;
  /** Never drop a result whose introduced tokens are quoted later. Default true. */
  pinReferenced?: boolean;
  /** Strip JSON furniture (self links, avatars, feature flags...) from MCP results. Default true. */
  stripMcpFurniture?: boolean;
  /** The session's working directory (absolute), for resolving relative paths. Unknown if absent. */
  cwd?: string;
  /**
   * Shorten the long inputs of old calls (Bash commands, Write contents, Edit strings, subagent
   * prompts...) to a head, the lines holding later-quoted tokens, and a note (see shrink.ts). Default true.
   */
  shrinkOldInputs?: boolean;
  /**
   * The caller's gate (`gateRatio`). When set and missed on a transcript an earlier compaction
   * already truncated, compact() tries a stricter tier 2 (see escalate.ts). Unset: off.
   */
  escalateBelow?: number;
  /** Teammate rows: restated idle notifications and exact repeats become notes. Default true. */
  dedupeTeammates?: boolean;
  /** Teammate messages older than `staleAfterMessages` keep their head, salient and quoted-later lines. Default true. */
  trimStaleTeammates?: boolean;
  /** The peer-message notice stays on the newest teammate row only. Default true. */
  dedupePeerNotice?: boolean;
  /** Characters of a stale teammate message's head to keep. Default 1000. */
  teammateHeadChars?: number;
  /** User text rows, newest first, the teammate pass never rewrites, with every user row after them. Default 3. */
  keepRecentUserTurns?: number;
  /**
   * tool_use_ids whose calls are kept whole (pinned): their rows carry riders a rebuild would lose
   * (see riders.ts). Default none.
   */
  protectedResultIds?: readonly string[];
  /** Input rows (user text rows) carrying riders (riders.ts): every pass returns them unchanged. */
  protectedRows?: readonly Message[];
}

export interface ResolvedCompactOptions {
  preserveRecentMessages: number;
  truncateHeadChars: number;
  truncateTailChars: number;
  staleAfterMessages: number;
  pinReferenced: boolean;
  stripMcpFurniture: boolean;
  shrinkOldInputs: boolean;
  cwd?: string;
  dedupeTeammates: boolean;
  trimStaleTeammates: boolean;
  dedupePeerNotice: boolean;
  teammateHeadChars: number;
  keepRecentUserTurns: number;
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
    /** Old tool inputs shortened (see shrink.ts). */
    inputsShrunk: number;
    claude: ClaudeStatus;
    /** How long the Claude stage waited; absent when it never started. */
    claudeMs?: number;
    /** Per-fork timings of the Claude stage; absent when no fork ran. */
    forks?: ForkRun[];
    wait?: 'race' | 'await';
    /** 2 when the stricter second tier produced this result (see CompactOptions.escalateBelow). */
    tier?: 2;
    /** What the teammate-row pass cut (see user-rows.ts); absent when it changed nothing. */
    userRows?: UserRowStats;
    ms: number;
  };
}
