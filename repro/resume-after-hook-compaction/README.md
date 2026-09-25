# Repro: `--resume` after a hook compaction that kept rows

**Measured on Claude Code 2.1.282.** A `session.compact` hook can return the engine's own rows (by
`handle`). When it does, the transcript that gets written cannot be resumed correctly.
`claude --resume` (and `--fork-session`) rebuilds a conversation that splices pre-compaction rows into
post-compaction ones. The API request then carries duplicated `tool_use` blocks and
`ensureToolResultPairing` repairs it. On a real 364k-token session compacted to 310k, the first request
after `--resume` held **74k** tokens: little more than the system prompt and tools, so almost the whole
conversation was gone.

`./run.sh` shows it with the smallest possible hook (`plugin/hooks/repro.ts` returns
`event.messages` unchanged). It creates a session with three Bash calls, forks it through `/compact`,
reports the compacted transcript's chain (`chain.mjs`), resumes it and greps the pairing repair:

```
{"rows":131,"boundary":59,"toolResultRowsAfterBoundary":{"staleSource":3,"other":0},"chainReentersPreBoundaryAtRow":46}
ensureToolResultPairing: repaired missing tool_result blocks (14 -> 14 messages). Message structure: [0] user; [1] api_system;
  [2] assistant(id=msg_…, tool_uses=[toolu_019q…,toolu_019q…]); …
```

## Cause (engine)

1. **Stale `sourceToolAssistantUUID`.** When a hook's messages stand, every row gets a fresh `uuid`
   (`_Pn`/`g8e` in the bundle: `{...row, uuid: randomUUID()}`). A kept tool_result row still carries
   `sourceToolAssistantUUID`, and that points at the **pre-compaction** assistant row, which is still in
   the file above the boundary. The row is written with `parentUuid` set to that uuid too. On load, the
   tool-result re-parenting pass (`"sourceToolAssistantUUID" in Ut … F(Nt.uuid, Ut)`) follows it.
   The chain walk from the leaf then leaves the post-boundary rows at the newest kept tool_result
   and continues through the old ones. A tool_result row the hook **rebuilt** has no
   `sourceToolAssistantUUID` and is chained correctly.
2. **Shared `message.id`.** `g8e` keeps `message.id` on kept assistant rows. The loader groups assistant
   rows by `message.id` across the whole file (`h.get(message.id)`), so it also pulls in the
   pre-boundary copies. This is where the duplicated `tool_use` blocks come from. It happens even when
   every tool_result row is rebuilt.

**Fix, engine side:** when re-uuiding a hook's rows, remap `sourceToolAssistantUUID` (and `parentUuid`)
through the old→new uuid map. Also stop the loader from grouping by `message.id` or re-parenting across
the last `compact_boundary`. The built-in compaction does not hit this: it records
`preserved_messages` in `compact_metadata`.

**Evidence that (1) is the main cause:** in a copy of the 364k-token session's compacted transcript,
the 57 stale tool_result rows were re-pointed (`sourceToolAssistantUUID` and `parentUuid`) at the
post-boundary copy of their assistant row. Resuming that copy gave a first request of 316k tokens with
no pairing repair. The unrepaired transcript gave 74k.

## Why the plugin does not work around it

The only lever a hook has is to return a tool_result row **rebuilt** (no `handle`), which drops
`sourceToolAssistantUUID`. That fixes (1), not (2). A rebuilt row also loses everything the engine
groups with it: the attachment rows after it and image blocks (a rebuilt result is text only). Over
four long sessions, 136 `queued_command` attachments (prompts the user typed while tools ran) sat
after tool_result rows, and only 10 of them also appear as a user row. Rebuilding every tool_result
row would silently drop the other 126 user inputs from the compacted context, along with
`nested_memory` and `deferred_tools_record` riders.
