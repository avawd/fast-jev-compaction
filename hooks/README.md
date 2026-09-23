# verbatim-compaction hook

`hooks/verbatim.ts` is the Claude Code function-hook module. It handles `session.compact` (manual
`/compact` and auto-compaction) by running `src/` over the transcript with a scorer built from the
local rules and `$.model.fork`, and it requests compaction from `turn.complete` once
`$.session.usage()` reports `compactAtPercent` or more.

The engine API it uses (`session.compact`, `turn.complete`, `$.model.fork`, `$.session.usage`) is
declared in `types/claude-code.d.ts`, generated from Claude Code 2.1.274. Function hooks are early
access: regenerate and re-check that file after a Claude Code upgrade.
