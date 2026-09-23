# verbatim-compaction hook

`hooks/verbatim.ts` is the Claude Code function-hook module. It registers two hooks:

- **`session.compact`** — fires on manual `/compact` and on the `turn.complete`-requested
  auto-compaction below. Depending on the event it takes one of four paths:
  - **`trigger === 'precompute'`**: skipped outright, before rules or the fork ever run. Returns
    `{ skip: reason }` at once (one `$.ui.log` line, no toast, no `$.model.fork`); the real
    compaction that follows runs the full pipeline over its own transcript.
  - **`/compact <instructions>`** (`wantsSummary`): handed to `next(event)` — instructions ask for
    a focused summary, which pruning cannot give.
  - **A subagent's own compaction** (`event.agentId` set): rules only, no `$.model.fork` — a fork
    can only fork the main session, so it has nothing to say about a subagent's transcript.
  - **Everything else**: rules, then one `$.model.fork` call over the calls the rules leave
    undecided, bounded by `claudeTimeoutMs` via `$.clock.sleep` raced against the fork. Below
    `minReductionRatio`, or on any unexpected error, the result goes to `next(event)` instead of
    replacing the transcript.
- **`turn.complete`** — after a top-level turn ends in an answer, reads `$.session.usage()` and
  calls `$.session.compact()` once `context.percent` reaches `compactAtPercent`, guarded against
  overlapping runs.

### Engine calls used

| Call | Where | Why |
| --- | --- | --- |
| `$.model.fork` | `session.compact`, non-subagent, non-precompute | Stage 2 scoring of the calls rules left undecided |
| `$.clock.sleep` | `session.compact` | Bounds the fork to `claudeTimeoutMs`; combined with `next.signal` through a local `AbortController` and `AbortSignal.any`, so a fast fork (or an error) cancels the wait immediately instead of leaving it pending until the timeout elapses or the dispatch ends |
| `$.session.usage` | `turn.complete` | Reads `context.percent` to decide whether to request compaction |
| `$.session.compact` | `turn.complete` | Requests the compaction this module's own `session.compact` hook then handles |
| `$.ui.log` | both, via `notify` | Always-on record of what happened, including the precompute skip |
| `$.ui.toast` | `session.compact`, except on `precompute` | User-visible summary; a broken UI can never turn a good compaction into a failed hook |

The engine API it uses (`session.compact`, `turn.complete`, `$.model.fork`, `$.clock.sleep`,
`$.session.usage`, `$.session.compact`, `$.ui.log`, `$.ui.toast`, and the hook-global
`AbortController`/`AbortSignal`) is declared in `types/claude-code.d.ts`, generated from Claude Code
2.1.274. Function hooks are early access: regenerate and re-check that file after a Claude Code
upgrade.
