# Claude-scored verbatim compaction: design

**Status:** implemented on branch claude-scorer.
**Branch:** `claude-scorer`.

## Goal

Keep this plugin's core idea: compaction removes or truncates stale tool calls and results and keeps
everything else word for word, instead of summarizing. Replace the external Jev API with two scorers
that send nothing to a new third party:

1. **Rules:** deterministic, local and free. They prune only what is provably stale.
2. **Claude:** one `$.model.fork` completion over the session's own transcript. It uses the model the
   session already talks to, shares the session's prompt cache, and needs no extra API key.

### Non-goals

- Compacting or rewriting user or assistant text. That stays word for word, as upstream.
- Changing when Claude Code itself decides to compact.
- Supporting Jev as an alternative scorer. It is removed, not left behind a flag.

## Why not Jev

On every compaction, upstream sends the conversation state (all user and assistant text and every tool
input) to an external API. That is a new data processor for whatever the session contains, and it needs
its own key and billing. `$.model.fork` sends nothing beyond what the session's model provider already
receives.

## Architecture

| Unit | Status | Responsibility |
|---|---|---|
| `src/types.ts`, `src/messages.ts` | kept | Message and tool shapes |
| `collectToolCalls`, pinning, `applyDecisions` in `src/compact.ts` | kept | Pair each call with its result, pin the first and newest messages, rebuild the message list without leaving a result behind without its call |
| `hooks/fast-jev.ts` → `hooks/verbatim.ts` | adapted | `session.compact` and `turn.complete` wiring, `toSessionMessages`, fallback to the built-in summary |
| `src/client.ts`, `src/request.ts`, `fitState`, request batching in `src/state.ts` | **removed** | Jev transport and the Jev state budget |
| `src/rules.ts` | **new** | Stage 1 rules |
| `src/claude-scorer.ts` | **new** | Stage 2 fork prompt, candidate index, reply parsing |
| `src/score.ts` | **new** | Merges both stages into one decision per call |

Each new unit is pure except `claude-scorer.ts`, which receives the fork function by injection so it can
be tested without the engine.

## Stage 1: rules

Rules run over the unpinned calls, oldest first. Each one decides `truncate`, `drop` or `undecided`.
Only `undecided` calls go on to stage 2.

| Rule | Condition | Decision |
|---|---|---|
| Stale read | A `Read` of path P is followed later by a successful `Edit`, `Write`, `MultiEdit` or `NotebookEdit` on P, or by a successful full `Read` of P (no `offset`/`limit`). A later ranged read or a failed write is not evidence; an earlier ranged read can still go stale | `truncate` (the call stays; the old contents go) |
| Repeated search | A `Grep`, `Glob` or `LS` call is later repeated with identical input | `drop` the older one |
| Failed then fixed | A call with `isError` is later repeated with identical input without error | `drop` the failed one |

Paths are compared after normalizing (`./` stripped, same absolute form). Inputs are compared as
canonical JSON with sorted keys. A rule never targets a pinned call; pinned calls do count as evidence.

## Stage 2: Claude via `$.model.fork`

- **Candidate list:** one line per undecided call, numbered `t1…tN` in transcript order, e.g.
  `t12 Read file_path=src/a.ts → ok 4213ch`. Tool inputs are cut to 120 characters in the list; the
  fork already sees them in full in the transcript.
- **Prompt:** asks which candidates are no longer needed to continue the current work. It explains the
  two actions (`drop`: the call and its result are no longer relevant; `truncate`: knowing the call
  happened matters, the full output does not). It asks for JSON only:
  `{"drop":["t3"],"truncate":["t7"]}`. Anything not listed is kept, so keeping is the default.
- **Candidate cap:** at most `maxCandidates` (default 400), taking the largest results first when there
  are more. Calls beyond the cap are kept.
- **Checking the reply:**
  - Take the first JSON object in the reply.
  - Both keys must be arrays of strings.
  - Unknown or duplicate ids are ignored.
  - An id listed under both keys resolves to `truncate`, the less destructive action.
- **When stage 2 fails:** if the fork returns `null` (cold cache or API error), throws, replies with
  something unparseable, or has not answered within `claudeTimeoutMs` (status `timeout`), stage 2 counts
  as having decided nothing. Stage 1's decisions still apply. The timeout waits on `$.clock.sleep`,
  injected into the library, and is aborted with the hook's dispatch.
- **When stage 2 is not asked:** a subagent's own compaction (`agentId` set) and a `precompute` run use
  stage 1 only; the fork forks the main session, and a precompute installs nothing (it logs, no toast).

## Deciding and applying

- `drop`: the call and its result are removed.
- `truncate`: the call stays, and the result is cut to its first `truncateHeadChars` (default 300)
  characters plus a one-line note.
- Kept, pinned and undecided calls stay as they are.
- If the estimated character reduction is below `minReductionRatio` (default 0.25), the hook hands over
  to Claude Code's built-in compaction via `next(event)`. The same happens on any unexpected error.
- The toast and log report per-stage counts (rules/Claude/kept/pinned), the reduction, and whether the
  fork ran, returned `null`, failed to parse, errored or timed out.

## Trigger

This is unchanged from upstream. `turn.complete` requests compaction when `context.percent` reaches
`compactAtPercent` (default 60), with the same guard against overlapping runs (set before usage is
read). Subagent turns and turns that did not end in an answer are ignored. `session.compact` handles both
that request and manual `/compact`; `/compact <instructions>` goes to the built-in summary.

## Configuration (`userConfig`)

| Key | Default | Notes |
|---|---|---|
| `compactAtPercent` | 60 | unchanged |
| `minReductionRatio` | 0.25 | unchanged |
| `preserveRecentMessages` | 6 | unchanged |
| `truncateHeadChars` | 300 | unchanged |
| `maxCandidates` | 400 | new |
| `useClaudeScorer` | true | new; `false` means rules only, with no model call |
| `claudeTimeoutMs` | 6000 | new; past it the fork is abandoned (status `timeout`) and rules alone decide |

These are removed: `apiKey`, `keepThreshold`, `maxStateTokens`, `maxRequestTokens`, `model`.

## Cost

The fork reads the session's cached prefix, so input is billed at the cache-read rate of the session's
model, and output is a short JSON reply. At a 600k-token context on a model with $0.20/MTok cache reads,
that comes to about $0.12 of input per compaction. A cold cache produces `null`, not a full-price call.
Setting `useClaudeScorer: false` makes every compaction free.

## Safety constraints

- User and assistant text is never modified.
- The first message and the newest `preserveRecentMessages` messages are never modified.
- No result is ever left without its call, and no call is ever duplicated.
- The fork is tool-less (enforced by the engine), so scoring cannot act.
- The plugin makes no other network calls, reads no files and uses no API key.

## Testing

- **`rules.test.ts`:** a fixture transcript per rule, plus negative cases (different path, different
  input, pinned target, error with no later success). Written test-first.
- **`claude-scorer.test.ts`:** a fake fork returning valid JSON, prose around the JSON, unknown ids,
  conflicting ids, `null`, and a thrown error. Also checks the candidate-list format and the cap.
- **`score.test.ts`:** how the two stages merge, and that a stage 2 failure leaves the stage 1 result.
- **`hook.test.ts`** (adapted): fallback on low reduction and on errors, toast text, and that
  `toSessionMessages` returns objects unchanged when nothing changed.
  `register()` is exercised through a fake `on`/`$` harness (`tests/harness.ts`): fallback, success,
  timeout, subagent, precompute, `/compact <instructions>`, a throwing UI, and the `turn.complete`
  threshold, in-flight guard and ignored turns.
- **Apply step:** property checks that no result is left without its call and all text survives, over
  randomized transcripts.
- **Live check:** start Claude Code with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .` from
  the repo root, run `/compact` on a real session, and confirm the toast and the kept messages.

## Engine API assumptions

`$.model.fork`, `session.compact`, `turn.complete` and `$.session.usage` come from the function-hook
surface declared in `types/claude-code.d.ts`, generated from Claude Code 2.1.274. Function hooks are
early access. Check them against the running version before release.
