// Walks a transcript's parentUuid chain from its newest user/assistant row and reports, for the
// rows after the last compact_boundary, which tool_result rows still point at a PRE-boundary row
// (through parentUuid or sourceToolAssistantUUID) and whether the chain re-enters the old rows.
import { readFileSync } from 'node:fs';

const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const boundary = rows.findLastIndex((r) => r.subtype === 'compact_boundary');
const at = new Map(rows.filter((r) => r.uuid).map((r) => [r.uuid, rows.indexOf(r)]));
const isResult = (r) => r.type === 'user' && Array.isArray(r.message?.content) && r.message.content.some((c) => c.type === 'tool_result');
let stale = 0;
let fresh = 0;
for (const r of rows.slice(boundary + 1).filter(isResult)) {
  const src = at.get(r.sourceToolAssistantUUID);
  if (src !== undefined && src < boundary) stale += 1;
  else fresh += 1;
}
let i = rows.findLastIndex((r) => r.type === 'user' || r.type === 'assistant');
let reentry;
while (i !== undefined) {
  if (i < boundary && reentry === undefined) reentry = i;
  const p = rows[i].parentUuid;
  i = p ? at.get(p) : undefined;
}
console.log(JSON.stringify({ rows: rows.length, boundary, toolResultRowsAfterBoundary: { staleSource: stale, other: fresh }, chainReentersPreBoundaryAtRow: reentry ?? null }));
