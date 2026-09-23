# Claude-scored verbatim compaction: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Jev scorer with local staleness rules plus one tool-less `$.model.fork` completion,
keeping the verbatim-pruning compaction behaviour.

**Architecture:** `compact()` stops calling Jev and takes a `Scorer` instead (an injected async function
from tool calls to verdicts). `src/rules.ts` and `src/claude-scorer.ts` produce verdicts, and
`src/score.ts` combines them into a `Scorer`. `hooks/verbatim.ts` wires a scorer built on `$.model.fork`
into `session.compact` and keeps upstream's `turn.complete` trigger.

**Tech Stack:** TypeScript (strict), Node ≥ 18, vitest, Claude Code function hooks (early access; types in
`types/claude-code.d.ts`).

Spec: `docs/superpowers/specs/2026-09-23-claude-scored-compaction-design.md`.

## Global Constraints

- **The repository is PUBLIC.** No file, test fixture, comment or commit message may contain a real
  name, email, company, hostname, IP address, home-directory path, session link, or any key or token.
  Fixtures use made-up paths such as `src/a.ts`. The local `.git/hooks/pre-commit` guard enforces this;
  never bypass it with `--no-verify`.
- Commit identity is the GitHub noreply address already configured for this repo. Do not change `user.*`.
- Commit messages end with only: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`
- Commits stay local. Do not `git push` until the repo owner says so.
- No new runtime dependencies. Dev dependencies stay as they are (vitest, typescript, @types/node).
- User and assistant text is never modified. The first message and the newest `preserveRecentMessages`
  messages are never modified. No tool result may be left without its call.
- Defaults: `compactAtPercent` 60, `minReductionRatio` 0.25, `preserveRecentMessages` 6,
  `truncateHeadChars` 300, `maxCandidates` 400, `useClaudeScorer` true.
- Test runner: `npx vitest run <file>`. Typecheck: `npm run typecheck` (library and hooks).

## File structure

| File | Action | Responsibility |
|---|---|---|
| `src/types.ts` | rewrite | Message and call types, `Verdict`, `Scorer`, `CallDecision`, `CompactResult` |
| `src/calls.ts` | create (from `src/state.ts`) | `isPinned`, `collectToolCalls` |
| `src/compact.ts` | rewrite | `resolveOptions`, `applyDecisions` (upstream, kept), `compact(messages, scorer, options)` |
| `src/rules.ts` | create | `applyRules(calls)`, the stage 1 rules |
| `src/claude-scorer.ts` | create | `candidateLine`, `selectCandidates`, `buildPrompt`, `parseReply`, `scoreWithClaude` |
| `src/score.ts` | create | `makeScorer(options)` merges both stages |
| `src/index.ts` | rewrite | Public exports |
| `hooks/verbatim.ts` | create (replaces `hooks/fast-jev.ts`) | Engine wiring |
| `hooks/hooks.json`, `.claude-plugin/*.json`, `package.json`, `README.md`, `hooks/README.md` | modify | Rename, config, docs |
| delete | — | `src/client.ts`, `src/request.ts`, `src/messages.ts`, `src/state.ts`, `hooks/fast-jev.ts`, `tests/fast-jev-compaction.test.ts`, `examples/`, `demo/` |
| `tests/compact.test.ts`, `tests/rules.test.ts`, `tests/claude-scorer.test.ts`, `tests/score.test.ts`, `tests/hook.test.ts`, `tests/invariants.test.ts` | create/rewrite | Tests |

---

### Task 1: Scorer-neutral core (remove Jev)

**Files:**
- Rewrite: `src/types.ts`, `src/compact.ts`, `src/index.ts`
- Create: `src/calls.ts`
- Delete: `src/client.ts`, `src/request.ts`, `src/messages.ts`, `src/state.ts`, `tests/fast-jev-compaction.test.ts`, `examples/demo.ts`
- Test: `tests/compact.test.ts`

**Interfaces:**
- Produces: the types below. `collectToolCalls(messages, preserveRecentMessages): ToolCall[]`,
  `isPinned(index, total, preserve): boolean`, `applyDecisions(messages, decisions, calls, headChars): Message[]`,
  `messageChars(message): number`, `reductionRatio(result): number`,
  `compact(messages, scorer: Scorer, options?: CompactOptions): Promise<CompactResult>`,
  `resolveOptions(options?): ResolvedCompactOptions`, `TRUNCATION_NOTE_PREFIX`.

- [ ] **Step 1: Install and record the baseline**

Run: `npm install && npx vitest run`
Expected: the upstream suites pass. This confirms the toolchain works before anything is changed.

- [ ] **Step 2: Write the failing test** `tests/compact.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { compact, reductionRatio, type Message, type Scorer, type ToolCall } from '../src/index.js';

const big = 'x'.repeat(4000);

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function use(id: string, tool: string, input: Record<string, unknown>): Message {
  return msg('assistant', '', { toolUses: [{ tool_use_id: id, tool, input }] });
}
function res(id: string, text: string, isError = false): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

function transcript(): Message[] {
  return [
    msg('user', 'Fix the failing test.'),
    use('u1', 'Read', { file_path: 'src/a.ts' }),
    res('u1', big),
    use('u2', 'Bash', { command: 'npm test' }),
    res('u2', big),
    msg('assistant', 'Done reading.'),
    msg('user', 'next'),
    msg('assistant', 'ok'),
    msg('user', 'next'),
    msg('assistant', 'ok'),
    msg('user', 'next'),
  ];
}

describe('compact', () => {
  it('applies scorer verdicts, keeps text verbatim, and never scores pinned calls', async () => {
    let seen: readonly ToolCall[] = [];
    const scorer: Scorer = async (calls) => {
      seen = calls;
      return {
        claude: 'ran',
        verdicts: new Map([
          ['t1', { action: 'drop_result', source: 'rule', rule: 'stale_read' }],
          ['t2', { action: 'drop_call', source: 'claude' }],
        ]),
      };
    };
    const input = transcript();
    const out = await compact(input, scorer, { preserveRecentMessages: 6 });
    expect(seen.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(out.messages.map((m) => m.text)).toEqual(
      input.map((m) => m.text).filter((_, i) => i !== 3 && i !== 4),
    );
    expect(out.messages[2]?.toolResults?.[0]?.text.length).toBeLessThan(600);
    expect(out.stats).toMatchObject({ calls: 2, resultsDropped: 1, callsDropped: 1, byRule: 1, byClaude: 1, claude: 'ran' });
    expect(out.decisions.find((d) => d.id === 't1')).toMatchObject({ source: 'rule', rule: 'stale_read' });
    expect(reductionRatio(out)).toBeGreaterThan(0.5);
  });

  it('keeps everything and skips the scorer when there are no unpinned calls', async () => {
    let called = false;
    const scorer: Scorer = async () => {
      called = true;
      return { claude: 'ran', verdicts: new Map() };
    };
    const input = [msg('user', 'hi'), msg('assistant', 'hello')];
    const out = await compact(input, scorer);
    expect(called).toBe(false);
    expect(out.messages[0]).toBe(input[0]);
    expect(out.stats.claude).toBe('skipped');
  });

  it('ignores verdicts for pinned or unknown ids', async () => {
    const scorer: Scorer = async () => ({
      claude: 'ran',
      verdicts: new Map([
        ['t9', { action: 'drop_call', source: 'claude' }],
      ]),
    });
    const input = transcript();
    const out = await compact(input, scorer);
    expect(out.messages).toHaveLength(input.length);
    expect(out.stats.callsDropped).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/compact.test.ts`
Expected: FAIL. `Scorer` is not exported, and `compact` still expects a `JevAsker`.

- [ ] **Step 4: Replace `src/types.ts`**

```ts
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

/** What happened to the Claude stage in one compaction. */
export type ClaudeStatus = 'ran' | 'skipped' | 'null' | 'unparseable' | 'error';

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
```

- [ ] **Step 5: Create `src/calls.ts`**

```ts
import type { Message, ToolCall, ToolResult } from './types.js';

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a
 * result are not candidates (there is nothing to drop yet).
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}
```

- [ ] **Step 6: Rewrite `src/compact.ts`**

Keep upstream's `applyDecisions` and `messageChars` exactly as they are (the current file, from
`function truncatedResultText` through the end of `messageChars`), with one change to the note text.
Replace the rest of the file with the code below.

```ts
import { collectToolCalls } from './calls.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  Message,
  ResolvedCompactOptions,
  Scorer,
  ScoreOutcome,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  preserveRecentMessages: 6,
  truncateHeadChars: 300,
};

export const TRUNCATION_NOTE_PREFIX = '[verbatim-compaction truncated';

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  return {
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages)),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
  };
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : '';
  return `${head}${TRUNCATION_NOTE_PREFIX} ${text.length - headChars} chars of this tool result${
    isError ? ' (error)' : ''
  }; re-run the tool if needed]`;
}

// --- applyDecisions and messageChars: copy upstream's bodies unchanged here ---

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

/**
 * Compacts a transcript: every paired call goes to `scorer`, and its verdicts
 * drop or truncate unpinned calls. Verdicts naming pinned or unknown calls are
 * ignored. Throws only if the scorer throws; the caller decides the fallback.
 */
export async function compact(
  messages: readonly Message[],
  scorer: Scorer,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const charsBefore = messages.reduce((sum, m) => sum + messageChars(m), 0);
  const outcome: ScoreOutcome = calls.some((c) => !c.pinned)
    ? await scorer(calls)
    : { verdicts: new Map(), claude: 'skipped' };

  const decisions: CallDecision[] = calls.map((call) => {
    if (call.pinned) return { id: call.id, tool: call.tool, action: 'keep', source: 'pinned' };
    const verdict = outcome.verdicts.get(call.id);
    if (!verdict) return { id: call.id, tool: call.tool, action: 'keep', source: 'default' };
    const decision: CallDecision = {
      id: call.id,
      tool: call.tool,
      action: verdict.action,
      source: verdict.source,
    };
    if (verdict.rule) decision.rule = verdict.rule;
    return decision;
  });
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  const by = (pred: (d: CallDecision) => boolean) => decisions.filter(pred).length;
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, m) => sum + messageChars(m), 0),
      calls: calls.length,
      kept: by((d) => d.action === 'keep' && d.source !== 'pinned'),
      resultsDropped: by((d) => d.action === 'drop_result'),
      callsDropped: by((d) => d.action === 'drop_call'),
      pinned: by((d) => d.source === 'pinned'),
      byRule: by((d) => d.source === 'rule'),
      byClaude: by((d) => d.source === 'claude'),
      claude: outcome.claude,
      ms: Date.now() - started,
    },
  };
}
```

In the copied `applyDecisions`, the parameter types stay `CallDecision[]` and `ToolCall[]`. It reads only
`decision.id` and `decision.action`, so it works with the new `CallDecision` unchanged. Import `ToolCall`
alongside the other types.

- [ ] **Step 7: Rewrite `src/index.ts` and delete the Jev modules**

```ts
export * from './types.js';
export * from './calls.js';
export * from './compact.js';
```

Run: `git rm -q src/client.ts src/request.ts src/messages.ts src/state.ts tests/fast-jev-compaction.test.ts examples/demo.ts`
Then remove the `"demo"` script line from `package.json`.

- [ ] **Step 8: Run the test and the library typecheck**

Run: `npx vitest run tests/compact.test.ts && npx tsc --noEmit`
Expected: 3 tests PASS and tsc prints nothing. The hooks typecheck still fails, because
`hooks/fast-jev.ts` is replaced in Task 5. `tests/hook.test.ts` also fails for now; Task 5 rewrites it.

- [ ] **Step 9: Commit**

```bash
git add -A src tests/compact.test.ts package.json
git commit -m "refactor: make compaction scorer-neutral and remove the Jev client

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Stage 1 rules

**Files:**
- Create: `src/rules.ts`
- Test: `tests/rules.test.ts`
- Modify: `src/index.ts` (add `export * from './rules.js';`)

**Interfaces:**
- Consumes: `ToolCall`, `Verdict`, `RuleName` from Task 1.
- Produces: `applyRules(calls: readonly ToolCall[]): Map<string, Verdict>` (keyed by `ToolCall.id`, only
  unpinned targets), `canonicalJson(value: unknown): string`, `normalizePath(p: string): string`.

- [ ] **Step 1: Write the failing test** `tests/rules.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { applyRules, canonicalJson, normalizePath, type ToolCall } from '../src/index.js';

let n = 0;
function c(tool: string, input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
  n += 1;
  return {
    id: `t${n}`, tool_use_id: `u${n}`, tool, input, callIndex: n, resultIndex: n,
    resultChars: 1000, isError: false, pinned: false, ...extra,
  };
}
function fresh(): void { n = 0; }

describe('applyRules', () => {
  it('truncates a read of a file that is later edited or re-read', () => {
    fresh();
    const calls = [
      c('Read', { file_path: './src/a.ts' }),
      c('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }),
      c('Read', { file_path: 'src/b.ts' }),
      c('Read', { file_path: 'src/b.ts' }),
    ];
    const v = applyRules(calls);
    expect(v.get('t1')).toEqual({ action: 'drop_result', source: 'rule', rule: 'stale_read' });
    expect(v.get('t3')).toEqual({ action: 'drop_result', source: 'rule', rule: 'stale_read' });
    expect(v.has('t2')).toBe(false);
    expect(v.has('t4')).toBe(false);
  });

  it('drops an older identical search, regardless of key order', () => {
    fresh();
    const calls = [
      c('Grep', { pattern: 'foo', path: 'src' }),
      c('Grep', { path: 'src', pattern: 'foo' }),
      c('Grep', { pattern: 'bar', path: 'src' }),
    ];
    const v = applyRules(calls);
    expect(v.get('t1')).toEqual({ action: 'drop_call', source: 'rule', rule: 'repeated_search' });
    expect(v.size).toBe(1);
  });

  it('drops a failed call that was later retried with the same input and succeeded', () => {
    fresh();
    const calls = [
      c('Bash', { command: 'npm test' }, { isError: true }),
      c('Bash', { command: 'npm test' }),
      c('Bash', { command: 'npm run build' }, { isError: true }),
    ];
    const v = applyRules(calls);
    expect(v.get('t1')).toEqual({ action: 'drop_call', source: 'rule', rule: 'failed_then_fixed' });
    expect(v.has('t3')).toBe(false);
  });

  it('never targets a pinned call but uses one as evidence', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'src/a.ts' }, { pinned: true }),
      c('Read', { file_path: 'src/b.ts' }),
      c('Edit', { file_path: 'src/b.ts' }, { pinned: true }),
      c('Read', { file_path: 'src/a.ts' }),
    ];
    const v = applyRules(calls);
    expect(v.has('t1')).toBe(false);
    expect(v.get('t2')?.rule).toBe('stale_read');
  });

  it('leaves different paths and different inputs alone', () => {
    fresh();
    const calls = [
      c('Read', { file_path: 'src/a.ts' }),
      c('Edit', { file_path: 'src/b.ts' }),
      c('Glob', { pattern: '*.ts' }),
      c('Glob', { pattern: '*.tsx' }),
    ];
    expect(applyRules(calls).size).toBe(0);
  });
});

describe('helpers', () => {
  it('canonicalJson sorts keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } }))
      .toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });
  it('normalizePath strips ./ and collapses segments', () => {
    expect(normalizePath('./src//x/../a.ts')).toBe('src/a.ts');
    expect(normalizePath('/abs/./a.ts')).toBe('/abs/a.ts');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/rules.test.ts`
Expected: FAIL. `applyRules` is not exported.

- [ ] **Step 3: Implement `src/rules.ts`**

```ts
import { posix } from 'node:path';
import type { ToolCall, Verdict } from './types.js';

const READ_TOOLS = new Set(['Read']);
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'LS']);

/** JSON with object keys sorted at every depth, so equal inputs compare equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function normalizePath(p: string): string {
  const normalized = posix.normalize(p);
  return normalized.startsWith('./') ? normalized.slice(2) : normalized;
}

function pathOf(input: Record<string, unknown>): string | undefined {
  const p = input['file_path'] ?? input['notebook_path'];
  return typeof p === 'string' && p.length > 0 ? normalizePath(p) : undefined;
}

/**
 * Deterministic staleness verdicts. Scans newest to oldest, remembering what
 * later calls did, so each call is judged against everything after it. Pinned
 * calls count as evidence but are never targets.
 */
export function applyRules(calls: readonly ToolCall[]): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  const pathsTouchedLater = new Set<string>();
  const searchesLater = new Set<string>();
  const successesLater = new Set<string>();

  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]!;
    const key = `${call.tool}:${canonicalJson(call.input)}`;
    const path = pathOf(call.input);

    if (!call.pinned) {
      if (call.isError && successesLater.has(key)) {
        verdicts.set(call.id, { action: 'drop_call', source: 'rule', rule: 'failed_then_fixed' });
      } else if (SEARCH_TOOLS.has(call.tool) && searchesLater.has(key)) {
        verdicts.set(call.id, { action: 'drop_call', source: 'rule', rule: 'repeated_search' });
      } else if (READ_TOOLS.has(call.tool) && path && pathsTouchedLater.has(path)) {
        verdicts.set(call.id, { action: 'drop_result', source: 'rule', rule: 'stale_read' });
      }
    }

    if (!call.isError) successesLater.add(key);
    if (SEARCH_TOOLS.has(call.tool)) searchesLater.add(key);
    if (path && (READ_TOOLS.has(call.tool) || WRITE_TOOLS.has(call.tool))) pathsTouchedLater.add(path);
  }
  return verdicts;
}
```

Add `export * from './rules.js';` to `src/index.ts`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/rules.test.ts && npx tsc --noEmit`
Expected: 7 tests PASS, and tsc is clean.

- [ ] **Step 5: Commit**

```bash
git add src/rules.ts src/index.ts tests/rules.test.ts
git commit -m "feat: add deterministic staleness rules

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Stage 2 Claude scorer

**Files:**
- Create: `src/claude-scorer.ts`
- Test: `tests/claude-scorer.test.ts`
- Modify: `src/index.ts` (add `export * from './claude-scorer.js';`)

**Interfaces:**
- Consumes: `ToolCall`, `Verdict`, `ClaudeStatus` from Task 1.
- Produces:
  - `type ForkFn = (request: { prompt: string }) => Promise<{ text: string } | null>`
  - `candidateLine(call: ToolCall): string`
  - `selectCandidates(calls: readonly ToolCall[], max: number): ToolCall[]`
  - `buildPrompt(calls: readonly ToolCall[]): string`
  - `parseReply(text: string, ids: ReadonlySet<string>): Map<string, Verdict> | undefined`
  - `scoreWithClaude(fork: ForkFn, calls: readonly ToolCall[], maxCandidates: number): Promise<{ verdicts: Map<string, Verdict>; status: ClaudeStatus }>`

- [ ] **Step 1: Write the failing test** `tests/claude-scorer.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import {
  buildPrompt, candidateLine, parseReply, scoreWithClaude, selectCandidates,
  type ForkFn, type ToolCall,
} from '../src/index.js';

function c(id: string, tool: string, input: Record<string, unknown>, resultChars = 100, isError = false): ToolCall {
  return { id, tool_use_id: `u-${id}`, tool, input, callIndex: 1, resultIndex: 2, resultChars, isError, pinned: false };
}

const calls = [
  c('t1', 'Read', { file_path: 'src/a.ts' }, 4213),
  c('t2', 'Bash', { command: 'x'.repeat(500) }, 20, true),
];

describe('candidate list', () => {
  it('formats one line per call with a truncated input', () => {
    expect(candidateLine(calls[0]!)).toBe('t1 Read {"file_path":"src/a.ts"} → ok 4213ch');
    const line = candidateLine(calls[1]!);
    expect(line.startsWith('t2 Bash {"command":"xxx')).toBe(true);
    expect(line.endsWith('… → error 20ch')).toBe(true);
    expect(line.length).toBeLessThan(160);
  });

  it('caps by largest results and keeps transcript order', () => {
    const many = [c('t1', 'A', {}, 5), c('t2', 'B', {}, 50), c('t3', 'C', {}, 500)];
    expect(selectCandidates(many, 2).map((x) => x.id)).toEqual(['t2', 't3']);
    expect(selectCandidates(many, 5)).toHaveLength(3);
  });

  it('builds a prompt that lists candidates and asks for JSON only', () => {
    const prompt = buildPrompt(calls);
    expect(prompt).toContain('t1 Read');
    expect(prompt).toContain('{"drop":[],"truncate":[]}');
  });
});

describe('parseReply', () => {
  const ids = new Set(['t1', 't2', 't3']);
  it('reads drop and truncate arrays', () => {
    const v = parseReply('{"drop":["t1"],"truncate":["t2"]}', ids);
    expect(v?.get('t1')).toEqual({ action: 'drop_call', source: 'claude' });
    expect(v?.get('t2')).toEqual({ action: 'drop_result', source: 'claude' });
  });
  it('tolerates prose around the JSON', () => {
    expect(parseReply('Here you go:\n{"drop":["t1"],"truncate":[]}\nThanks', ids)?.size).toBe(1);
  });
  it('ignores unknown ids and resolves conflicts to truncate', () => {
    const v = parseReply('{"drop":["t1","t9"],"truncate":["t1"]}', ids);
    expect(v?.size).toBe(1);
    expect(v?.get('t1')?.action).toBe('drop_result');
  });
  it('rejects malformed replies', () => {
    expect(parseReply('no json here', ids)).toBeUndefined();
    expect(parseReply('{"drop":"t1","truncate":[]}', ids)).toBeUndefined();
    expect(parseReply('{"drop":[1],"truncate":[]}', ids)).toBeUndefined();
  });
});

describe('scoreWithClaude', () => {
  it('returns verdicts when the fork answers', async () => {
    const fork: ForkFn = async () => ({ text: '{"drop":["t2"],"truncate":["t1"]}' });
    const out = await scoreWithClaude(fork, calls, 400);
    expect(out.status).toBe('ran');
    expect(out.verdicts.size).toBe(2);
  });
  it('reports null, unparseable and error without throwing', async () => {
    expect((await scoreWithClaude(async () => null, calls, 400)).status).toBe('null');
    expect((await scoreWithClaude(async () => ({ text: 'nope' }), calls, 400)).status).toBe('unparseable');
    const boom: ForkFn = async () => { throw new Error('api down'); };
    const out = await scoreWithClaude(boom, calls, 400);
    expect(out.status).toBe('error');
    expect(out.verdicts.size).toBe(0);
  });
  it('skips the fork when there is nothing to score', async () => {
    let called = false;
    const out = await scoreWithClaude(async () => { called = true; return null; }, [], 400);
    expect(called).toBe(false);
    expect(out.status).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/claude-scorer.test.ts`
Expected: FAIL. The module is missing.

- [ ] **Step 3: Implement `src/claude-scorer.ts`**

```ts
import type { ClaudeStatus, ToolCall, Verdict } from './types.js';

/** The shape of `$.model.fork`: one prompt appended to the session's own transcript. */
export type ForkFn = (request: { prompt: string }) => Promise<{ text: string } | null>;

const INPUT_CHARS = 120;

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function candidateLine(call: ToolCall): string {
  let input: string;
  try {
    input = JSON.stringify(call.input);
  } catch {
    input = '[unserializable input]';
  }
  return `${call.id} ${call.tool} ${clip(input, INPUT_CHARS)} → ${call.isError ? 'error' : 'ok'} ${call.resultChars}ch`;
}

/** At most `max` calls, preferring the largest results, returned in transcript order. */
export function selectCandidates(calls: readonly ToolCall[], max: number): ToolCall[] {
  if (calls.length <= max) return [...calls];
  const chosen = new Set(
    [...calls].sort((a, b) => b.resultChars - a.resultChars).slice(0, Math.max(0, max)).map((x) => x.id),
  );
  return calls.filter((x) => chosen.has(x.id));
}

export function buildPrompt(calls: readonly ToolCall[]): string {
  return [
    'Context maintenance request. Do not continue the task and do not call tools.',
    'Below are earlier tool calls from this conversation, one per line: id, tool, input, outcome, output size.',
    'Decide which are no longer needed to continue the current work.',
    '- "drop": neither the call nor its output matters any more (superseded, irrelevant, or a dead end).',
    '- "truncate": it matters that the call happened, but its full output is no longer needed.',
    'Anything you do not list is kept verbatim. When unsure, leave it out.',
    'Reply with JSON only, exactly this shape: {"drop":[],"truncate":[]}',
    '',
    ...calls.map(candidateLine),
  ].join('\n');
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

/**
 * Parses the reply's JSON object (from the first `{` to the last `}`).
 * Unknown ids are ignored; an id in both lists becomes `truncate`.
 * Returns undefined when there is no valid object of the expected shape.
 */
export function parseReply(text: string, ids: ReadonlySet<string>): Map<string, Verdict> | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const drop = stringArray((parsed as Record<string, unknown>)['drop']);
  const truncate = stringArray((parsed as Record<string, unknown>)['truncate']);
  if (!drop || !truncate) return undefined;
  const verdicts = new Map<string, Verdict>();
  for (const id of drop) if (ids.has(id)) verdicts.set(id, { action: 'drop_call', source: 'claude' });
  for (const id of truncate) if (ids.has(id)) verdicts.set(id, { action: 'drop_result', source: 'claude' });
  return verdicts;
}

export async function scoreWithClaude(
  fork: ForkFn,
  calls: readonly ToolCall[],
  maxCandidates: number,
): Promise<{ verdicts: Map<string, Verdict>; status: ClaudeStatus }> {
  const candidates = selectCandidates(calls, maxCandidates);
  if (candidates.length === 0) return { verdicts: new Map(), status: 'skipped' };
  let reply: { text: string } | null;
  try {
    reply = await fork({ prompt: buildPrompt(candidates) });
  } catch {
    return { verdicts: new Map(), status: 'error' };
  }
  if (reply === null) return { verdicts: new Map(), status: 'null' };
  const verdicts = parseReply(reply.text, new Set(candidates.map((x) => x.id)));
  return verdicts ? { verdicts, status: 'ran' } : { verdicts: new Map(), status: 'unparseable' };
}
```

Add `export * from './claude-scorer.js';` to `src/index.ts`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/claude-scorer.test.ts && npx tsc --noEmit`
Expected: all tests PASS, and tsc is clean.

- [ ] **Step 5: Commit**

```bash
git add src/claude-scorer.ts src/index.ts tests/claude-scorer.test.ts
git commit -m "feat: score remaining calls with one tool-less session fork

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Merge the stages into a Scorer

**Files:**
- Create: `src/score.ts`
- Test: `tests/score.test.ts`
- Modify: `src/index.ts` (add `export * from './score.js';`)

**Interfaces:**
- Consumes: `applyRules` (Task 2), `scoreWithClaude`, `ForkFn` (Task 3), `Scorer` (Task 1).
- Produces: `makeScorer(options: { fork?: ForkFn; useClaudeScorer: boolean; maxCandidates: number }): Scorer`

- [ ] **Step 1: Write the failing test** `tests/score.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { makeScorer, type ForkFn, type ToolCall } from '../src/index.js';

function c(id: string, tool: string, input: Record<string, unknown>, pinned = false): ToolCall {
  return { id, tool_use_id: `u-${id}`, tool, input, callIndex: 1, resultIndex: 2, resultChars: 100, isError: false, pinned };
}

const calls = [
  c('t1', 'Read', { file_path: 'src/a.ts' }),
  c('t2', 'Bash', { command: 'ls' }),
  c('t3', 'Edit', { file_path: 'src/a.ts' }),
  c('t4', 'Bash', { command: 'pwd' }, true),
];

describe('makeScorer', () => {
  it('sends only unpinned calls the rules left undecided to Claude, and rules win', async () => {
    let prompt = '';
    const fork: ForkFn = async (req) => {
      prompt = req.prompt;
      return { text: '{"drop":["t1","t2"],"truncate":[]}' };
    };
    const out = await makeScorer({ fork, useClaudeScorer: true, maxCandidates: 400 })(calls);
    expect(prompt).toContain('t2 Bash');
    expect(prompt).not.toMatch(/^t1 /m);
    expect(prompt).not.toMatch(/^t4 /m);
    expect(out.verdicts.get('t1')).toMatchObject({ source: 'rule', rule: 'stale_read' });
    expect(out.verdicts.get('t2')).toMatchObject({ source: 'claude', action: 'drop_call' });
    expect(out.claude).toBe('ran');
  });

  it('is rules-only when disabled or when no fork is available', async () => {
    let called = false;
    const fork: ForkFn = async () => { called = true; return null; };
    const off = await makeScorer({ fork, useClaudeScorer: false, maxCandidates: 400 })(calls);
    const none = await makeScorer({ useClaudeScorer: true, maxCandidates: 400 })(calls);
    expect(called).toBe(false);
    expect(off.claude).toBe('skipped');
    expect(none.claude).toBe('skipped');
    expect(off.verdicts.size).toBe(1);
  });

  it('keeps rule verdicts when the Claude stage fails', async () => {
    const out = await makeScorer({ fork: async () => null, useClaudeScorer: true, maxCandidates: 400 })(calls);
    expect(out.claude).toBe('null');
    expect(out.verdicts.get('t1')?.rule).toBe('stale_read');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/score.test.ts`
Expected: FAIL. `makeScorer` is not exported.

- [ ] **Step 3: Implement `src/score.ts`**

```ts
import { scoreWithClaude, type ForkFn } from './claude-scorer.js';
import { applyRules } from './rules.js';
import type { Scorer } from './types.js';

export interface ScorerOptions {
  fork?: ForkFn;
  useClaudeScorer: boolean;
  maxCandidates: number;
}

/** Rules first; the calls they leave undecided go to one Claude fork. Rule verdicts always win. */
export function makeScorer(options: ScorerOptions): Scorer {
  return async (calls) => {
    const verdicts = applyRules(calls);
    const undecided = calls.filter((call) => !call.pinned && !verdicts.has(call.id));
    if (!options.useClaudeScorer || !options.fork || undecided.length === 0) {
      return { verdicts, claude: 'skipped' };
    }
    const claude = await scoreWithClaude(options.fork, undecided, options.maxCandidates);
    for (const [id, verdict] of claude.verdicts) if (!verdicts.has(id)) verdicts.set(id, verdict);
    return { verdicts, claude: claude.status };
  };
}
```

Add `export * from './score.js';` to `src/index.ts`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/score.test.ts tests/compact.test.ts tests/rules.test.ts tests/claude-scorer.test.ts && npx tsc --noEmit`
Expected: all PASS, and tsc is clean.

- [ ] **Step 5: Commit**

```bash
git add src/score.ts src/index.ts tests/score.test.ts
git commit -m "feat: combine rules and Claude into one scorer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Engine hook, config and plugin rename

**Files:**
- Create: `hooks/verbatim.ts`
- Delete: `hooks/fast-jev.ts`
- Modify: `hooks/hooks.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `package.json`
- Rewrite: `tests/hook.test.ts`

**Interfaces:**
- Consumes: `compact`, `reductionRatio`, `makeScorer`, `ForkFn`, `CompactResult`, `Message`, `ToolUse`, `ToolResult`.
- Produces: `resolveHookConfig(options: PluginOptions): HookConfig`, `toSessionMessages(input, output)`,
  `compactSession(messages, config, fork?: ForkFn)`, `summarize(result)`, `register`.

- [ ] **Step 1: Write the failing test** `tests/hook.test.ts` (replaces the whole file)

```ts
import { describe, expect, it } from 'vitest';
import { compactSession, resolveHookConfig, summarize, toSessionMessages } from '../hooks/verbatim.ts';
import type { Message } from '../src/index.js';

type SessionMessage = Message & { handle?: string };
const big = 'y'.repeat(3000);
function m(role: Message['role'], text: string, extra: Partial<SessionMessage> = {}): SessionMessage {
  return { role, text, toolUses: [], ...extra };
}
function transcript(): SessionMessage[] {
  return [
    m('user', 'Refactor the parser.', { handle: 'h0' }),
    m('assistant', '', { toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'src/p.ts' } }], handle: 'h1' }),
    m('user', '', { toolResults: [{ tool_use_id: 'u1', text: big }], handle: 'h2' }),
    m('assistant', '', { toolUses: [{ tool_use_id: 'u2', tool: 'Edit', input: { file_path: 'src/p.ts' } }], handle: 'h3' }),
    m('user', '', { toolResults: [{ tool_use_id: 'u2', text: 'ok' }], handle: 'h4' }),
    m('assistant', '', { toolUses: [{ tool_use_id: 'u3', tool: 'Bash', input: { command: 'npm test' } }], handle: 'h5' }),
    m('user', '', { toolResults: [{ tool_use_id: 'u3', text: big }], handle: 'h6' }),
    ...Array.from({ length: 6 }, (_, i) => m(i % 2 ? 'user' : 'assistant', `turn ${i}`, { handle: `r${i}` })),
  ];
}

describe('resolveHookConfig', () => {
  it('reads userConfig and falls back to defaults', () => {
    expect(resolveHookConfig({})).toEqual({
      compactAtPercent: 60, minReductionRatio: 0.25, preserveRecentMessages: 6,
      truncateHeadChars: 300, maxCandidates: 400, useClaudeScorer: true,
    });
    expect(resolveHookConfig({ useClaudeScorer: false, maxCandidates: 50 })).toMatchObject({
      useClaudeScorer: false, maxCandidates: 50,
    });
  });
});

describe('compactSession', () => {
  it('prunes by rules and Claude and keeps untouched engine objects', async () => {
    const input = transcript();
    const { result, messages } = await compactSession(input, resolveHookConfig({}), async () => ({
      text: '{"drop":["t3"],"truncate":[]}',
    }));
    expect(result.stats).toMatchObject({ byRule: 1, byClaude: 1, claude: 'ran' });
    expect(messages[0]).toBe(input[0]);
    expect(messages.some((x) => x.toolUses.some((t) => t.tool_use_id === 'u3'))).toBe(false);
    expect(summarize(result)).toMatch(/rules 1, claude 1/);
  });

  it('is rules-only without a fork', async () => {
    const { result } = await compactSession(transcript(), resolveHookConfig({}));
    expect(result.stats.claude).toBe('skipped');
    expect(result.stats.byRule).toBe(1);
  });

  it('toSessionMessages returns originals when nothing changed', () => {
    const input = transcript();
    expect(toSessionMessages(input, input).every((x, i) => x === input[i])).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/hook.test.ts`
Expected: FAIL. `hooks/verbatim.ts` does not exist.

- [ ] **Step 3: Create `hooks/verbatim.ts`**

```ts
import type {
  On, PluginOptions, Register, SessionMessage, ToolResultSummary, ToolUseSummary, TurnCompleteInput,
} from 'claude-code';

import { compact, reductionRatio } from '../src/compact.js';
import { makeScorer } from '../src/score.js';
import type { ForkFn } from '../src/claude-scorer.js';
import type { CompactResult, Message, ToolResult, ToolUse } from '../src/types.js';

export type HookConfig = {
  compactAtPercent: number;
  minReductionRatio: number;
  preserveRecentMessages: number;
  truncateHeadChars: number;
  maxCandidates: number;
  useClaudeScorer: boolean;
};

const DEFAULTS: HookConfig = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  preserveRecentMessages: 6,
  truncateHeadChars: 300,
  maxCandidates: 400,
  useClaudeScorer: true,
};

function num(options: PluginOptions, key: keyof HookConfig, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveHookConfig(options: PluginOptions): HookConfig {
  const flag = options['useClaudeScorer'];
  return {
    compactAtPercent: num(options, 'compactAtPercent', DEFAULTS.compactAtPercent),
    minReductionRatio: num(options, 'minReductionRatio', DEFAULTS.minReductionRatio),
    preserveRecentMessages: num(options, 'preserveRecentMessages', DEFAULTS.preserveRecentMessages),
    truncateHeadChars: num(options, 'truncateHeadChars', DEFAULTS.truncateHeadChars),
    maxCandidates: num(options, 'maxCandidates', DEFAULTS.maxCandidates),
    useClaudeScorer: typeof flag === 'boolean' ? flag : DEFAULTS.useClaudeScorer,
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = { tool_use_id: tool.tool_use_id, tool: tool.tool, input: tool.input };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return { tool_use_id: result.tool_use_id, text: result.text, isError: result.isError ?? false };
}

/** Unchanged objects stay the engine's own (handles included); rebuilt ones are fresh. */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map((r) => results.get(r) ?? toolResultSummary(r));
    }
    return rebuilt;
  });
}

export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fork?: ForkFn,
): Promise<{ result: CompactResult; messages: SessionMessage[] }> {
  const scorer = makeScorer({ fork, useClaudeScorer: config.useClaudeScorer, maxCandidates: config.maxCandidates });
  const result = await compact(messages, scorer, config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

export function summarize(result: CompactResult): string {
  const s = result.stats;
  return `${Math.round(reductionRatio(result) * 100)}% reduction; rules ${s.byRule}, claude ${s.byClaude} (${s.claude}), ` +
    `kept ${s.kept}, pinned ${s.pinned}; ${s.resultsDropped} truncated, ${s.callsDropped} dropped`;
}

function notify($: { ui: { log: (t: string) => void; toast: (t: string, o?: { timeoutMs?: number }) => void } }, text: string): void {
  $.ui.log(`verbatim-compaction: ${text}`);
  $.ui.toast(`verbatim-compaction: ${text}`, { timeoutMs: 15_000 });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const config = resolveHookConfig(options);
  let compacting = false;

  on('session.compact', async ($, event, next) => {
    try {
      const fork: ForkFn = (request) => $.model.fork(request);
      const { result, messages } = await compactSession(event.messages, config, fork);
      if (reductionRatio(result) < config.minReductionRatio) {
        notify($, `fallback to built-in summary (below ${Math.round(config.minReductionRatio * 100)}%: ${summarize(result)})`);
        return next(event);
      }
      notify($, `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)})`);
      return { messages };
    } catch (error) {
      notify($, `fallback to built-in summary (${error instanceof Error ? error.message : String(error)})`);
      return next(event);
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (compacting) return next(event);
    try {
      const { context } = await $.session.usage();
      if ((context.percent ?? 0) < config.compactAtPercent) return next(event);
      compacting = true;
      await $.session.compact();
    } catch (error) {
      $.ui.log(`verbatim-compaction: auto-compact skipped (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      compacting = false;
    }
    return next(event);
  });
};
```

- [ ] **Step 4: Point the plugin at the new hook and rename it**

`hooks/hooks.json`:
```json
{
  "modules": ["./verbatim.ts"]
}
```

In `.claude-plugin/plugin.json`:
- Set `"name": "verbatim-compaction"` and `"version": "0.4.0"`.
- Set the `"description"` to `"Verbatim compaction for Claude Code: stale tool output pruned by local rules and one session fork; no summary, no third-party API."`
- Replace `"userConfig"` with the following.

```json
"userConfig": {
  "compactAtPercent": { "type": "number", "title": "Compaction percentage", "description": "Context percentage at which turn.complete requests compaction.", "default": 60 },
  "minReductionRatio": { "type": "number", "title": "Minimum reduction ratio", "description": "Minimum estimated character reduction required to replace history; below it the built-in summary runs.", "default": 0.25 },
  "preserveRecentMessages": { "type": "number", "title": "Recent messages to preserve", "description": "Number of newest messages never touched.", "default": 6 },
  "truncateHeadChars": { "type": "number", "title": "Truncated tool result head", "description": "Characters kept from a truncated tool result.", "default": 300 },
  "maxCandidates": { "type": "number", "title": "Maximum Claude candidates", "description": "Most tool calls listed for the Claude fork, largest outputs first.", "default": 400 },
  "useClaudeScorer": { "type": "boolean", "title": "Use Claude scorer", "description": "Ask one tool-less fork of the session about calls the rules leave undecided. Off: rules only, no model call.", "default": true }
}
```

In `.claude-plugin/marketplace.json`, set both `"name"` fields to `"verbatim-compaction"`, `"version"` to
`"0.4.0"`, and `"description"` to the same text as in `plugin.json`. Leave `owner` as the upstream
author, since it credits them.

In `package.json`, set `"name": "verbatim-compaction"` and `"version": "0.4.0"`, and set `"description"`
to `"Verbatim context compaction for Claude Code, scored by local rules and a session fork."`

Run: `git rm -q hooks/fast-jev.ts`

- [ ] **Step 5: Run the tests and both typechecks**

Run: `npx vitest run && npm run typecheck && npm run validate:plugin`
Expected: every suite PASSes, both tsc passes are clean, and `claude plugin validate` reports the manifest
as valid.

- [ ] **Step 6: Commit**

```bash
git add -A hooks .claude-plugin package.json tests/hook.test.ts
git commit -m "feat: wire rules plus session fork into session.compact; rename plugin

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Invariant tests, docs, and live check

**Files:**
- Create: `tests/invariants.test.ts`
- Rewrite: `README.md`, `hooks/README.md`
- Delete: `demo/`

**Interfaces:**
- Consumes: `compact`, `makeScorer`, `collectToolCalls`, `Scorer` (all earlier tasks).

- [ ] **Step 1: Write the invariant test** `tests/invariants.test.ts`

```ts
import { describe, expect, it } from 'vitest';
import { compact, type Message, type Scorer } from '../src/index.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOOLS = ['Read', 'Edit', 'Grep', 'Bash'];

function randomTranscript(r: () => number): Message[] {
  const out: Message[] = [{ role: 'user', text: 'start', toolUses: [] }];
  const count = 5 + Math.floor(r() * 40);
  for (let i = 0; i < count; i += 1) {
    const id = `u${i}`;
    const tool = TOOLS[Math.floor(r() * TOOLS.length)]!;
    out.push({ role: 'assistant', text: r() < 0.3 ? `thinking ${i}` : '', toolUses: [{ tool_use_id: id, tool, input: { file_path: `src/f${Math.floor(r() * 4)}.ts` } }] });
    out.push({ role: 'user', text: '', toolResults: [{ tool_use_id: id, text: 'z'.repeat(Math.floor(r() * 2000)), isError: r() < 0.1 }] });
  }
  out.push({ role: 'user', text: 'end', toolUses: [] });
  return out;
}

const randomScorer = (r: () => number): Scorer => async (calls) => ({
  claude: 'ran',
  verdicts: new Map(
    calls.filter(() => r() < 0.6).map((c) => [c.id, { action: r() < 0.5 ? 'drop_call' : 'drop_result', source: 'claude' }] as const),
  ),
});

describe('invariants over random transcripts', () => {
  it('never orphans a result, never edits text, never touches pinned messages', async () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const r = rng(seed);
      const input = randomTranscript(r);
      const out = await compact(input, randomScorer(r), { preserveRecentMessages: 4 });

      const useIds = new Set(out.messages.flatMap((m) => m.toolUses.map((t) => t.tool_use_id)));
      for (const m of out.messages) for (const res of m.toolResults ?? []) expect(useIds.has(res.tool_use_id)).toBe(true);

      const inText = input.map((m) => m.text).filter((t) => t.trim().length > 0);
      const outText = out.messages.map((m) => m.text).filter((t) => t.trim().length > 0);
      expect(outText).toEqual(inText);

      expect(out.messages[0]).toBe(input[0]);
      const tail = input.slice(-4);
      expect(out.messages.slice(-4)).toEqual(tail);
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/invariants.test.ts`
Expected: PASS. If it fails, the bug is in `applyDecisions` or the pinning logic, not in the test. Fix
the code, then re-run the whole suite.

- [ ] **Step 3: Rewrite `README.md`**

Replace the whole file with this text:

````markdown
# verbatim-compaction

A Claude Code plugin that replaces the compaction summary with **pruning**. Stale tool calls and outputs
are dropped or truncated; everything else, including every user and assistant message, stays verbatim.

Forked from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT).
Upstream scores with TypeSafe's Jev API. This fork sends nothing to any third party:

1. **Rules** (local, free): a read of a file that is later edited or re-read is truncated; an identical
   search repeated later is dropped; a failed call later retried successfully is dropped.
2. **Claude** (optional): one tool-less `$.model.fork` of your own session is shown the remaining
   candidates and returns `{"drop":[…],"truncate":[…]}`. It reuses the session's prompt cache and model.
   A cold cache or error falls back to the rules alone.

If the result saves less than `minReductionRatio`, Claude Code's built-in summary runs instead.

## Install

Function hooks are early access (Claude Code 2.1.274+). Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the
`env` block of your Claude Code settings, then:

```sh
claude plugin marketplace add <your clone or fork of this repo>
claude plugin install verbatim-compaction@verbatim-compaction
```

## Options

| Option | Default | |
| --- | --- | --- |
| `compactAtPercent` | 60 | Context % at which compaction is requested |
| `minReductionRatio` | 0.25 | Below this, fall back to the built-in summary |
| `preserveRecentMessages` | 6 | Newest messages never touched (the first is always kept) |
| `truncateHeadChars` | 300 | Characters kept from a truncated result |
| `maxCandidates` | 400 | Most calls listed for Claude, largest outputs first |
| `useClaudeScorer` | true | `false` = rules only, no model call |

## Cost

The fork reads your session's cached prefix at the model's cache-read rate plus a short JSON reply. On a
large session that is roughly tens of cents per compaction; `useClaudeScorer: false` makes it free.

## Development

```sh
npm install
npm test
npm run typecheck
npm run validate:plugin
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```
````

Replace `hooks/README.md` with:

```markdown
# verbatim-compaction hook

`hooks/verbatim.ts` is the Claude Code function-hook module. It handles `session.compact` (manual
`/compact` and auto-compaction) by running `src/` over the transcript with a scorer built from the
local rules and `$.model.fork`, and it requests compaction from `turn.complete` once
`$.session.usage()` reports `compactAtPercent` or more.

The engine API it uses (`session.compact`, `turn.complete`, `$.model.fork`, `$.session.usage`) is
declared in `types/claude-code.d.ts`, generated from Claude Code 2.1.274. Function hooks are early
access: regenerate and re-check that file after a Claude Code upgrade.
```

Run: `git rm -rq demo`

- [ ] **Step 4: Check for leftover Jev references and personal details**

Run: `git grep -niE "typesafe|jev|TYPESAFE_API_KEY" -- ':!LICENSE' ':!docs/superpowers' ':!types' ':!package-lock.json'`
Expected: the only matches are the upstream credit line and link in `README.md`.

Run: `npm install` (regenerates `package-lock.json` for the new package name), then `npx vitest run && npm run typecheck`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add -A README.md hooks/README.md tests/invariants.test.ts demo package-lock.json
git commit -m "test: randomized invariants; docs: describe the rules-plus-fork design

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: Live check (manual, needs the repo owner)**

Run from the repo root: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
Do some work that reads, edits and re-reads a file, then run `/compact`.
Expected: a toast saying `verbatim-compaction: kept N/M messages, no summary (… rules X, claude Y (ran) …)`
or `fallback to built-in summary (…)`. After it, check that the conversation's text is intact.

- [ ] **Step 7: Hand off. Do not push.**

Report the commit list (`git log --oneline origin/main..HEAD`) and wait for the owner to approve `git push -u origin claude-scorer`.
