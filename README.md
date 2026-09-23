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
