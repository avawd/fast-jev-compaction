/**
 * One fuzz case end to end: options and scorer drawn from the seed, the real pipeline
 * (compact + makeScorer, or a raw random scorer), the engine-facing conversion
 * (toSessionMessages), and every transcript-integrity invariant checked against the input.
 * Returns the violations as strings; an empty list is a pass.
 */
import { toSessionMessages } from '../hooks/verbatim.ts';
import {
  annotateCalls, applyRules, INPUT_CHARS, MAX_CONCURRENT_FORKS, PREVIEW_CHARS, collectToolCalls, compact, makeScorer, resolveOptions, rulesGate, TRUNCATION_NOTE_PREFIX, protectRows,
  type CompactOptions, type CompactResult, type Message, type RuleName, type Scorer, type ScorerOptions, type Verdict,
} from '../src/index.js';
import { chance, fakeFork, genTranscript, int, pick, promptIds, rng, wellFormed, type Row, type Transcript } from './fuzz-gen.ts';

type SessionRow = Row & { toolResults?: Array<{ tool_use_id: string; text: string; isError?: boolean }> };

export interface CaseSetup {
  options: CompactOptions;
  /** 'claude' drives makeScorer with a fake fork; 'raw' a scorer returning random verdicts. */
  scorerKind: 'claude' | 'raw';
  timed: boolean;
}

export interface CaseRun {
  result: CompactResult;
  session: SessionRow[];
  prompts: string[];
  /** Most forks in flight at once (0 for the raw scorer). */
  maxInFlight: number;
  /** Ids an acceptable fork reply decided (see FakeFork.decidable); empty for the raw scorer. */
  decidable: Set<string>;
  setup: CaseSetup;
}

/**
 * fuzz-regressions.test.ts 'KNOWN BUG: half retries push concurrent forks past MAX_CONCURRENT_FORKS'.
 * Set false once it is fixed, so the fuzz holds the real cap again.
 */
const KNOWN_BUG_HALVES_EXCEED_CAP = false;

const RULES: RuleName[] = ['stale_read', 'repeated_search', 'failed_then_fixed', 'mcp_write_echo', 'bash_read_superseded', 'readonly_superseded', 'agent_boilerplate', 'stale_age'];

/** Random verdicts straight into compact(): pinned and unknown ids included, which it must ignore. */
function rawScorer(seed: number): Scorer {
  return async (calls) => {
    const r = rng(seed ^ 0x5bd1e995);
    const verdicts = new Map<string, Verdict>();
    for (const c of calls) {
      if (!chance(r, 0.7)) continue;
      const verdict: Verdict = { action: chance(r, 0.5) ? 'drop_call' : 'drop_result', source: chance(r, 0.5) ? 'claude' : 'rule' };
      if (verdict.source === 'rule') verdict.rule = pick(r, RULES);
      verdicts.set(c.id, verdict);
    }
    verdicts.set('t999999', { action: 'drop_call', source: 'claude' });
    return { verdicts, claude: 'ran' };
  };
}

function setupFor(seed: number, transcript: Transcript): CaseSetup {
  const r = rng(Math.imul(seed, 7) + 1);
  const options: CompactOptions = {
    preserveRecentMessages: int(r, 0, 8),
    truncateHeadChars: pick(r, [0, 100, 300]),
    truncateTailChars: pick(r, [0, 200, 1000]),
    staleAfterMessages: pick(r, [5, 20, 60, 100]),
    pinReferenced: chance(r, 0.9),
    stripMcpFurniture: chance(r, 0.85),
  };
  if (transcript.cwd) options.cwd = transcript.cwd;
  // Rider-carrying calls (riders.ts): a random share of the calls, kept whole.
  if (chance(r, 0.4)) {
    const ids = transcript.messages.flatMap((m) => m.toolUses.map((u) => u.tool_use_id));
    options.protectedResultIds = ids.filter(() => chance(r, 0.2));
  }
  return { options, scorerKind: chance(r, 0.7) ? 'claude' : 'raw', timed: chance(r, 0.75) };
}

/** Runs one case. `transcript` overrides the generated one (for minimising a failing seed). */
export async function runCase(seed: number, transcript: Transcript = genTranscript(seed)): Promise<CaseRun> {
  const setup = setupFor(seed, transcript);
  const r = rng(Math.imul(seed, 13) + 5);
  const input = transcript.messages;
  let scorer: Scorer;
  let prompts: string[] = [];
  let maxInFlight = () => 0;
  let decidable = new Set<string>();
  if (setup.scorerKind === 'raw') scorer = rawScorer(seed);
  else {
    const fake = fakeFork(seed, setup.timed);
    prompts = fake.prompts;
    maxInFlight = fake.maxInFlight;
    decidable = fake.decidable;
    const instant = chance(r, 0.15);
    const scorerOptions: ScorerOptions = {
      fork: fake.fork,
      useClaudeScorer: chance(r, 0.95),
      maxCandidates: pick(r, [3, 400]),
      chunkSize: pick(r, [1, 2, 5, 60]),
      keepThreshold: pick(r, [0.3, 0.5, 0.9]),
      messageCount: input.length,
    };
    if (setup.timed) {
      // The deadline lands after every microtask-settled fork and before any `late` one.
      scorerOptions.sleep = instant ? () => Promise.resolve() : () => new Promise<void>((resolve) => setImmediate(resolve));
      scorerOptions.claudeTimeoutMs = 1000;
      scorerOptions.claudeAwaitMs = 2000;
    }
    if (chance(r, 0.5)) scorerOptions.rulesClearGate = rulesGate(input, setup.options.truncateHeadChars ?? 300, 0.25);
    scorer = makeScorer(scorerOptions);
  }
  const result = await compact(input, scorer, setup.options);
  const session = toSessionMessages(input as never, result.messages) as unknown as SessionRow[];
  return { result, session, prompts, maxInFlight: maxInFlight(), decidable, setup };
}

/** Furniture removal as README describes it, written independently of rules-mcp.ts. */
function referenceStrip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(referenceStrip);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (['avatarUrls', 'expand', 'featureFlags', 'iconUrl'].includes(k)) continue;
    if (k === 'self' && typeof v === 'string' && /^https?:\/\//.test(v)) continue;
    if (v === null && /^customfield_\d+$/.test(k)) continue;
    out[k] = referenceStrip(v);
  }
  return out;
}

function referenceStripTop(value: unknown): unknown {
  const stripped = referenceStrip(value);
  if (stripped && typeof stripped === 'object' && !Array.isArray(stripped)) {
    const ctx = (stripped as Record<string, unknown>)['context'];
    if (ctx && typeof ctx === 'object' && ['invocationId', 'toolName', 'mcpClientName', 'cloudId'].some((k) => k in ctx)) {
      const { context: _drop, ...rest } = stripped as Record<string, unknown>;
      return rest;
    }
  }
  return stripped;
}

const isEmpty = (m: Message) => m.text.trim().length === 0 && m.toolUses.length === 0 && (m.toolResults ?? []).length === 0;

function rowText(m: Message): string {
  const parts = [m.text];
  for (const u of m.toolUses) parts.push(JSON.stringify(u.input));
  for (const res of m.toolResults ?? []) parts.push(res.text);
  return parts.join('\n');
}

/** The gap marker between excerpt pieces, as README describes it. */
const OMITTED = /\n\[… (\d+) chars omitted …\](?:\n|$)/g;

/**
 * Splits a truncated result into its kept head, the note's count, and what follows the note:
 * the tail, or (for an excerpted result) the kept pieces each with the gap skipped to reach it.
 * A piece of '' after the last gap means no tail was kept.
 */
function splitTruncated(text: string): { head: string; tail: string; omitted: number; pieces?: Array<{ gap: number; text: string }> } | undefined {
  const at = text.indexOf(TRUNCATION_NOTE_PREFIX);
  if (at < 0) return undefined;
  const close = text.indexOf(']', at);
  const omitted = Number(/truncated (\d+) chars/.exec(text.slice(at, close))?.[1]);
  const head = at === 0 ? '' : text.slice(0, at - 1);
  const tail = close + 1 < text.length ? text.slice(close + 2) : '';
  const rest = text.slice(close + 1);
  if (!rest.startsWith('\n[… ')) return { head, tail, omitted };
  const found = [...rest.matchAll(OMITTED)];
  const pieces = found.map((m, k) => ({
    gap: Number(m[1]),
    text: rest.slice(m.index! + m[0].length, found[k + 1]?.index ?? rest.length),
  }));
  return { head, tail, omitted, pieces };
}

/** Whether an excerpted result's pieces sit where the gaps say, ending at the source's end. */
function piecesFit(src: string, head: string, pieces: Array<{ gap: number; text: string }>, omitted: number): string | undefined {
  let at = head.length;
  let gaps = 0;
  for (const piece of pieces) {
    if (piece.gap <= 0) return `a gap of ${piece.gap}`;
    at += piece.gap;
    gaps += piece.gap;
    if (src.slice(at, at + piece.text.length) !== piece.text) return `a piece is not the source at offset ${at}`;
    at += piece.text.length;
  }
  if (at !== src.length) return `pieces end at ${at}, not ${src.length}`;
  if (gaps !== omitted) return `note says ${omitted} chars omitted, gaps sum to ${gaps}`;
  return undefined;
}

/** Every invariant of one run. */
export function checkCase(transcript: Transcript, run: CaseRun): string[] {
  const failures: string[] = [];
  const fail = (msg: string) => failures.push(msg);
  const input = transcript.messages;
  const { result, session, prompts, setup } = run;
  const resolved = resolveOptions(setup.options);
  const preserve = resolved.preserveRecentMessages;
  const inputSet = new Set<Message>(input);

  const sourceResult = new Map<string, { text: string; isError?: boolean }>();
  for (const m of input) for (const res of m.toolResults ?? []) sourceResult.set(res.tool_use_id, res);
  const inputUseIds = new Set(input.flatMap((m) => m.toolUses.map((u) => u.tool_use_id)));

  // 1. Pairing and order: every result's tool_use sits in an earlier row; every use whose result
  //    existed in the input still has it.
  const usePos = new Map<string, number>();
  session.forEach((m, k) => m.toolUses.forEach((u) => usePos.set(u.tool_use_id, k)));
  const resultPos = new Map<string, number>();
  session.forEach((m, k) => (m.toolResults ?? []).forEach((res) => {
    resultPos.set(res.tool_use_id, k);
    const p = usePos.get(res.tool_use_id);
    if (p === undefined) fail(`orphan tool_result ${res.tool_use_id}`);
    else if (p >= k) fail(`tool_result ${res.tool_use_id} at row ${k} not after its tool_use at ${p}`);
  }));
  for (const id of usePos.keys()) if (sourceResult.has(id) && !resultPos.has(id)) fail(`tool_use ${id} lost its tool_result`);
  for (const id of usePos.keys()) if (!inputUseIds.has(id)) fail(`tool_use ${id} was invented`);

  // 2. No empty rebuilt rows; a text-less assistant row (thinking) is followed by assistant content.
  session.forEach((m, k) => {
    if (!inputSet.has(m) && isEmpty(m)) fail(`rebuilt row ${k} is empty`);
    if (!m.role) fail(`row ${k} has no role`);
    if (isEmpty(m) && m.role === 'assistant') {
      const next = session[k + 1];
      if (!next || next.role !== 'assistant' || isEmpty(next)) fail(`thinking row ${k} lost its sibling content row`);
    }
  });

  // 3. First row and the preserved tail are the input's own objects.
  if (session[0] !== input[0]) fail('first row replaced');
  const tailIn = preserve === 0 ? [] : input.slice(-preserve);
  const tailOut = preserve === 0 ? [] : session.slice(-preserve);
  tailIn.forEach((m, i) => { if (tailOut[i] !== m) fail(`preserved tail row ${i} (${m.handle}) replaced`); });

  // 4. Text never edited, and rows without tool blocks are never removed or rebuilt.
  const plainIn = input.filter((m) => m.toolUses.length === 0 && (m.toolResults ?? []).length === 0);
  const plainSet = new Set<Message>(plainIn);
  const plainOut = session.filter((m) => plainSet.has(m));
  if (plainIn.length !== plainOut.length || plainIn.some((m, i) => plainOut[i] !== m)) fail('a plain text row was removed or rebuilt');
  const inText = input.map((m) => m.text).filter((t) => t.trim());
  const outText = session.map((m) => m.text).filter((t) => t.trim());
  if (inText.length !== outText.length || inText.some((t, i) => t !== outText[i])) fail('user/assistant text changed or dropped');

  // 4b. A protected call's rows (its tool_use and its tool_result) come back as the input's own objects.
  for (const id of setup.options.protectedResultIds ?? []) {
    for (const m of input) {
      const holds = m.toolUses.some((u) => u.tool_use_id === id) || (m.toolResults ?? []).some((x) => x.tool_use_id === id);
      if (holds && !session.includes(m as SessionRow)) fail(`protected call ${id}: its row ${m.handle} was rebuilt or dropped`);
    }
  }

  // 5. Well-formed UTF-16 everywhere the engine will serialise; rebuilt results carry a boolean isError.
  session.forEach((m, k) => {
    if (!wellFormed(rowText(m))) fail(`lone surrogate in row ${k}`);
    for (const res of m.toolResults ?? []) {
      const own = input.some((x) => (x.toolResults ?? []).includes(res as never));
      if (!own && typeof res.isError !== 'boolean') fail(`rebuilt result ${res.tool_use_id} isError is ${typeof res.isError}`);
    }
  });
  for (const p of prompts) if (!wellFormed(p)) fail('lone surrogate in a fork prompt');

  // 6. Never larger: in total, and per result.
  if (result.stats.charsAfter > result.stats.charsBefore) fail(`charsAfter ${result.stats.charsAfter} > charsBefore ${result.stats.charsBefore}`);
  for (const m of session) for (const res of m.toolResults ?? []) {
    const src = sourceResult.get(res.tool_use_id);
    if (src && res.text.length > src.text.length) fail(`result ${res.tool_use_id} grew ${src.text.length} → ${res.text.length}`);
  }

  // 7. Decisions agree with the output.
  const calls = annotateCalls(collectToolCalls(input, preserve, protectRows(input, setup.options.protectedResultIds ?? [])), input, resolved);
  const byId = new Map(calls.map((c) => [c.id, c]));
  const after = new Map<string, string>();
  for (const m of session) for (const res of m.toolResults ?? []) after.set(res.tool_use_id, res.text);
  for (const d of result.decisions) {
    const c = byId.get(d.id);
    if (!c) { fail(`decision for unknown call ${d.id}`); continue; }
    const src = sourceResult.get(c.tool_use_id)!.text;
    const out = after.get(c.tool_use_id);
    const mcp = c.tool.startsWith('mcp__');
    const exotic = transcript.exoticMcp.has(c.tool_use_id);
    if (c.pinned && (d.action !== 'keep' || d.source !== 'pinned')) fail(`pinned ${d.id} decided ${d.action}/${d.source}`);
    if (d.action === 'drop_call') {
      if (out !== undefined || usePos.has(c.tool_use_id)) fail(`drop_call ${d.id} still present`);
      if ((input[c.callIndex]?.text ?? '').trim().length === 0) fail(`drop_call ${d.id} on a text-less tool_use row`);
    } else if (out === undefined) fail(`${d.action} ${d.id} vanished`);
    else if (d.action === 'drop_result') {
      const parts = splitTruncated(out);
      if (!parts) fail(`drop_result ${d.id} has no truncation note`);
      else if (out.length >= src.length) fail(`drop_result ${d.id} did not shrink`);
      else if (!mcp || exotic || !resolved.stripMcpFurniture) {
        if (!src.startsWith(parts.head)) fail(`drop_result ${d.id} head is not the result's start`);
        if (parts.pieces) {
          const bad = piecesFit(src, parts.head, parts.pieces, parts.omitted);
          if (bad) fail(`drop_result ${d.id} excerpts: ${bad}`);
        } else {
          if (!src.endsWith(parts.tail)) fail(`drop_result ${d.id} tail is not the result's end`);
          if (parts.omitted !== src.length - parts.head.length - parts.tail.length) fail(`drop_result ${d.id} note says ${parts.omitted} chars omitted`);
        }
      }
      if (parts && (parts.pieces !== undefined) !== (d.windows !== undefined)) fail(`drop_result ${d.id} excerpts shown ${parts.pieces ? 'without' : 'for no'} windows`);
      // Windows: in order, disjoint, non-empty, and a real gap before each one.
      let last = 0;
      for (const [start, end] of d.windows ?? []) {
        if (!(start > last && end > start && end <= src.length)) fail(`drop_result ${d.id} window [${start}, ${end}) is out of order or empty`);
        last = end;
      }
      // Every later-quoted token the result carried survives a truncation.
      if (resolved.pinReferenced) {
        for (const token of c.refTokens ?? []) {
          if (src.includes(token) && !out.includes(token)) fail(`drop_result ${d.id} lost pinned token ${token}`);
        }
      }
    } else if (out !== src) {
      if (!mcp || !resolved.stripMcpFurniture) fail(`kept non-MCP ${d.id} text changed`);
      else if (exotic) fail(`kept MCP ${d.id} rewritten although it holds a number JSON.stringify would change`);
      else {
        try {
          const want = JSON.stringify(referenceStripTop(JSON.parse(src)));
          if (JSON.stringify(JSON.parse(out)) !== want) fail(`MCP strip of ${d.id} is not the source minus furniture`);
        } catch {
          fail(`MCP strip of ${d.id} is not valid JSON`);
        }
      }
    }
  }

  // 8. The fork is never asked about a pinned call, a rule's target, or a rule's evidence; and a
  //    claude verdict never lands on one.
  if (setup.scorerKind === 'claude') {
    const rules = applyRules(calls);
    const evidence = new Set([...rules.values()].flatMap((v) => [...(v.evidence ? [v.evidence] : []), ...(v.moreEvidence ?? [])]));
    for (const p of prompts) for (const id of promptIds(p)) {
      if (evidence.has(id)) fail(`evidence call ${id} offered to the fork`);
      if (rules.has(id)) fail(`rule-decided call ${id} offered to the fork`);
      if (byId.get(id)?.pinned) fail(`pinned call ${id} offered to the fork`);
    }
    for (const d of result.decisions) if (d.source === 'claude' && evidence.has(d.id)) fail(`claude verdict on evidence call ${d.id}`);
    // The concurrency cap: whole-then-half retries included, never more than MAX_CONCURRENT_FORKS at once.
    // While KNOWN_BUG_HALVES_EXCEED_CAP stands, only the bug's own worst case (every chunk split) is held.
    const cap = KNOWN_BUG_HALVES_EXCEED_CAP ? 2 * MAX_CONCURRENT_FORKS : MAX_CONCURRENT_FORKS;
    if (run.maxInFlight > cap) fail(`${run.maxInFlight} forks in flight at once (cap ${cap})`);
    // A claude cut comes only from an acceptable reply: never from a lazy (under 80%), cut-off,
    // refused or garbage one. (A pin may still turn it into a keep, never the other way.)
    for (const d of result.decisions) {
      if (d.source === 'claude' && d.action !== 'keep' && !run.decidable.has(d.id)) fail(`claude ${d.action} on ${d.id}, which no acceptable reply decided`);
    }
    // Retries, where no deadline can cut them short: a refused first ask of 2+ calls splits into two
    // halves at once; any other refused, api-error, unparseable or empty first ask is re-asked whole
    // once, a failed whole re-ask of 2+ calls splits into two halves, and nothing else is re-asked.
    if (!setup.timed) {
      const retryable = (st: string) => st === 'refused' || st === 'api-error' || st === 'unparseable' || st === 'empty';
      const runs = result.stats.forks ?? [];
      for (let k = 0; k < runs.length; k += 1) {
        const first = runs[k]!;
        if (first.retry) continue;
        if (first.status === 'refused' && first.candidates >= 2) {
          const halves = runs.slice(k + 1, k + 3).filter((x) => x.retry === 'half');
          if (runs[k + 1]?.retry === 'whole' || halves.length !== 2) fail(`fork ${k} (refused, ${first.candidates}) was not split at once`);
          continue;
        }
        const whole = runs[k + 1]?.retry === 'whole' ? runs[k + 1] : undefined;
        if (retryable(first.status) !== (whole !== undefined)) fail(`fork ${k} (${first.status}) ${whole ? 'was' : 'was not'} re-asked whole`);
        if (!whole) continue;
        const halves = runs.slice(k + 2, k + 4).filter((x) => x.retry === 'half');
        const split = retryable(whole.status) && whole.candidates >= 2;
        if (split !== (halves.length === 2)) fail(`fork ${k} whole re-ask (${whole.status}, ${whole.candidates}) ${halves.length ? 'was' : 'was not'} split`);
      }
    }
    // Candidate lines: the input is cut to INPUT_CHARS and the preview to PREVIEW_CHARS.
    const LINE = /^(t\d+) \S+ msg \d+\/\d+ (.*?) ?→ (?:ok|error) \d+ch(?: ref-later:\d+)?(?: \| (.*))?$/;
    for (const p of prompts) for (const line of p.split('\n').filter((l) => /^t\d+ /.test(l))) {
      const m = LINE.exec(line);
      if (!m) { fail(`unreadable candidate line: ${line.slice(0, 120)}`); continue; }
      if (m[2]!.length > INPUT_CHARS) fail(`${m[1]} input shown as ${m[2]!.length} chars (cap ${INPUT_CHARS})`);
      if ((m[3] ?? '').length > PREVIEW_CHARS) fail(`${m[1]} preview shown as ${m[3]!.length} chars (cap ${PREVIEW_CHARS})`);
      // A command that reaches a host, the network or a container shows no host, address or URL.
      const command = byId.get(m[1]!)?.input['command'];
      if (typeof command === 'string' && /(^|[\s;&|(])(ssh|scp|curl|wget|docker)(\s|$)/.test(command) && /:\/\/|@|\b\d{1,3}(\.\d{1,3}){3}\b|\[[0-9A-Fa-f]*:[0-9A-Fa-f:]*\]/.test(m[2]!)) {
        fail(`${m[1]} shows a host, address or URL of a remote command: ${m[2]}`);
      }
      // ...nor a flag's value (attached, `=`-joined or the next word, unless an explicit path) or a dotted host name.
      if (typeof command === 'string' && /(^|[\s;&|(])(ssh|scp|curl|wget|docker)(\s|$)|\bgh\s+(api|pr\s+merge)\b/.test(command)) {
        const shown = new Set(m[2]!.split(/\s+/));
        const raw = command.split(/\s+/).filter((w) => !/['";&|]/.test(w));
        const explicitPath = (w: string) => /^(\/|\.{1,2}\/|~)/.test(w);
        raw.forEach((w, k) => {
          if (/^-[^-]./.test(w) || (w.startsWith('--') && w.includes('='))) {
            if (shown.has(w)) fail(`${m[1]} shows the flag value in ${w}`);
          }
          const next = raw[k + 1];
          if (/^-/.test(w) && next !== undefined && !next.startsWith('-') && !explicitPath(next) && command.includes(`${w} ${next}`) && shown.has(next)) {
            fail(`${m[1]} shows ${next}, the value after ${w}`);
          }
        });
        for (const word of shown) {
          if (!explicitPath(word) && /^[\w-]+(\.[\w-]+)+([:/]|$)/.test(word)) fail(`${m[1]} shows the host-like word ${word}`);
        }
      }
    }
    // Every candidate belongs to exactly one chunk: a prompt either opens a chunk with ids no
    // earlier prompt had, or re-asks a subset of exactly one earlier chunk (whole or half).
    const chunkOf = new Map<string, number>();
    let chunks = 0;
    for (const p of prompts) {
      const ids = promptIds(p);
      if (new Set(ids).size !== ids.length) fail('a prompt lists an id twice');
      const owners = new Set(ids.map((id) => chunkOf.get(id)));
      if (owners.size === 1 && owners.has(undefined)) { chunks += 1; for (const id of ids) chunkOf.set(id, chunks); }
      else if (owners.size !== 1) fail(`a prompt mixes ids of ${[...owners].map((o) => o ?? 'new').join('/')} chunks`);
    }
    // A chunk's half re-asks are two, disjoint, and together the whole chunk.
    const members = new Map<number, string[]>();
    for (const [id, c] of chunkOf) members.set(c, [...(members.get(c) ?? []), id]);
    for (const [c, ids] of members) {
      const halves = prompts.map(promptIds).filter((p) => p.length < ids.length && p.every((id) => chunkOf.get(id) === c));
      if (halves.length === 0) continue;
      const union = halves.flat();
      if (halves.length !== 2 || new Set(union).size !== union.length || union.length !== ids.length) {
        fail(`chunk ${c} (${ids.length} calls) re-asked as parts of ${halves.map((h) => h.length).join('+')}`);
      }
    }
  }
  // Every call has exactly one outcome.
  const decided = result.decisions.map((d) => d.id);
  if (new Set(decided).size !== decided.length) fail('a call has two decisions');
  if (decided.length !== calls.length || calls.some((c) => !decided.includes(c.id))) fail(`${calls.length} calls but ${decided.length} decisions`);
  if (setup.scorerKind === 'claude') {
    // Elision: no env-assignment value, header value or heredoc body from a Bash command reaches a fork.
    for (const p of prompts) for (const secret of transcript.secrets) if (p.includes(secret)) fail(`fork prompt carries secret ${secret}`);
  }

  // 9. A fact a result introduced and a later row quotes is still in the context before the quote.
  if (resolved.pinReferenced) {
    for (const q of transcript.quotes) {
      const at = q.kind === 'text' ? session.indexOf(q.row as SessionRow) : usePos.get(q.useId) ?? -1;
      if (at < 0) {
        if (q.kind === 'text') fail(`quoting row for ${q.token} vanished`);
        continue; // The quoting call itself was dropped: nothing quotes the token any more.
      }
      const before = session.slice(0, at).map(rowText).join('\n');
      if (!before.includes(q.token)) fail(`later-quoted ${q.token} (quoted at row ${at}) is gone from the context before it`);
    }
  }
  return failures;
}

/** What must be identical between two runs of one seed (timings excluded). */
export function fingerprint(run: CaseRun): string {
  const { ms: _ms, claudeMs: _c, forks, ...stats } = run.result.stats;
  return JSON.stringify({
    messages: run.session,
    decisions: run.result.decisions,
    stats,
    forks: forks?.map(({ ms: _f, ...rest }) => rest),
    prompts: [...run.prompts].sort(),
  });
}
