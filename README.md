# verbatim-compaction

A Claude Code plugin that replaces the compaction summary with **pruning**. Stale tool calls and outputs
are dropped or truncated; everything else, including every user and assistant message, stays verbatim.

Forked from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT).
Upstream scores with TypeSafe's Jev API. This fork sends nothing to any third party:

1. **Rules** (local, free): a read of a file that is later successfully edited or read again in full is
   truncated (a later ranged read or a failed edit does not count); an identical search repeated later is
   dropped; a failed call later retried successfully is dropped. Then, for calls those leave undecided:
   - an MCP write's echo (`create…`, `edit…`, `update…`, `transition…`, `add…`, `comment…`, over 500
     chars) is truncated: the call records the write, the echo is the server repeating it;
   - a Bash command that only reads files (`cat`, `sed -n`, `head`, `tail`, `grep`, `nl`, `wc`…) is
     truncated once every file it read is later Read, edited, written or read again;
   - a read-only Bash command (`git status/log/diff/show/branch`, `gh api`, `gh pr view`, `gh run list`,
     `docker ps/logs`, `ls`…) is truncated once every step of it has been run again later;
   - agent-launch boilerplate ("Async agent launched successfully") is truncated;
   - a Read, or a Bash command that only reads, lists or searches files, is truncated once it is older
     than `staleAfterMessages` messages.

   Commands are parsed with quotes honoured; one with `$(…)`, backticks, a heredoc or a redirection to a
   file is never treated as read-only. Failed calls and `<persisted-output>` wrappers are never targets.

   **Shapes.** A truncated result keeps `truncateHeadChars` from its start, plus `truncateTailChars` from
   its end when it is a test/build/deploy/lint/install/push run or ends with a verdict line (`57 passed`,
   `exit code 1`…), so the verdict survives. MCP results over 500 chars that are kept lose their JSON
   furniture (`self` links, `avatarUrls`, `iconUrl`, `expand`, `featureFlags`, null `customfield_*`, the
   server's `context` envelope); every other value is kept exactly, and a payload JSON cannot round-trip
   exactly (integers past 2^53) is left alone.

   **Referenced-later pin.** A result that introduced a distinctive token (a sha, `#123`, `ABC-123`, a
   path, a URL, a dollar amount, a long number or identifier) which later assistant text or a later tool
   input quotes (edits excluded) is never dropped, whichever stage decided it: it is truncated only to a
   head or head+tail window that still holds the token's first occurrence, or kept verbatim. Only text
   that is never pruned (user and assistant text, pinned results) counts as already having the token;
   an edit's input does not, because the edit itself can be dropped.
2. **Claude** (optional): one tool-less `$.model.fork` of your own session is shown the remaining
   candidates and returns `{"drop":[…],"truncate":[…]}`. It reuses the session's prompt cache and model.
   A cold cache, an error, or a fork slower than `claudeTimeoutMs` falls back to the rules alone. A
   subagent's own compaction uses the rules only (the fork can only fork the main session). A
   `precompute` run is skipped outright; the real compaction that follows runs the full pipeline.

If the result saves less than `minReductionRatio` of the transcript's tool-result characters (the only
thing pruning can shrink; user text and attachments are out of its reach), Claude Code's built-in summary
runs instead. So does
`/compact <instructions>`: instructions ask for a focused summary, which pruning cannot give. A plain
`/compact` prunes.

**Headless (`claude -p`, the SDK):** the automatic trigger does not work there. Claude Code 2.1.281
refuses `$.session.compact()` outside an interactive session (compaction there runs only inside a turn,
as a `/compact` prompt). After the first refusal the plugin stops asking for the rest of the session and
says so once (a toast and a log line). Send `/compact` yourself, or rely on Claude Code's own
auto-compaction, which this plugin's `session.compact` hook still handles.

### What changes in a pruned message

Untouched and pinned messages (the first and the newest `preserveRecentMessages`) are handed back
exactly as Claude Code had them. A message that loses a tool call, and the user message whose tool
result is truncated, is rebuilt from its role, its text and its tool blocks only: images and documents,
thinking blocks and the original order of its blocks are not preserved in that message. Truncation
never rebuilds the assistant message that made the call.

A call whose assistant message has no text of its own is truncated to its note instead of dropped.
Claude Code hands each content block over as its own message, so a thinking block sits beside the call;
dropping the call would leave a message holding only thinking.

## Install

Function hooks are early access (Claude Code 2.1.274+). Set `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in the
`env` block of your Claude Code settings, then:

```sh
claude plugin marketplace add <your clone or fork of this repo>
claude plugin install verbatim-compaction@verbatim-compaction
```

## Options

Set options in your user settings (`~/.claude/settings.json`), a `--settings` file or managed
settings, under the plugin's full id. Project settings are not read for plugin options.

```json
{
  "pluginConfigs": {
    "verbatim-compaction@verbatim-compaction": {
      "options": { "compactAtPercent": 70, "claudeTimeoutMs": 30000 }
    }
  }
}
```

A plugin loaded with `--plugin-dir` reads `verbatim-compaction@inline` instead (Claude Code 2.1.281's
debug log names the keys it looked for).

| Option | Default | |
| --- | --- | --- |
| `compactAtPercent` | 60 | Context % at which compaction is requested |
| `minReductionRatio` | 0.25 | Characters saved over tool-result characters; below this, fall back to the built-in summary |
| `preserveRecentMessages` | 6 | Newest messages never touched (the first is always kept). Counted as Claude Code hands them over: one per content block, so a turn with a thinking block, some text and two tool calls, and the results of those calls, is several messages, not one |
| `truncateHeadChars` | 300 | Characters kept from a truncated result |
| `truncateTailChars` | 1000 | Characters also kept from the end of a log-like result, or to hold a pinned token |
| `staleAfterMessages` | 60 | Read and Bash file-read results older than this many messages are truncated |
| `pinReferenced` | true | Never drop a result whose introduced tokens are quoted later |
| `stripMcpFurniture` | true | Strip JSON furniture from kept MCP results |
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
