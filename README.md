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
   path, a URL, a dollar amount, a long number, a long identifier or one with two or more underscores or
   humps) which later assistant text or a later tool input quotes (edits excluded) is never dropped,
   whichever stage decided it: it is truncated only to a head (stretched up to 4000 chars) or head+tail
   window that still holds the token's first occurrence. When no such window does, it keeps its head and
   tail plus an excerpt of the lines within 200 chars of each token they miss, each gap marked
   `[… N chars omitted …]`; only when those pieces would exceed 4000 chars is it kept verbatim. Only text
   that is never pruned (user and assistant text, pinned results) counts as already having the token;
   an edit's input does not, because the edit itself can be dropped.
2. **Claude** (optional): tool-less `$.model.fork`s of your own session are asked Jev's two questions
   about each remaining call: must its **result** stay verbatim, and does the **call** itself still
   matter? The answer is four id lists,
   `{"result_needed":[…],"call_matters":[…],"unsure":[…],"drop":[…]}`: result needed keeps the call
   whole, call matters truncates its output, `unsure` follows `keepThreshold`, `drop` cuts the output to
   a one-line note (the call row stays: Claude Code hands each block over as its own message), and a
   call in no list is kept. A reply whose lists cover under 80% of the chunk's calls counts as
   unparseable, so a lazy "these three can go" never decides for the other 37. Candidates are split into
   chunks of `forkChunkSize` (60), one fork per chunk, all concurrent but never more than 8 (past that,
   chunks grow); each reuses the session's prompt cache, so three forks take about as long as one
   (measured: 3 × ~5 s forks in ~5 s wall). A chunk whose fork fails or whose reply does not parse is
   re-asked whole once, then as two halves (a refused one goes straight to the halves); whatever still
   fails decides nothing, and its calls are kept.
   The forks race the short `claudeTimeoutMs` only when the rules alone already clear
   `minReductionRatio`; otherwise they are the only way to clear it, so they may take up to 45 s.
   A subagent's own compaction uses the rules only (the fork can only fork the main session).
   A `precompute` run (see below) runs the full pipeline in the background.

   Why lists and not Jev's per-call probabilities: on Claude Code 2.1.281 the API rejected every
   fork asked to answer one line per call (digit scores such as `t12 93`, and letters such as
   `t12 K`), with `invalid_request` and no output, once there were 10 or more candidates. The same
   candidates passed at 10, 30 and 60 when the reply was JSON lists. So `keepThreshold` is not a
   probability cut here. It only decides what `unsure` becomes.

   Those rejections are the model's safeguards refusing (`stop_reason: "refusal"`), which Claude Code
   2.1.281 turns into an error frame (`invalid_request`, no status) and a fork reports as `api-error`.
   How often they fire depends on the whole request, and long tool inputs set them off most: in a
   security-heavy session, candidate lines carrying Bash commands of up to 400 characters were refused
   on 3 of 4 first tries, while the same lines cut to 120 or 200 characters passed 16 of 16. So a call's input is
   shown up to 120 characters, after its secret-bearing parts are reduced to names: env assignment
   values (`TOKEN=…`), HTTP header values (`-H 'Authorization: …'`) and heredoc bodies (`<<EOF …>`).
   A refused chunk (status `refused` in the log: a status-less `invalid_request` frame) goes straight
   to two halves: a whole re-ask of the same lines was refused again both times it was tried (live, 2.1.282),
   while the halves mostly answered. A refusal that lands mid-reply leaves cut-off text, which shows
   as `unparseable` because the fork result does not say why the text stopped.

If the result saves less than `minReductionRatio` of the transcript's tool-result characters (the only
thing pruning can shrink; user text and attachments are out of its reach), Claude Code's built-in summary
runs instead. So does
`/compact <instructions>`: instructions ask for a focused summary, which pruning cannot give. A plain
`/compact` prunes. Two exceptions keep a long session verbatim for longer:

- **The plugin's own request** (at `compactAtPercent`) never ends in a summary. Below the gate it
  leaves the transcript as it is and waits: nothing needs the room yet, and Claude Code's own
  compaction still runs at its threshold, where the gate decides as above.
- **Tier 2.** A long session compacts many times, and a later pass has less to cut: the old output
  is already truncated, so only what arrived since can go. When a pass misses the gate on a
  transcript an earlier compaction already truncated, it is tried once more with half the
  `staleAfterMessages`, `truncateHeadChars` and `truncateTailChars`, and old truncations older than
  that age are cut further (`stale_truncation`). The scorer is not asked again, and pins hold.

A result truncated by an earlier pass is cut again within its own head and tail, with one note whose
count still accounts for the original result. It is never truncated twice over (two notes).

**How far verbatim compaction can go in a long session.** Replayed over the maintainers' corpus
(`npm run eval:offline -- --replay`, a 400k window), tool results were under a fifth of the context at
the first compaction and about a tenth at later ones. The rest was the system prompt and tools, user
and assistant text, tool inputs, and the model's earlier thinking, which stays in context (a fit to
the sessions' API usage puts it at a quarter to nearly half of the tokens) and which pruning never touches. So a prune
frees less each time, and on every long session replayed one of the later compactions still fell back
to the summary. The two exceptions above cut those fallbacks by about a fifth (19 to 15 over four
sessions and three scorer bounds). Mean fact survival rose on seven of those twelve runs, held on one and fell by at
most two points on four. A few passes late in a session freed under 5% of the context, leaving it at
Claude Code's own threshold, so the fallback came a turn or two later instead.

**Headless (`claude -p`, the SDK):** the automatic trigger does not work there. Claude Code 2.1.281
refuses `$.session.compact()` outside an interactive session (compaction there runs only inside a turn,
as a `/compact` prompt). After that refusal (its message says "not available in a headless … session")
the plugin stops asking for the rest of the session and says so once (a toast and a log line). Any other
rejection, such as one while a turn is running, is logged and the request is tried again next turn. Send `/compact` yourself, or rely on Claude Code's own
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
| `compactAtPercent` | 60 | Context % at which compaction is requested (1–100). After the plugin's own compaction it waits until context reads under this again before asking once more, so a prune that leaves context above it is not followed by a compaction on every turn |
| `minReductionRatio` | 0.25 | Characters saved over tool-result characters; below this, fall back to the built-in summary |
| `preserveRecentMessages` | 6 | Newest messages never touched (the first is always kept). Counted as Claude Code hands them over: one per content block, so a turn with a thinking block, some text and two tool calls, and the results of those calls, is several messages, not one |
| `truncateHeadChars` | 300 | Characters kept from a truncated result |
| `truncateTailChars` | 1000 | Characters also kept from the end of a log-like result, or to hold a pinned token |
| `staleAfterMessages` | 100 | Read and Bash file-read results older than this many messages are truncated. Counted in the same units as `preserveRecentMessages` (one per content block); 100 is about 60 merged user/assistant messages |
| `pinReferenced` | true | Never drop a result whose introduced tokens are quoted later |
| `stripMcpFurniture` | true | Strip JSON furniture from kept MCP results |
| `maxCandidates` | 400 | Most calls listed for Claude, largest outputs first |
| `useClaudeScorer` | true | `false` = rules only, no model call |
| `claudeTimeoutMs` | 30000 | Longest wait for the forks when the rules alone already clear the gate; past it the rules alone decide (otherwise the forks get the 45 s ceiling). 30 s lets most slow but healthy forks count (they measured up to about 31 s end to end, so the slowest can still miss it and fall back to the rules alone), and stays well under the 60 s a headless turn waits. Clamped to 500–45000 ms. The hook's ten-second budget counts only the hook's own time, and a pending fork stops that clock even while the timeout's `$.clock.sleep` runs beside it (measured on 2.1.281: a hook that raced a fork against a 30 s sleep ran 30 s and was not cut) |
| `keepThreshold` | 0.5 | What the fork's `unsure` calls become: below 0.5 kept whole, 0.5–0.75 output truncated, above 0.75 removed |
| `forkChunkSize` | 60 | Most calls per fork; more run as concurrent forks. 1–400 |
| `minCandidateChars` | 200 | Results shorter than this are kept whole without asking the forks: every id asked about costs fork output time, and a short result saves little. 0 asks about every call |

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
