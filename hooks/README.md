# verbatim-compaction hook

`hooks/verbatim.ts` is the Claude Code function-hook module. It registers two hooks:

- **`session.compact`** — fires on manual `/compact` and on the `turn.complete`-requested
  auto-compaction below. Depending on the event it takes one of five paths:
  - **`trigger === 'precompute'`**: the full pipeline below, run in the background. It returns
    the pruned messages (kept by the engine for the compaction that comes) or `next(event)` below
    `minReductionRatio`. The forks always get the 45 s ceiling, and it reports in the log only.
  - **An empty transcript** (`event.messages` is empty): returns `{ skip: reason }` itself. The
    engine's `next()` rejects a compaction argument with empty `messages`, even one passed through
    unchanged, so handing it on would fail the hook.
  - **`/compact <instructions>`** (`wantsSummary`): handed to `next(event)` — instructions ask for
    a focused summary, which pruning cannot give.
  - **A subagent's own compaction** (`event.agentId` set): rules only, no `$.model.fork` — a fork
    can only fork the main session, so it has nothing to say about a subagent's transcript.
  - **Everything else**: rules, then Jev-style `$.model.fork` calls over the calls the rules leave
    undecided (and not cited as a rule's evidence), one per `forkChunkSize` chunk, run concurrently
    against one shared `$.clock.sleep` deadline: `claudeTimeoutMs` when the rules alone already
    clear `minReductionRatio`, else the 45 s ceiling. Below `minReductionRatio` (characters saved over tool-result characters, `gateRatio`), or on any
    unexpected error, the result goes to `next(event)` instead of replacing the transcript. A debug
    log line records the wait mode and each fork's size, time and status.
- **`turn.complete`** — after a top-level turn ends in an answer, reads `$.session.usage()` and
  calls `$.session.compact()` once `context.percent` reaches `compactAtPercent`, guarded against
  overlapping runs. The headless rejection of `$.session.compact()` (every `-p` / SDK session
  on 2.1.281, "not available in a headless … session") turns the trigger off for the rest of the
  session, reported once by toast and log; any other rejection is logged and retried next turn.
  A transcript of 4096 messages or more goes to `next(event)` untouched. Once `next(event)` has
  been called, a throw from it is rethrown rather than answered with a second `next(event)`.

### Engine calls used

| Call | Where | Why |
| --- | --- | --- |
| `$.model.fork` | `session.compact`, non-subagent | Jev-style scoring of the calls rules left undecided, one fork per chunk |
| `$.clock.sleep` | `session.compact` | Bounds the fork to `claudeTimeoutMs`; combined with `next.signal` through a local `AbortController` and `AbortSignal.any`, so a fast fork (or an error) cancels the wait as soon as the compaction settles instead of leaving it pending until the timeout elapses or the dispatch ends. The sleep does not spend the hook's 10 s budget while the fork is pending (measured on 2.1.281), so the timeout may be longer than the budget |
| `$.session.usage` | `turn.complete` | Reads `context.percent` to decide whether to request compaction |
| `$.session.compact` | `turn.complete` | Requests the compaction this module's own `session.compact` hook then handles |
| `$.ui.log` | both, via `notify` and `debug` | Always-on record of what happened (a precompute reports here only); with `{ to: 'debug' }`, the effective config once per load and each turn's context percent against `compactAtPercent` |
| `$.ui.toast` | `session.compact`, except on `precompute` | User-visible summary, naming the Claude stage's outcome and wait (`claude 96 (ran 5.2s)`); a broken UI can never turn a good compaction into a failed hook |

The engine API it uses (`session.compact`, `turn.complete`, `$.model.fork`, `$.clock.sleep`,
`$.session.usage`, `$.session.compact`, `$.ui.log`, `$.ui.toast`, and the hook-global
`AbortController`/`AbortSignal`) is declared in `types/claude-code.d.ts`, generated from Claude Code
2.1.281. Function hooks are early access: regenerate and re-check that file after a Claude Code
upgrade.
