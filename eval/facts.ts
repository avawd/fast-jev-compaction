/**
 * Fact extraction for the offline eval, ported from the effectiveness review
 * (scratchpad vc-effectiveness/analyze.ts) with two changes: every fact is
 * scored (no sampling), and token positions are computed once per segment.
 *
 * A "token" is a distinctive string (sha, #PR, Jira key, path, URL, 4+ digit
 * number, money, long identifier, uuid). A tool result INTRODUCES a token when
 * no earlier message holds it. Two fact sets come out of that:
 *  - never-echoed facts: introduced by an unpinned result, of a recall-worthy
 *    kind, and absent from every assistant text in the segment. Only the
 *    verbatim tool output carries them, so a compaction that drops the output
 *    loses them for good.
 *  - later-referenced tokens: introduced by an unpinned result and quoted by a
 *    LATER assistant text or tool input. Losing them from that result means the
 *    later reference points at nothing.
 */
import type { EvalMessage } from './parse.ts';

export const FACT_KINDS = new Set(['sha', 'pr', 'jira', 'num', 'money', 'url']);

const TOKEN_RES: Array<[string, RegExp]> = [
  ['uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g],
  ['sha', /\b[0-9a-f]{7,40}\b/g],
  ['pr', /#\d{2,6}\b/g],
  ['jira', /\b[A-Z]{2,6}-\d{2,6}\b/g],
  ['path', /(?:\/[\w.@\-[\]]+){2,}/g],
  ['url', /https?:\/\/[^\s"')\]>]+/g],
  ['num', /(?<![\w./-])\d{4,}(?![\w/-]|\.\d)/g], // a sentence-ending '.' still ends a number
  ['money', /\$[\d,]+(?:\.\d+)?/g],
  ['ident', /\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+){2,}\b|\b[a-zA-Z]+(?:_[a-zA-Z0-9]+){2,}\b/g],
];
const STOP = new Set(['toolu', 'tool_use_id', 'tool_result', 'system-reminder', 'file_path', 'old_string', 'new_string', 'replace_all']);
const MAX_MATCHES_PER_KIND = 5000;

/** Distinctive tokens of `text`, first kind wins. */
export function tokensOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [kind, re] of TOKEN_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(text)) && n < MAX_MATCHES_PER_KIND) {
      n += 1;
      const t = m[0];
      if (t.length < 4 || STOP.has(t) || out.has(t)) continue;
      if (kind === 'num' && /^(19|20)\d{2}$/.test(t)) continue; // years
      if (kind === 'sha' && (/^\d+$/.test(t) || !/\d/.test(t))) continue; // digit runs are 'num'; all-letter hex is a word
      if (kind === 'path' && t.length < 8) continue;
      out.set(t, kind);
    }
  }
  return out;
}

function inputText(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input);
  } catch {
    return '';
  }
}

export interface Fact {
  token: string;
  kind: string;
  tool_use_id: string;
  tool: string;
  /** Message index of the result that introduced it. */
  resultIndex: number;
}

export interface LaterRef {
  token: string;
  kind: string;
  tool_use_id: string;
  resultIndex: number;
  /** First later message index that quotes it (assistant text or tool input). */
  quotedAt: number;
}

export interface FactSets {
  neverEchoed: Fact[];
  laterReferenced: LaterRef[];
}

export interface UnpinnedCall {
  tool_use_id: string;
  tool: string;
  resultIndex: number;
}

/**
 * Computes both fact sets for the unpinned calls of one segment. `calls` come
 * from the plugin's own collectToolCalls, so "unpinned" is the branch's notion.
 */
export function factSets(messages: readonly EvalMessage[], calls: readonly UnpinnedCall[]): FactSets {
  const firstSeen = new Map<string, number>();
  const quoted = new Map<string, number[]>(); // assistant text or tool input
  const assistantText = new Set<string>();
  const resultTokens = new Map<string, Map<string, string>>(); // tool_use_id -> tokens

  messages.forEach((m, i) => {
    const note = (t: string) => {
      if (!firstSeen.has(t)) firstSeen.set(t, i);
    };
    const textTokens = tokensOf(m.text);
    for (const t of textTokens.keys()) {
      note(t);
      if (m.role === 'assistant') {
        assistantText.add(t);
        (quoted.get(t) ?? quoted.set(t, []).get(t)!).push(i);
      }
    }
    for (const u of m.toolUses) {
      for (const t of tokensOf(inputText(u.input)).keys()) {
        note(t);
        (quoted.get(t) ?? quoted.set(t, []).get(t)!).push(i);
      }
    }
    for (const r of m.toolResults ?? []) {
      const toks = tokensOf(r.text);
      resultTokens.set(r.tool_use_id, toks);
      for (const t of toks.keys()) note(t);
    }
  });

  // Assistant text can also carry a token as a substring of a longer one; test raw text too.
  const assistantBlob = messages.filter((m) => m.role === 'assistant').map((m) => m.text).join('\n');

  const neverEchoed: Fact[] = [];
  const laterReferenced: LaterRef[] = [];
  for (const c of calls) {
    const toks = resultTokens.get(c.tool_use_id);
    if (!toks) continue;
    for (const [token, kind] of toks) {
      if (firstSeen.get(token) !== c.resultIndex) continue;
      if (FACT_KINDS.has(kind) && !assistantText.has(token) && !assistantBlob.includes(token)) {
        neverEchoed.push({ token, kind, tool_use_id: c.tool_use_id, tool: c.tool, resultIndex: c.resultIndex });
      }
      const later = (quoted.get(token) ?? []).find((i) => i > c.resultIndex);
      if (later !== undefined) {
        laterReferenced.push({ token, kind, tool_use_id: c.tool_use_id, resultIndex: c.resultIndex, quotedAt: later });
      }
    }
  }
  return { neverEchoed, laterReferenced };
}

/** Every string a model would see in a message list, joined (text, tool inputs, outputs). */
export function contextBlob(messages: readonly EvalMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    parts.push(m.text);
    for (const u of m.toolUses) parts.push(inputText(u.input));
    for (const r of m.toolResults ?? []) parts.push(r.text);
  }
  return parts.join('\n');
}

/** tool_use_id -> the result text a compacted transcript still holds (absent = dropped). */
export function resultsById(messages: readonly EvalMessage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) for (const r of m.toolResults ?? []) out.set(r.tool_use_id, r.text);
  return out;
}

export interface Survival {
  neverEchoedSurvived: number;
  neverEchoedTotal: number;
  laterRefLost: number;
  laterRefTotal: number;
}

/**
 * How the fact sets fare in a compacted transcript. A never-echoed fact
 * survives if it appears anywhere in the context; a later-referenced token is
 * lost if the compacted copy of ITS result no longer holds it (the later quote
 * itself is untouched by compaction, so searching the whole context would
 * always find it).
 */
export function survival(facts: FactSets, compacted: readonly EvalMessage[]): Survival {
  const blob = contextBlob(compacted);
  const results = resultsById(compacted);
  let survived = 0;
  for (const f of facts.neverEchoed) if (blob.includes(f.token)) survived += 1;
  let lost = 0;
  for (const r of facts.laterReferenced) {
    const text = results.get(r.tool_use_id);
    if (text === undefined || !text.includes(r.token)) lost += 1;
  }
  return {
    neverEchoedSurvived: survived,
    neverEchoedTotal: facts.neverEchoed.length,
    laterRefLost: lost,
    laterRefTotal: facts.laterReferenced.length,
  };
}
