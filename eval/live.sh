#!/usr/bin/env bash
# Live eval: N forked headless /compact runs of a real session against one plugin dir,
# then the recall probes from eval/recall.json. --fork-session never modifies the original
# session, but every run leaves a new forked transcript under ~/.claude/projects (ids are
# listed in the summary). Model calls cost money: each run is one resume + one fork per
# scorer request + one answer per recall set.
#
#   npm run eval:live -- --plugin-dir <dir> [-n 8] [--session <id>] [--sets basic,hard]
#                        [--options '<plugin options json>'] [--out <dir>] [--config <recall.json>]
#
# --config defaults to $VC_EVAL_RECALL, then the gitignored eval/recall.local.json (copy
# eval/recall.example.json). Recall configs name private sessions, so they are never tracked.
#
# No tools are disallowed (a narrowed tools list breaks the scorer's fork); the recall prompt asks
# for memory only, and a recall turn that used a tool is scored as FAILED.
#
# The globally installed copy is disabled for the run with
#   --settings '{"enabledPlugins":{"verbatim-compaction@verbatim-compaction":false}}'
# and live-summary.ts reports which hooks.json actually loaded, so a run that silently used
# the wrong copy is visible.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TSX="$REPO/node_modules/.bin/tsx"

PLUGIN_DIR=""
N=1
SESSION=""
SETS=""
OPTIONS=""
OUT=""
CONFIG="${VC_EVAL_RECALL:-$HERE/recall.local.json}"
# No --disallowedTools: the scorer's fork resends the main thread's request, tools list included, and a
# narrowed list made forks fail with invalid_request (2/11 with the flag, 0/19 without). Every recall
# question is prefixed with RECALL_PREFIX instead, and live-summary.ts fails a recall that used a tool.
RECALL_PREFIX="Answer from memory only; do not use any tools. "

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --plugin-dir) PLUGIN_DIR="$2"; shift 2 ;;
    -n|--runs) N="$2"; shift 2 ;;
    --session) SESSION="$2"; shift 2 ;;
    --sets) SETS="$2"; shift 2 ;;
    --options) OPTIONS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --config) CONFIG="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "unknown argument: $1" >&2; usage 2 ;;
  esac
done

[ -n "$PLUGIN_DIR" ] || { echo "--plugin-dir is required" >&2; exit 2; }
[ -f "$CONFIG" ] || { echo "$CONFIG not found: copy eval/recall.example.json to eval/recall.local.json or pass --config" >&2; exit 2; }
PLUGIN_DIR="$(cd "$PLUGIN_DIR" && pwd)"
[ -f "$PLUGIN_DIR/hooks/hooks.json" ] || { echo "$PLUGIN_DIR has no hooks/hooks.json" >&2; exit 2; }
[[ "$N" =~ ^[0-9]+$ ]] && [ "$N" -ge 1 ] || { echo "-n must be a positive integer" >&2; exit 2; }
command -v claude >/dev/null || { echo "claude CLI not on PATH" >&2; exit 2; }

# Everything derived from the config goes through node, so JSON escaping is never done by hand.
eval "$(node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const q = (s) => "\x27" + String(s).replace(/\x27/g, "\x27\\\x27\x27") + "\x27";
  console.log(`CFG_SESSION=${q(c.session)}`);
  console.log(`CFG_CWD=${q(c.cwd)}`);
' "$CONFIG")"
SESSION="${SESSION:-$CFG_SESSION}"
CWD="$CFG_CWD"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${OUT:-$REPO/eval/out/live-$STAMP}"
mkdir -p "$OUT"

SETTINGS="$(node -e '
  const [options] = process.argv.slice(1);
  const s = { enabledPlugins: { "verbatim-compaction@verbatim-compaction": false } };
  if (options) {
    const o = JSON.parse(options);
    // The inline (--plugin-dir) copy reads its own key; set both so the options reach it.
    s.pluginConfigs = {
      "verbatim-compaction@verbatim-compaction": { options: o },
      "verbatim-compaction@inline": { options: o },
    };
  }
  console.log(JSON.stringify(s));
' "$OPTIONS")"

node -e '
  const [config, sets, prefix] = process.argv.slice(1);
  const c = JSON.parse(require("fs").readFileSync(config, "utf8"));
  const wanted = sets ? sets.split(",") : c.sets.map((s) => s.name);
  const line = (content) => JSON.stringify({ type: "user", message: { role: "user", content } });
  const out = [line("Reply with just: ok"), line("/compact")];
  for (const s of c.sets) if (wanted.includes(s.name)) out.push(line(prefix + s.question));
  if (out.length === 2) { console.error(`no recall set matches --sets ${sets}`); process.exit(2); }
  process.stdout.write(out.join("\n") + "\n");
' "$CONFIG" "$SETS" "$RECALL_PREFIX" > "$OUT/input.jsonl"

cat > "$OUT/meta.json" <<EOF
{"pluginDir": "$PLUGIN_DIR", "session": "$SESSION", "cwd": "$CWD", "runs": $N, "sets": "${SETS:-all}", "config": "$CONFIG", "started": "$STAMP", "settings": $SETTINGS}
EOF

echo "live eval: $N run(s), plugin $PLUGIN_DIR, session $SESSION -> $OUT"
for i in $(seq 1 "$N"); do
  start=$(date +%s)
  echo "run$i start $(date -u +%FT%TZ)"
  set +e
  (cd "$CWD" && claude -p --resume "$SESSION" --fork-session \
      --plugin-dir "$PLUGIN_DIR" --settings "$SETTINGS" \
      --input-format stream-json --output-format stream-json --verbose \
      --debug --debug-file "$OUT/run$i.debug.log" \
      < "$OUT/input.jsonl" > "$OUT/run$i.jsonl" 2> "$OUT/run$i.stderr")
  code=$?
  set -e
  echo "run$i exit=$code wall=$(( $(date +%s) - start ))s"
  echo "{\"run\": $i, \"exit\": $code, \"wallSec\": $(( $(date +%s) - start ))}" >> "$OUT/runs.jsonl"
done

"$TSX" "$HERE/live-summary.ts" "$OUT"
