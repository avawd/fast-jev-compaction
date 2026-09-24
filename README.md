# verbatim-compaction

A Claude Code plugin that replaces the compaction summary with **pruning**. Stale tool calls and outputs
are dropped or truncated; everything else, including every user and assistant message, stays verbatim.

Forked from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT).
Upstream scores with TypeSafe's Jev API. This fork sends nothing to any third party:

1. **Rules** (local, free): a read of a file that is later successfully edited or read again in full is
   truncated (a later ranged read or a failed edit does not count); an identical search repeated later is
   dropped; a failed call later retried successfully is dropped.
2. **Claude** (optional): one tool-less `$.model.fork` of your own session is shown the remaining
   candidates and returns `{"drop":[…],"truncate":[…]}`. It reuses the session's prompt cache and model.
   A cold cache, an error, or a fork slower than `claudeTimeoutMs` falls back to the rules alone. A
   subagent's own compaction uses the rules only (the fork can only fork the main session). A
   `precompute` run is skipped outright; the real compaction that follows runs the full pipeline.

If the result saves less than `minReductionRatio`, Claude Code's built-in summary runs instead. So does
`/compact <instructions>`: instructions ask for a focused summary, which pruning cannot give. A plain
`/compact` prunes.

### What changes in a pruned message

Untouched and pinned messages (the first and the newest `preserveRecentMessages`) are handed back
exactly as Claude Code had them. A message that loses a tool call, and the user message whose tool
result is truncated, is rebuilt from its role, its text and its tool blocks only (truncation never
rebuilds the assistant message that made the call): images and documents, thinking blocks and the original order of its
blocks are not preserved in that message.

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
| `claudeTimeoutMs` | 20000 | Longest wait for the fork; past it the rules alone decide. Clamped to 500–45000 ms. The hook's ten-second budget counts only the hook's own time, and a pending fork stops that clock even while the timeout's `$.clock.sleep` runs beside it (measured on 2.1.281: a hook that raced a fork against a 30 s sleep ran 30 s and was not cut) |

## Cost

The fork reads your session's cached prefix at the model's cache-read rate plus a short JSON reply:
roughly $0.05–0.15 per compaction on a large session (estimate; depends on context size and model).
A fork that outlasts `claudeTimeoutMs` cannot be cancelled: the hook stops waiting on it and rules
alone decide, but the fork itself keeps running server-side and is still billed.
`useClaudeScorer: false` is free.

## Development

```sh
npm install
npm test
npm run typecheck
npm run validate:plugin
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .
```
