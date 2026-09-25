# eval — measuring verbatim-compaction

Two harnesses. **Offline** runs any branch's `src/` over real transcripts with no model calls, in
seconds. **Live** forks a real session headlessly, runs `/compact` through a given plugin directory
and asks recall questions. Use offline to compare branches; use live to confirm reliability and
recall end to end.

Nothing here edits `src/` or `hooks/`. **This repo is public**: transcripts are referenced by absolute
path from local, gitignored configs (`eval/corpus.local.json`, `eval/recall.local.json`; templates in
`eval/*.example.json`) and never copied in. Output goes to `eval/out/`, which is also gitignored.

## Offline: `npm run eval:offline`

```
npm run eval:offline                                    # this checkout's src/, corpus eval/corpus.local.json
npm run eval:offline -- --src ../other-worktree         # another worktree (root or its src/)
npm run eval:offline -- --only ops-live --options '{"truncateHeadChars":500}'
npm run eval:offline -- --compare eval/out/offline-A.json eval/out/offline-B.json
npm run eval:offline -- --facts ops-live                # list never-echoed facts (stdout only; private)
npm run eval:offline -- --facts /path/session.jsonl     # ...of any transcript's last segment
```

`--src` loads `<src>/index.ts` with a dynamic import, so the same harness measures every branch. It
uses only `compact`, `makeScorer`, `collectToolCalls` and `reductionRatio`. If a branch changes
those signatures, `eval/plugin.ts` stops with a clear error instead of reporting wrong numbers.

Each segment runs in three **arms**, all through the branch's own `compact()` and truncation:

| arm | what the Claude stage is replaced by | meaning |
|---|---|---|
| `rules` | nothing (`useClaudeScorer: false`) | what the rules alone do. It is also the **ceiling** for fact survival, because a scorer can only remove more |
| `trunc` | every call the rules left undecided gets `drop_result` | a scorer that truncates everything it is unsure of |
| `floor` | every undecided call gets `drop_call` | the **floor**: a scorer that drops everything it is asked about |

Every arm passes the segment's `cwd` as a compact option, unless `--options` sets one. It is the
`cwd` recorded on the segment's last main-thread user/assistant row, which is what the hook's
`$.session.cwd()` returns at that point. Branches without the option ignore it. The JSON records it
per segment. On the current corpus it changes no rule decision, because the commands mostly `cd` to
an absolute path first. Pass `--options '{"cwd":""}'` to turn it off.

A real scorer run falls between `floor` and `rules`. If `trunc` or `floor` leaves a call undecided,
the harness prints `WARN ... Scorer contract may have changed`.

### Columns

| column | definition |
|---|---|
| `msgs` | messages in the segment, as the hook would receive them (see "Parser fidelity") |
| `calls/unp` | paired tool calls / how many of them are unpinned (not in the first message or the newest `preserveRecentMessages`) |
| `unpinned res` | bytes of unpinned tool results. This is everything the plugin is able to shrink |
| `rules rm%` | share of those bytes the rules arm removed |
| `gate(ratio)` | the branch's own `reductionRatio` for the rules arm, compared with `--min-reduction` (default 0.25). `FAIL` means that with no scorer help the hook would hand the compaction to the built-in summary |
| `facts` | **never-echoed facts**: sha, #PR, Jira key, 4+ digit number, money or URL tokens that an unpinned tool result introduced (no earlier message held them) and that no assistant text ever repeats. Only the verbatim output carries them |
| `surv ceil=rules / trunc / floor` | share of those facts still present anywhere in the compacted context |
| `next (live)` | the same facts in the next segment of the same file, which is what actually happened live. `summary` means the built-in summary message ran; `verbatim` means the rows a verbatim compaction carried over (see `carriedPrefix`). The `*` segment is the live one, where the spec's gate is survival ≥70% |
| `laterRef lost r/t/f` | tokens an unpinned result introduced and a later assistant text or non-authoring tool input quoted, that are absent from the **whole compacted context before that quote**, for rules/trunc/floor, out of the total. A newer carrier the plugin kept instead counts as kept. An Edit/Write/MultiEdit/NotebookEdit input is not a quote, because it carries its own copy of the text (this mirrors the plugin's pin rule) |

The JSON (`eval/out/offline-<branch>@<sha>.json`, or `--json <path>`) holds every number per arm,
including decision counts by rule. `--compare` diffs two of them.

### Corpus

The corpus file is `--corpus`, then `$VC_EVAL_CORPUS`, then `eval/corpus.local.json`. Its format is in
`eval/corpus.example.json`: a label, the transcript's absolute path, the segment index after splitting
at `compact_boundary`, and `live: true` on at most one segment. The maintainers' local corpus holds the
six segments the effectiveness review measured. A missing file or segment is skipped with a warning
and recorded in the JSON under `skipped`.

### Parser fidelity (`eval/parse.ts`)

In 2.1.281 the engine gives a hook **one `SessionMessage` per transcript row**. Claude Code writes an
assistant turn as one row per content block (thinking, text and tool_use rows share `message.id`) and
one user row per tool_result. The engine does not merge these rows. A thinking-only row reaches the
hook as a message with `text: ''`. `isMeta` rows, sidechain rows and `attachment` rows are not
messages. Each tool use carries its outcome in `text` and `isError`, as the engine attaches it.

The review's original parser merged rows by `message.id`, merged consecutive result rows, and folded
attachments into user text. On the live segment that produced 187 messages. The hook actually
received 303.

**Measured, not assumed:** on four live forked compactions, the parser's pre-compact message count
equals the hook's `kept X/Y` Y, and its carried prefix equals X:

| forked compaction | hook saw / kept | parsed / carried |
|---|---|---|
| reliability run 1 | 417 / 259 | 417 / 259 |
| reliability run 4 | 416 / 194 | 416 / 194 |
| reliability run 5 | 417 / 187 | 417 / 187 |
| the live corpus segment | 303 / 161 | 303 / 161 |

The probe plugin's run8 also matched on text and result lengths (user 262 chars, Read result 3609,
Grep 343, assistant text 4). `live-summary.ts` repeats this check on every live run whose outcome
prints `kept X/Y` (column `parser`).

**Known remaining differences:**

- A tool_result whose content is an array of blocks is joined with `'\n'`, and an image becomes
  `[image]`. Every calibrated result was a plain string, so this join is uncalibrated.
- `$.session.messages()` returns at most the newest 4096 entries. The parser does not cap. No corpus
  segment is near that limit.
- An offline segment ends at the recorded boundary. A live `/compact` runs after the extra "ok"
  turn, so it sees two more rows.
- Byte counts use JS string length (UTF-16 units), the same as the plugin's `messageChars`.

## Replay: `npm run eval:offline -- --replay`

A long session compacts many times, and each pass is handed the previous one's output. The replay
walks one transcript row by row, compacts whenever the modelled context crosses a threshold, carries
the compacted transcript forward and keeps appending the real later rows. No model calls.

```
npm run eval:offline -- --replay coding-2                 # one corpus segment, all three arms
npm run eval:offline -- --replay coding --whole           # every segment of the file, joined
npm run eval:offline -- --replay long-ops --arms trunc --window 1000000 --compact-at 0.6 --auto-at 0.92
```

**Context model.** Tokens = overhead + a·visible chars + b·hidden chars, fitted by least squares to
the transcript's own API usage rows before its first real compaction (`--fit corpus` uses the
corpus-wide fit, `--fit visible` drops the hidden term). Per-transcript fits have a median error of
0.4-2.3%; the corpus-wide one 5.5%; without the hidden term, two to four times higher. The hidden term
is measured by the stored thinking (text and signature) chars because they predict it best, but it is
a proxy for context the hook never sees, not the thinking itself: in a live A/B (rules-only pruning,
identical visible transcript, old turns' thinking rows left out in one run and kept in the other,
334k thinking chars apart) the next request's input tokens were 523,656 and 523,571. Pruning never
touches the hidden part, and neither did leaving thinking out.

**Triggers.** The plugin requests a compaction at a turn end once context reaches `--compact-at`
(default 0.6 of `--window`, default 400k), then waits for context to drop under it again, as the hook
does. Claude Code's own compaction fires at `--auto-at` (default 0.92) at most once per turn. Each
compaction runs the branch's `compact()` with `escalateBelow` set to the gate, and decides prune,
skip or summary with the branch's `gateOutcome` (older branches: summary below the gate). A summary
leaves a 15k-token message crediting no facts (a conservative bound) plus the last 6 rows.

**Columns** (one table per arm): `prior` (an earlier verbatim pass since the last summary), `tier`,
context before→after (`OVER` = still at or above the auto-compact point), the gate, `verbatim` or
`FALLBACK`, tool-result chars going in, never-echoed survival among facts introduced so far, laterRef
lost, and idempotence: results already truncated going in / cut again / holding more than one note /
removed. The arm line adds the mean survival sampled every 25 rows, which says more than the final
figure (that depends on where the last summary happens to fall).

## Live: `npm run eval:live`

```
npm run eval:live -- --plugin-dir ../other-worktree -n 8
npm run eval:live -- --plugin-dir <dir> -n 1 --sets hard --options '{"claudeTimeoutMs":20000}'
node_modules/.bin/tsx eval/live-summary.ts eval/out/live-<stamp>   # re-summarise without re-running
```

The recall config is `--config`, then `$VC_EVAL_RECALL`, then `eval/recall.local.json` (format in
`eval/recall.example.json`). For each run, this runs from the config's `cwd`:

```
claude -p --resume <session> --fork-session --plugin-dir <dir> \
  --settings '{"enabledPlugins":{"verbatim-compaction@verbatim-compaction":false}[,"pluginConfigs":...]}' \
  --input-format stream-json --output-format stream-json --verbose --debug --debug-file runN.debug.log
```

There is **no `--disallowedTools`**. The scorer's fork resends the main thread's request, tools list
included, and a narrowed list made forks fail with `invalid_request` (2 of 11 with the flag, 0 of 19
without, measured by the scorer work). Instead, every recall question is prefixed with "Answer from
memory only; do not use any tools." A recall turn that uses any tool anyway is scored **FAILED**
(0 hits), because its answer did not come from the compacted context.

stdin carries "Reply with just: ok", then `/compact`, then one message per recall set. Runs are
sequential. `--fork-session` never modifies the original session, but **every run leaves a new
forked transcript** (about 10 MB) under `~/.claude/projects/`. The summary lists their ids.

The inline copy registers as `verbatim-compaction@inline`, and the global copy logs
`enabled=false; will NOT register`. `--options` is written under both config keys.

`live-summary.ts` writes a table and `summary.json` with these fields:

| field | source |
|---|---|
| loaded from | `Read hooks.json for plugin verbatim-compaction (enabled=true): …`. It flags `WRONG COPY` if anything but `--plugin-dir` registered |
| forks (ms) | every `$.model.fork (verbatim-compaction): Nms …` line, plus the count of `source=hook_prompt` requests |
| fork api-err | fork lines reporting `API error …`. The target is 0 |
| outcome, fallback | the plugin's `$.ui.log` `kept …` / `fallback …` line. Fallback also counts when core ran or no "a hook's N messages stand" line appears |
| pre→post tok | the `compact_boundary` event's `compact_metadata` |
| hook ms (incl. next) | `session.compact settled in`. On a fallback this includes the built-in summary |
| recall `<set>` | expected tokens found (case-insensitive substring) in the post-compaction answers. `FAILED (tool use)` if the recall turn called any tool |
| ctx `<set>` before→after | expected tokens present in the forked transcript before compaction, and in the context after it (the carried rows, or the summary message). This measures retention without depending on the model's answer. `before` < all means the recall set no longer fits the session and must be refreshed |
| parser | the fidelity check above |

### Recall sets

- `basic`: facts the assistant echoed in its own text, so a summary can keep them. This set checks
  that the model still has the thread, but it does not separate a verbatim arm from a summary arm.
- `hard`: facts that appeared **only** in a tool result, such as a sha in a `git worktree list`
  output, a PR number in a `gh` listing, a ticket key in a source comment, or a numeric id in an MCP
  payload. Pick them with `--facts` and confirm each is absent from every assistant text. Only
  verbatim retention can answer them, so this is the set that separates the arms.

Stream-json coalesces queued prompts. In the validation run, both recall questions were answered in
one reply. So each set is scored against all post-compaction answers joined together. The expected
tokens are specific to each set, so they cannot cross-match.

## Baselines (2026-09-24)

`laterRef lost` uses the definition above; earlier tables in this file's history over-counted it.

**claude-scorer @ 5963d67** (before the optimisation). The rules alone never clear the 0.25 gate. On
the live segment, the live verbatim compaction kept 27.3% of never-echoed facts:

| segment | msgs | calls/unp | unpinned res | rules rm% | gate(ratio) | facts | surv rules | trunc | floor | next (live) | laterRef lost r/t/f |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ops-live* | 303 | 100/99 | 177.1k | 0% | FAIL (0) | 198 | 100% | 32.8% | 1% | 27.3% verbatim | 0/40/70 of 73 |
| long-ops | 1050 | 260/259 | 362.6k | 1.4% | FAIL (0.007) | 304 | 100% | 36.8% | 1.6% | 0% summary | 0/45/91 of 110 |
| mixed | 498 | 149/147 | 299.3k | 0% | FAIL (0) | 368 | 100% | 29.3% | 0.5% | 3.3% summary | 0/36/80 of 81 |
| coding | 733 | 206/205 | 272.3k | 39.7% | FAIL (0.206) | 116 | 96.6% | 36.2% | 8.6% | 0.9% summary | 3/18/29 of 34 |
| coding-2 | 1284 | 375/374 | 606.2k | 16.1% | FAIL (0.09) | 493 | 96.3% | 20.9% | 4.5% | - | 3/46/73 of 81 |
| bash-heavy | 1080 | 338/335 | 381.4k | 0% | FAIL (0) | 283 | 100% | 45.9% | 9.9% | - | 0/55/121 of 125 |

**optimize @ fd200d4** (Stage 1, 2a and 2b plus the rule fixes; gate over tool-result bytes; `cwd`
passed):

| segment | msgs | calls/unp | unpinned res | rules rm% | gate(ratio) | facts | surv rules | trunc | floor | next (live) | laterRef lost r/t/f |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ops-live* | 303 | 100/99 | 177.1k | 35.1% | pass (0.35) | 198 | 70.7% | 51.5% | 47.5% | 27.3% verbatim | 0/0/0 of 73 |
| long-ops | 1050 | 260/259 | 362.6k | 41.6% | pass (0.416) | 304 | 74.7% | 41.1% | 24% | 0% summary | 0/0/0 of 110 |
| mixed | 498 | 149/147 | 299.3k | 12.2% | FAIL (0.121) | 368 | 81% | 55.2% | 54.9% | 3.3% summary | 0/0/0 of 81 |
| coding | 733 | 206/205 | 272.3k | 54.8% | pass (0.548) | 116 | 64.7% | 49.1% | 37.1% | 0.9% summary | 0/0/0 of 34 |
| coding-2 | 1284 | 375/374 | 606.2k | 45.1% | pass (0.45) | 493 | 74.2% | 66.5% | 64.1% | - | 0/0/1 of 81 |
| bash-heavy | 1080 | 338/335 | 381.4k | 50.5% | pass (0.503) | 283 | 63.3% | 50.9% | 41.3% | - | 0/0/0 of 125 |

Live validation run 1 (claude-scorer @ 5963d67, still with `--disallowedTools`): the plugin loaded from the plugin
dir and the global copy was disabled. One fork took 8269 ms and hit the 6000 ms timeout. That left
0% reduction, so the hook fell back to the built-in summary (433,745→11,714 tokens; the hook settled
in 119 s including the summary). Recall: basic 7/7, hard 0/4. Context: basic 7→7, hard 4→0.

Live validation run 2 (optimize @ f866375, no `--disallowedTools`): the plugin loaded from the plugin
dir. There were 5 concurrent forks (3.7, 7.1, 5.5, 6.2 and 10.4 s). **One reported `API error no
status`**, returning 0 replies after 3.7 s. The outcome was verbatim: kept 634/634 messages, 59% of
tool output removed (26% of the transcript), no fallback, 439,123→174,997 tokens, and the hook took
10.5 s. Recall: basic 7/7, hard 4/4. Context: basic 7→7, hard 4→4. No recall tool use. The parser
check was ok (634/634).
