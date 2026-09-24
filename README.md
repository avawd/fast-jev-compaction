# verbatim-compaction

A Claude Code plugin that replaces the compaction summary with **pruning**. Stale tool calls and outputs
are dropped or truncated; everything else, including every user and assistant message, stays verbatim.

Forked from [tamaratran/fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT).
Upstream scores with TypeSafe's Jev API. This fork sends nothing to any third party:

1. **Rules** (local, free): a read of a file that is later successfully edited or read again in full is
   truncated (a later ranged read or a failed edit does not count); an identical search repeated later is
   dropped; a failed call later retried successfully is dropped.
2. **Claude** (optional): tool-less `$.model.fork`s of your own session are asked Jev's two questions
   about each remaining call: must its **result** stay verbatim, and does the **call** itself still
   matter? The answer is three id lists, `{"result_needed":[…],"call_matters":[…],"unsure":[…]}`:
   result needed keeps the call whole, call matters truncates its output, `unsure` follows
   `keepThreshold`, and a call in no list is removed. Candidates are split into chunks of
   `forkChunkSize` (60), one fork per chunk, all concurrent; each reuses the session's prompt cache,
   so three forks take about as long as one (measured: 3 × ~5 s forks in ~5 s wall). A chunk whose
   fork fails or whose reply does not parse decides nothing, and its calls are kept.
   The forks race the short `claudeTimeoutMs` only when the rules alone already clear
   `minReductionRatio`; otherwise they are the only way to clear it, so they may take up to 45 s.
   A subagent's own compaction uses the rules only (the fork can only fork the main session).
   A `precompute` run (see below) runs the full pipeline in the background.

   Why lists and not Jev's per-call probabilities: on Claude Code 2.1.281 the API rejected every
   fork asked to answer one line per call (digit scores such as `t12 93`, and letters such as
   `t12 K`), with `invalid_request` and no output, once there were 10 or more candidates. The same
   candidates passed at 10, 30 and 60 when the reply was JSON lists. So `keepThreshold` is not a
   probability cut here. It only decides what `unsure` becomes.

If the result saves less than `minReductionRatio`, Claude Code's built-in summary runs instead. So does
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
| `minReductionRatio` | 0.25 | Below this, fall back to the built-in summary |
| `preserveRecentMessages` | 6 | Newest messages never touched (the first is always kept). Counted as Claude Code hands them over: one per content block, so a turn with a thinking block, some text and two tool calls, and the results of those calls, is several messages, not one |
| `truncateHeadChars` | 300 | Characters kept from a truncated result |
| `maxCandidates` | 400 | Most calls listed for Claude, largest outputs first |
| `useClaudeScorer` | true | `false` = rules only, no model call |
| `claudeTimeoutMs` | 20000 | Longest wait for the fork; past it the rules alone decide. Clamped to 500–45000 ms. The hook's ten-second budget counts only the hook's own time, and a pending fork stops that clock even while the timeout's `$.clock.sleep` runs beside it (measured on 2.1.281: a hook that raced a fork against a 30 s sleep ran 30 s and was not cut) |
| `keepThreshold` | 0.5 | What the fork's `unsure` calls become: below 0.5 kept whole, 0.5–0.75 output truncated, above 0.75 removed |
| `forkChunkSize` | 60 | Most calls per fork; more run as concurrent forks. 1–400 |

### Precompute

When Claude Code precomputes a compaction in the background (`trigger: 'precompute'`), the hook runs
the full pipeline there and returns the pruned transcript, which Claude Code keeps for the compaction
that comes (or hands to the built-in summary below `minReductionRatio`). The forks then always get the
45 s ceiling, and nothing is toasted. Claude Code 2.1.281 arms a precompute only when **all** of these hold (read
from its source): you are signed in with claude.ai (OAuth) against the first-party API; the
server-side flag `tengu_sepia_moth` is on for the account; the setting `precomputeCompactionEnabled` is
`true` (its default is `false`); auto-compact is on; and the context is within the precompute buffer
(20% by default) below the auto-compact threshold. In `-p`/SDK sessions it is also held back while the
session has had only one user prompt. This path is covered by harness tests only. One headless probe
(`precomputeCompactionEnabled: true` in `--settings`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70`, context about
464k tokens against a 476k threshold, two user prompts) logged no `precomputed compact:` line of any
kind, so a gate that no log line names was closed: most likely the server flag, which a user cannot set.

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
