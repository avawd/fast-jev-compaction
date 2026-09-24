/**
 * Seeded generators for the fuzz suites: engine-shaped transcripts (one row per content block,
 * each tool_result its own user row), and fork replies covering every way a fork has failed live.
 * Everything is driven by `rng(seed)`; nothing here reads Math.random or the clock, so a seed
 * reproduces exactly.
 */
import type { ForkFn, ForkReply, Message, ToolResult, ToolUse } from '../src/index.js';

export type Rng = () => number;

/** mulberry32. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, for seeding per-prompt reply choices independently of fork ordering. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h;
}

export const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
export const chance = (r: Rng, p: number): boolean => r() < p;

/** The engine's row, with the handle it carries on every message. */
export type Row = Message & { handle: string };

/** A later quote of a fact a result introduced: an assistant text row, or a tool_use's input. */
export type Quote = { token: string } & ({ kind: 'text'; row: Row } | { kind: 'tool'; useId: string });

export interface Transcript {
  messages: Row[];
  quotes: Quote[];
  cwd?: string;
  /** tool_use_ids of MCP results whose JSON holds a number literal JSON.stringify would rewrite. */
  exoticMcp: Set<string>;
  /** Env-assignment, header and heredoc values planted in Bash commands; no fork prompt may carry one. */
  secrets: string[];
}

const EMOJI = ['😀', '🎉', '𝔘', '🚀', '𠜎'];
const EXOTIC_NUMBERS = ['1.0', '1e5', '1E5', '12345678901234567890', '-0', '2.50', '1e400'];

/** Distinctive facts of every shape pin.ts looks for, unique per `n`. */
function fact(r: Rng, n: number): string {
  let hex = (0xa1b2c3d + n * 104729).toString(16);
  if (!/[a-f]/.test(hex)) hex += 'a';
  if (!/\d/.test(hex)) hex += '1';
  return pick(r, [
    `#${900 + n}`,
    `BST-${4400 + n}`,
    hex,
    `https://github.com/o/r/pull/${700 + n}`,
    `/srv/x/proj/lib/mod${n}.ts`,
    `${100000 + n * 13}`,
    `fetchUserRecord${n}Handler`,
  ]);
}

/**
 * Overwrites the two code units at `at` with an astral character when both are ASCII and outside
 * every fact, so a cut at `at + 1` would split a surrogate pair.
 */
function plantPair(text: string, at: number, facts: readonly string[], r: Rng): string {
  if (at < 0 || at + 2 > text.length) return text;
  if (text.charCodeAt(at) > 127 || text.charCodeAt(at + 1) > 127) return text;
  for (const f of facts) {
    for (let k = text.indexOf(f); k >= 0; k = text.indexOf(f, k + 1)) {
      if (k < at + 2 && at < k + f.length + 1) return text;
    }
  }
  return text.slice(0, at) + pick(r, EMOJI) + text.slice(at + 2);
}

const FILES = ['src/a.ts', 'src/b.ts', '/repo/src/a.ts', './src/b.ts', 'lib/x.log', 'README.md', '/repo/tasks/t1.output'];

/**
 * A command carrying a credential the way sessions do: an env assignment (leading, after `cd`,
 * mid-chain, exported, quoted), an Authorization header, or a heredoc body.
 */
function secretCommand(r: Rng, i: number, secrets: string[]): string {
  const s = `sk${(0x5eed00 + i * 7919 + secrets.length).toString(16)}Q${secrets.length}x`;
  secrets.push(s);
  return pick(r, [
    `API_KEY=${s} curl -s https://api.example.test/v1`,
    `curl -s -H 'Authorization: Bearer ${s}' https://api.example.test/v1/items`,
    `curl -H "Authorization: token ${s}" -H 'Accept: application/json' https://api.example.test/x`,
    `curl --header "Authorization: Basic ${s}" https://api.example.test/y`,
    `cd /repo && GITHUB_TOKEN=${s} gh api repos/o/r/pulls`,
    `npm run build && DEPLOY_KEY="${s} extra words" ./deploy.sh`,
    `export TOKEN=${s}; curl https://api.example.test/z`,
    `env PASSWORD='${s}' node seed.js`,
    `cat > .env <<EOF\nSECRET_VALUE=${s}\nEOF`,
    `cat > .env <<'EOF'\n${s}\nEOF\nnpm test`,
  ]);
}

function bashCommand(r: Rng, i: number, secrets: string[]): string {
  if (chance(r, 0.12)) return secretCommand(r, i, secrets);
  const file = () => pick(r, FILES);
  const cmd = pick(r, [
    'npm test', 'npm run build', 'npm run typecheck', 'git status', 'git log --oneline -5', 'git diff',
    `cat ${file()}`, `sed -n 1,80p ${file()}`, `grep -n foo ${file()}`, `head -50 ${file()}`,
    `cd /repo && cat ${file()}`, `cd src && cat a.ts`, `cd /repo && npm run typecheck`, `FOO=1 npm run build`,
    `cat ${file()} | head -20`, 'gh pr view 12', 'ls -la', `wc -l ${file()}`, 'git push origin x', `echo ${i}`,
    'rg -n "useState" src', 'docker ps', 'git worktree list', `cat > /tmp/x <<'EOF'\n${'h'.repeat(180)}\nEOF`,
  ]);
  // A command long enough to be clipped at INPUT_CHARS (120, formerly 200), with an astral char on the cut.
  if (chance(r, 0.05)) return `${cmd} # ${'c'.repeat(Math.max(0, pick(r, [116, 196]) - cmd.length))}${pick(r, EMOJI)} tail`;
  return cmd;
}

function lines(r: Rng, count: number, make: (k: number) => string): string {
  const out: string[] = [];
  for (let k = 0; k < count; k += 1) out.push(make(k));
  return out.join('\n');
}

/** A JSON body like an Atlassian MCP read, with furniture, an envelope, and optionally an exotic number. */
function mcpJson(r: Rng, i: number, f: string | undefined, exotic: boolean): string {
  const desc = lines(r, int(r, 5, 60), (k) => `Paragraph ${k} of issue ${i}: some words here.${chance(r, 0.1) ? ` ${pick(r, EMOJI)}` : ''}`);
  const body: Record<string, unknown> = {
    self: `https://j/rest/api/3/issue/${1000 + i}`,
    id: String(600000 + i),
    key: `BST-${4000 + i}`,
    expand: 'renderedFields,names',
    fields: {
      summary: `Do thing ${i}${f ? ` ${f}` : ''} ${pick(r, EMOJI)}`,
      description: desc,
      customfield_10001: null,
      customfield_10002: `val${i}`,
      story_points: exotic ? '__EXOTIC__' : int(r, 0, 13),
      ratio: chance(r, 0.5) ? 0.25 : 3,
      assignee: { avatarUrls: { '48x48': 'https://a/48' }, displayName: 'Andrew', self: chance(r, 0.3) },
      comments: Array.from({ length: int(r, 0, 3) }, (_, k) => ({ self: `https://j/c/${k}`, body: `comment ${k}`, iconUrl: 'https://i' })),
    },
  };
  if (chance(r, 0.7)) body['context'] = { invocationId: `inv${i}`, cloudId: 'c1' };
  else if (chance(r, 0.5)) body['context'] = 'plain data, not an envelope';
  const text = JSON.stringify(body, null, chance(r, 0.5) ? 2 : undefined);
  return exotic ? text.replace('"__EXOTIC__"', pick(r, EXOTIC_NUMBERS)) : text;
}

type Built = { text: string; exotic: boolean };

function resultFor(r: Rng, use: ToolUse, i: number, f: string | undefined): Built {
  const tool = use.tool;
  if (tool.startsWith('mcp__')) {
    if (chance(r, 0.1)) return { text: `Issue ${i} updated. ${f ?? ''}`, exotic: false };
    const exotic = chance(r, 0.25);
    return { text: mcpJson(r, i, f, exotic), exotic };
  }
  const size = chance(r, 0.04) ? int(r, 20_000, 60_000) : int(r, 0, 4000);
  let body: string;
  if (tool === 'Agent' && chance(r, 0.5)) body = `Async agent launched successfully. agentId: a${i}\n${'x'.repeat(800)}`;
  else if (tool === 'Read') body = lines(r, Math.ceil(size / 30), (k) => `${String(k + 1).padStart(6)}\tconst v${k} = ${k}; // src`);
  else if (tool === 'Grep') body = lines(r, Math.ceil(size / 25), (k) => `src/f${k % 7}.ts:${k + 1}: foo(bar)`);
  else body = lines(r, Math.ceil(size / 20), (k) => `log line ${k} of step ${i}`);
  // The fact at the start, in the middle, near a cut, or at the end.
  if (f) {
    const where = r();
    if (where < 0.25) body = `${f}\n${body}`;
    else if (where < 0.5) {
      const mid = body.indexOf('\n', Math.floor(body.length / 2));
      body = mid < 0 ? `${body}\n${f}` : `${body.slice(0, mid)}\n${f}${body.slice(mid)}`;
    } else if (where < 0.75) {
      // Straddling a head cut (100/200/300): the pin must stretch the window.
      const at = Math.min(body.length, Math.max(0, pick(r, [100, 200, 300]) - int(r, 1, f.length)));
      body = `${body.slice(0, at)} ${f} ${body.slice(at)}`;
    } else body = `${body}\n${f}`;
  }
  if (chance(r, 0.3)) body += `\n${pick(r, EMOJI).repeat(int(r, 1, 40))}`;
  if (chance(r, 0.4)) body += '\nTests: 3 passed, 1 failed\n✓ done';
  let text = body;
  const facts = f ? [f] : [];
  // Astral characters exactly on the cuts: heads at 100/200/300, a 1000-char tail.
  if (chance(r, 0.5)) {
    for (const cut of [100, 200, 300]) if (chance(r, 0.5)) text = plantPair(text, cut - 1, facts, r);
    if (chance(r, 0.5)) text = plantPair(text, text.length - 1001, facts, r);
  }
  return { text, exotic: false };
}

function inputFor(r: Rng, tool: string, i: number, secrets: string[]): Record<string, unknown> {
  switch (tool) {
    case 'Bash': return chance(r, 0.3) ? { command: bashCommand(r, i, secrets), description: 'run it' } : { command: bashCommand(r, i, secrets) };
    case 'Read': return chance(r, 0.3) ? { file_path: pick(r, FILES), offset: 10, limit: 20 } : { file_path: pick(r, FILES) };
    case 'Edit': return { file_path: pick(r, FILES), old_string: 'a', new_string: 'b' };
    case 'Write': return { file_path: pick(r, FILES), content: 'x'.repeat(int(r, 10, 400)) };
    case 'Grep': return { pattern: pick(r, ['foo', 'bar']), path: pick(r, ['src', '/repo/src']) };
    // Sometimes long, with an astral char straddling the INPUT_CHARS (120) cut.
    case 'Agent': return { prompt: chance(r, 0.3) ? `${'p'.repeat(int(r, 100, 125))}${pick(r, EMOJI)} look into it ${'q'.repeat(200)}` : 'look into it', subagent_type: 'Explore' };
    case 'mcp__claude_ai_Atlassian__getJiraIssue': return { cloudId: 'x', issueIdOrKey: `BST-${4000 + i}` };
    case 'mcp__claude_ai_Atlassian__editJiraIssue': return { cloudId: 'x', issueIdOrKey: `BST-${4000 + i}`, fields: { summary: 's' } };
    default: return { q: i };
  }
}

const TOOLS = [
  'Read', 'Read', 'Bash', 'Bash', 'Bash', 'Edit', 'Write', 'Grep', 'Agent',
  'mcp__claude_ai_Atlassian__getJiraIssue', 'mcp__claude_ai_Atlassian__editJiraIssue',
];

export interface GenOptions {
  /** Upper bound on turns; small for the hook fuzz. */
  maxTurns?: number;
}

/**
 * A transcript as Claude Code hands it to a hook: one row per content block (thinking, text,
 * each tool_use), each tool_result its own user row, a handle on every row. One seed in ten also
 * has merged rows (text and several tool_uses in one row, several results in one user row).
 */
export function genTranscript(seed: number, options: GenOptions = {}): Transcript {
  const r = rng(seed);
  let handle = 0;
  const row = (m: Message): Row => ({ ...m, handle: `h${handle++}` });
  const messages: Row[] = [row({ role: 'user', text: 'Start the task.', toolUses: [] })];
  const quotes: Quote[] = [];
  const exoticMcp = new Set<string>();
  const secrets: string[] = [];
  const introduced: string[] = [];
  const merged = chance(r, 0.1);
  let n = 0;
  const turns = int(r, 4, options.maxTurns ?? 60);
  for (let i = 0; i < turns; i += 1) {
    const uses: ToolUse[] = (chance(r, 0.2) ? [`u${i}a`, `u${i}b`] : [`u${i}`]).map((id) => {
      const tool = pick(r, TOOLS);
      return { tool_use_id: id, tool, input: inputFor(r, tool, i, secrets) };
    });
    if (chance(r, 0.4)) messages.push(row({ role: 'assistant', text: '', toolUses: [] })); // thinking
    const text = chance(r, 0.5) ? `Now step ${i}.` : '';
    if (merged && chance(r, 0.5)) {
      messages.push(row({ role: 'assistant', text: text || `Step ${i}.`, toolUses: uses }));
    } else {
      if (text) messages.push(row({ role: 'assistant', text, toolUses: [] }));
      for (const u of uses) messages.push(row({ role: 'assistant', text: '', toolUses: [u] }));
    }
    const results: ToolResult[] = uses.map((u) => {
      const f = chance(r, 0.6) ? fact(r, n++) : undefined;
      const built = resultFor(r, u, i, f);
      if (built.exotic) exoticMcp.add(u.tool_use_id);
      const result: ToolResult = { tool_use_id: u.tool_use_id, text: built.text };
      const err = r();
      if (err < 0.08) result.isError = true;
      else if (err < 0.9) result.isError = false; // else: absent, as older shapes had it
      if (f && built.text.includes(f)) introduced.push(f);
      return result;
    });
    if (merged && chance(r, 0.5)) messages.push(row({ role: 'user', text: '', toolUses: [], toolResults: results }));
    else for (const res of results) messages.push(row({ role: 'user', text: '', toolUses: [], toolResults: [res] }));

    if (introduced.length > 0 && chance(r, 0.5)) {
      const token = pick(r, introduced);
      const how = r();
      if (how < 0.4) {
        const q = row({ role: 'assistant', text: `Referring to ${token} now.`, toolUses: [] });
        messages.push(q);
        quotes.push({ token, kind: 'text', row: q });
      } else {
        const useId = `q${i}`;
        const tool = how < 0.7 ? 'Bash' : how < 0.85 ? 'Grep' : 'mcp__claude_ai_Atlassian__getJiraIssue';
        const input = tool === 'Bash' ? { command: `echo ${token}` } : tool === 'Grep' ? { pattern: token, path: 'src' } : { issueIdOrKey: token };
        messages.push(row({ role: 'assistant', text: '', toolUses: [{ tool_use_id: useId, tool, input }] }));
        messages.push(row({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: useId, text: `ok ${token}`, isError: false }] }));
        quotes.push({ token, kind: 'tool', useId });
      }
      // An Edit authoring the token is not a quote (pin.ts AUTHORING_TOOLS): its call may go.
      if (chance(r, 0.1)) {
        const useId = `e${i}`;
        messages.push(row({ role: 'assistant', text: '', toolUses: [{ tool_use_id: useId, tool: 'Edit', input: { file_path: 'src/a.ts', old_string: 'x', new_string: token } }] }));
        messages.push(row({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: useId, text: 'edited', isError: false }] }));
      }
    }
    if (chance(r, 0.15)) messages.push(row({ role: 'user', text: `user says ${i} ${chance(r, 0.3) ? pick(r, EMOJI) : ''}`, toolUses: [] }));
  }
  // A call still in flight at the end: no result yet.
  if (chance(r, 0.1)) messages.push(row({ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'inflight', tool: 'Bash', input: { command: 'npm test' } }] }));
  else messages.push(row({ role: 'user', text: 'Carry on.', toolUses: [] }));
  const cwd = chance(r, 0.5) ? '/repo' : undefined;
  return { messages, quotes, exoticMcp, secrets, ...(cwd ? { cwd } : {}) };
}

/** Ids listed in a scorer prompt's candidate lines. */
export function promptIds(prompt: string): string[] {
  return [...prompt.matchAll(/^(t\d+) /gm)].map((m) => m[1]!);
}

function validReply(r: Rng, ids: readonly string[]): string {
  const lists: Record<string, string[]> = { result_needed: [], call_matters: [], unsure: [], drop: [] };
  const keys = Object.keys(lists);
  for (const id of ids) if (chance(r, 0.95)) lists[pick(r, keys)]!.push(id);
  if (chance(r, 0.1)) lists['drop']!.push('t99999');
  if (chance(r, 0.1) && ids.length > 0) lists['result_needed']!.push(ids[0]!); // overlap: keeping wins
  if (chance(r, 0.2)) delete lists['unsure'];
  return JSON.stringify(lists);
}

export type ForkMode =
  | 'valid' | 'legacy' | 'prose' | 'lazy' | 'cutoff' | 'garbage' | 'badTypes' | 'refusal' | 'api529'
  | 'refusedFrame' | 'lazyUnder' | 'partialCover' | 'aborted' | 'emptyReply' | 'nothing' | 'weirdReason' | 'null' | 'syncThrow' | 'reject' | 'never' | 'late' | 'lateReject';

const SAFE_MODES: ForkMode[] = [
  'valid', 'valid', 'valid', 'valid', 'legacy', 'prose', 'lazy', 'lazyUnder', 'partialCover', 'cutoff', 'garbage',
  'badTypes', 'refusal', 'refusedFrame', 'refusedFrame',
  'api529', 'aborted', 'emptyReply', 'nothing', 'weirdReason', 'null', 'syncThrow', 'reject',
];
/** Modes that only settle through the timeout; offered only when one is set. */
const SLOW_MODES: ForkMode[] = ['never', 'late', 'lateReject'];

export interface FakeFork {
  fork: ForkFn;
  prompts: string[];
  /** Most forks started and not yet settled at any one time. */
  maxInFlight: () => number;
  /**
   * Ids some well-formed reply covering at least MIN_COVERAGE put in a cutting list: the only
   * ids a claude verdict may name. Lazy, cut-off, refused and garbage replies add none.
   */
  decidable: Set<string>;
}

/**
 * A fork whose reply is chosen by (seed, prompt, attempt), so concurrent chunks and retries get
 * the same replies on every run regardless of scheduling. `timed` allows replies that never
 * arrive or arrive after the deadline; `syncThrows` a fork that throws instead of rejecting.
 */
export function fakeFork(seed: number, timed: boolean, syncThrows = true): FakeFork {
  const attempts = new Map<string, number>();
  const prompts: string[] = [];
  const base = syncThrows ? SAFE_MODES : SAFE_MODES.filter((m) => m !== 'syncThrow');
  const modes = timed ? [...base, ...SLOW_MODES] : base;
  let inFlight = 0;
  let maxInFlight = 0;
  const decidable = new Set<string>();
  const accept = (json: string): string => {
    const lists = JSON.parse(json) as Record<string, string[] | undefined>;
    for (const key of ['call_matters', 'unsure', 'drop']) for (const id of lists[key] ?? []) decidable.add(id);
    return json;
  };
  const reply = (request: { prompt: string }): Promise<ForkReply> => {
    const prompt = request.prompt;
    const attempt = (attempts.get(prompt) ?? 0) + 1;
    attempts.set(prompt, attempt);
    prompts.push(prompt);
    const r = rng((hashString(prompt) ^ Math.imul(seed, 2654435761) ^ Math.imul(attempt, 40503)) >>> 0);
    const ids = promptIds(prompt);
    const mode = pick(r, modes);
    const answered = (text: string): ForkReply => ({ isAnswered: true, text });
    switch (mode) {
      case 'valid': return Promise.resolve(answered(accept(validReply(r, ids))));
      case 'legacy': return Promise.resolve({ text: accept(validReply(r, ids)) });
      case 'prose': return Promise.resolve(answered(`Sure, here it is:\n${accept(validReply(r, ids))}\nHope that helps {}`));
      case 'lazy': return Promise.resolve(answered(JSON.stringify({ result_needed: [], call_matters: [], drop: ids.slice(0, Math.floor(ids.length * 0.5)) })));
      case 'cutoff': { const v = validReply(r, ids); return Promise.resolve(answered(v.slice(0, int(r, 0, v.length - 1)))); }
      case 'garbage': return Promise.resolve(answered("I can't help with that request."));
      case 'badTypes': return Promise.resolve(answered('{"result_needed":[1,2],"call_matters":{},"drop":"t1"}'));
      // 2.1.281's safeguard refusal: a status-less api-error frame naming invalid_request.
      case 'refusedFrame': return Promise.resolve({ isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request' });
      // Sorts just under MIN_COVERAGE (80%) of the chunk: must read as unparseable and be retried.
      case 'lazyUnder': return Promise.resolve(answered(JSON.stringify({ result_needed: [], call_matters: [], unsure: [], drop: ids.slice(0, Math.max(0, Math.ceil(ids.length * 0.8) - 1)) })));
      // Sorts at least 80% and leaves the rest out: accepted, the unlisted calls kept.
      case 'partialCover': return Promise.resolve(answered(accept(JSON.stringify({ result_needed: [], call_matters: [], drop: ids.slice(0, Math.ceil(ids.length * 0.8)) }))));
      case 'refusal': return Promise.resolve({ isAnswered: false, reason: 'api-error', status: null });
      case 'api529': return Promise.resolve({ isAnswered: false, reason: 'api-error', status: 529 });
      case 'aborted': return Promise.resolve({ isAnswered: false, reason: 'aborted' });
      case 'emptyReply': return Promise.resolve({ isAnswered: false, reason: 'empty-reply' });
      case 'nothing': return Promise.resolve({ isAnswered: false, reason: 'nothing-to-fork' });
      case 'weirdReason': return Promise.resolve({ isAnswered: false, reason: 'something-new' });
      case 'null': return Promise.resolve(null);
      case 'syncThrow': throw new Error('fork threw synchronously');
      case 'reject': return Promise.reject(new Error('fork rejected'));
      case 'never': return new Promise<ForkReply>(() => {});
      case 'late': return new Promise((resolve) => setTimeout(() => resolve(answered(accept(validReply(r, ids)))), 5));
      case 'lateReject': return new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 5));
    }
  };
  const fork = ((request: { prompt: string }): Promise<ForkReply> => {
    const pending = reply(request); // a synchronous throw never started a fork
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const done = () => { inFlight -= 1; };
    pending.then(done, done);
    return pending;
  }) as ForkFn;
  return { fork, prompts, maxInFlight: () => maxInFlight, decidable };
}

export function wellFormed(s: string): boolean {
  return (s as string & { isWellFormed(): boolean }).isWellFormed();
}

/** How many seeds a fuzz suite runs: FUZZ_SEEDS, else `fallback`. */
export function seedCount(fallback: number): number {
  const n = Number(process.env['FUZZ_SEEDS']);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
