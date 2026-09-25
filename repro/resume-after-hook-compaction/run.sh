#!/usr/bin/env bash
# Minimal repro: a session.compact hook that keeps rows leaves a transcript that --resume does not
# restore. Needs the claude CLI (measured on 2.1.282) and node. Costs three small model requests.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
cd "$WORK"
OFF='{"enabledPlugins":{"verbatim-compaction@verbatim-compaction":false}}'
ids() { node -e 'for (const l of require("fs").readFileSync(0,"utf8").split("\n")) { try { const o = JSON.parse(l); if (o.session_id) { console.log(o.session_id); break } } catch {} }'; }

# 1. A session with three Bash calls.
S1=$(claude -p "Use the Bash tool three separate times: echo alpha-1, echo beta-2, echo gamma-3. Then reply done." \
  --allowedTools "Bash(echo:*)" --settings "$OFF" --output-format stream-json --verbose < /dev/null | ids)
# 2. /compact it through the hook (forked, so the original stays as it was).
S2=$(printf '%s\n' '{"type":"user","message":{"role":"user","content":"/compact"}}' | \
  claude -p --resume "$S1" --fork-session --plugin-dir "$HERE/plugin" --settings "$OFF" \
  --input-format stream-json --output-format stream-json --verbose | ids)
T="$(find "$HOME/.claude/projects" -maxdepth 2 -name "$S2.jsonl" | head -1)"
echo "compacted transcript: $T"
node "$HERE/chain.mjs" "$T"
# 3. Resume it and look at what the first request carries.
claude -p "From memory only, no tools: what did the three echo commands print?" --resume "$S2" --fork-session \
  --settings "$OFF" --output-format stream-json --verbose --debug --debug-file "$WORK/resume.log" < /dev/null > "$WORK/resume.jsonl"
grep -o 'ensureToolResultPairing.\{0,250\}' "$WORK/resume.log" || echo "no pairing repair"
