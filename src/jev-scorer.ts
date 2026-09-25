import { stripCommandPrefix } from './rules-bash.js';
import { sliceWhole } from './text.js';
import type { ToolCall } from './types.js';

/**
 * The Jev-style question set, asked of a session fork instead of TypeSafe's
 * System One: for every candidate call Jev's two questions, whether the call
 * still matters and whether its result must stay verbatim, decided as Jev's
 * `decideCall` does (result → keep, else call → truncate, else drop).
 *
 * The answers come back as three JSON id lists, not as per-call scores. Live
 * on 2.1.281 the API rejected every fork asked for one line per call (`t12 93`
 * digit scores and `t12 K|T|D` letters alike: `api-error`, `invalid_request`,
 * no status, 0 output tokens) once there were 10 or more candidates, while the
 * same candidates under a JSON-lists reply passed at 10, 30 and 60. So Jev's
 * probabilities cannot be asked for; `keepThreshold` survives only as the
 * mapping of the `unsure` list (see `decide`). Pure functions only; running
 * the forks lives in claude-scorer.ts.
 */

/**
 * Most characters of a call's input shown on its candidate line. Long inputs drew safeguard
 * refusals: on 2.1.281 a refused fork surfaces as a status-less `invalid_request` (the engine's
 * lQe() turns `stop_reason: "refusal"` into an error frame), and the session's long Bash commands
 * (env loading, heredocs, credentialed curl) were what set it off. Live, on the pipeline's own
 * chunk prompts: inputs up to 400 chars 0/4 answered; 120 and 200 chars 16/16. 120 is the smaller
 * of the two that passed; `elideSecrets` removes the riskiest parts before the cut.
 */
export const INPUT_CHARS = 120;
/** Most characters of a result's head shown on its candidate line. */
export const PREVIEW_CHARS = 80;
/** Most candidates asked about in one fork; more are split over concurrent forks. */
export const DEFAULT_CHUNK_SIZE = 60;

export interface JevContext {
  /** Messages in the transcript, for the `msg i/N` position. */
  messageCount: number;
}

/** The fork's answer: which calls fall in each list. A call in none of them is kept. */
export interface JevAnswer {
  resultNeeded: Set<string>;
  callMatters: Set<string>;
  unsure: Set<string>;
  drop: Set<string>;
}

/**
 * Least share of a chunk's ids the four lists together must cover. A reply that sorts fewer
 * (a lazy "these 3 of 40 can go") is read as unparseable, so the chunk is retried and its calls
 * are kept, rather than treated as a complete answer.
 */
export const MIN_COVERAGE = 0.8;

export type JevAction = 'keep' | 'drop_result' | 'drop_call';

/** Cuts to at most `limit` chars with a trailing `…`, never splitting a surrogate pair. */
function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${sliceWhole(text, limit - 1)}…`;
}

const ENV_ASSIGNMENT = /(^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s;&|)]+)/g;
const HEADER = /(-H|--header)(\s+)(["'])([A-Za-z0-9-]+):[^"']*\3/g;
const HEREDOC = /<<-?\s*(["']?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g;

/**
 * A Bash command with the parts most likely to carry secrets reduced to their names: env
 * assignment values (`X=…`), HTTP header values (`-H 'Authorization: …'`) and heredoc bodies
 * (`<<EOF …>`). Data minimisation for the fork, which needs what a command did, not its payload.
 */
export function elideSecrets(command: string): string {
  return command
    .replace(HEREDOC, (_m, _q: string, tag: string) => `<<${tag} …>`)
    .replace(HEADER, (_m, flag: string, space: string, quote: string, name: string) => `${flag}${space}${quote}${name}: …${quote}`)
    .replace(ENV_ASSIGNMENT, (_m, lead: string, name: string) => `${lead}${name}=…`);
}

/**
 * Commands that reach another machine, the network, a container or a credentials file. Their
 * arguments (hosts, URLs, inline remote scripts, request fields) are what an ops-heavy session's
 * refused forks had in common, and the fork needs only what kind of command ran.
 */
const RISKY = /(?:^|[\s;&|(])(?:ssh|scp|curl|wget|docker|source)(?=\s|$)|\bgh\s+(?:api|pr\s+merge)\b|\bset\s+-a\b|(?:^|[;&|]\s*)\.\s+\S/;
const TOKEN = /'[^']*'|"(?:\\.|[^"\\])*"|&&|\|\||[;|]|[^\s;&|'"]+(?:'[^']*'|"(?:\\.|[^"\\])*"|[^\s;&|'"]+)*/g;
/** How many subcommand words each program keeps (`gh pr merge`, `docker exec`). */
const SUBCOMMANDS: Record<string, number> = { gh: 2, docker: 1, git: 1, npm: 1, kubectl: 1 };
/** Words kept wherever they stand: the interpreter an inline script ran under. */
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'node', 'python', 'python3']);
const HOST = /@|^\d{1,3}(?:\.\d{1,3}){3}(?::|$)/;
/** A dotted name before `:`, `/` or the end (`api.corp.test/v1`, `box.corp.test:/srv`), or `box:/srv`. */
const DOTTED_HOST = /^[\w-]+(?:\.[\w-]+)+(?=[:/]|$)|^[\w.-]+:/;
/** A path that says it is one: absolute, `./`, `../` or `~`. */
const EXPLICIT_PATH = /^(?:\/|\.{1,2}\/|~)/;
const PATH_LIKE = /\/|\.[A-Za-z]\w{0,4}$/;

interface SkeletonState {
  first: boolean;
  /** Subcommand words still to keep. */
  sub: number;
  program: string;
  subcommands: string[];
  /** A flag was seen in this segment: every positional after it is a value, unless an explicit path. */
  flagged: boolean;
  /** `gh api`'s endpoint was shown (as `<path>`). */
  pathShown: boolean;
}

/** A flag's name alone: `-uadmin:pw` is `-u`, `--user=admin` is `--user`, `+a` stays. */
function flagName(word: string): string {
  return word.startsWith('--') ? word.split('=')[0]! : word.slice(0, 2);
}

/** One word of a risky command as shown, or undefined to leave it out. */
function skeletonWord(word: string, state: SkeletonState): string | undefined {
  if (word.includes('://')) return '<url>';
  if (word.startsWith("'") || word.startsWith('"')) return "'…'";
  if (!state.first && /^[-+]/.test(word)) {
    state.sub = 0;
    state.flagged = true;
    return flagName(word);
  }
  if (HOST.test(word) || (!EXPLICIT_PATH.test(word) && DOTTED_HOST.test(word))) return '<host>';
  if (state.first) {
    state.first = false;
    state.program = word;
    state.sub = Object.hasOwn(SUBCOMMANDS, word) ? SUBCOMMANDS[word]! : 0;
    return word;
  }
  if (state.sub > 0 && !state.flagged && /^[a-z][a-z-]*$/.test(word)) {
    state.sub -= 1;
    state.subcommands.push(word);
    return word;
  }
  state.sub = 0;
  if (INTERPRETERS.has(word)) return word;
  // `gh api repos/org/repo/...` names a private org and repository.
  if (state.program === 'gh' && state.subcommands[0] === 'api' && !state.pathShown && word.includes('/')) {
    state.pathShown = true;
    return '<path>';
  }
  if (EXPLICIT_PATH.test(word)) return word.split('?')[0];
  // ssh's positionals are a host and an unquoted remote command; after a flag, a positional is its value.
  if (state.program === 'ssh' || state.flagged) return undefined;
  return PATH_LIKE.test(word) && !/['"]/.test(word) ? word.split('?')[0] : undefined;
}

/**
 * A refusal-prone command (see RISKY) cut to its program, subcommand, flag names and file paths:
 * quoted strings become `'…'`, URLs `<url>`, hosts (dotted names too) `<host>`, a `gh api` path
 * `<path>`; a flag keeps only its name, and every positional after a flag goes unless it is an
 * explicit path (`/`, `./`, `../`, `~`).
 * `ssh -F /dev/null me@10.1.2.3 'docker exec …'` becomes `ssh -F /dev/null <host> '…'`. Any
 * other command is returned unchanged.
 */
export function skeletonCommand(command: string): string {
  if (!RISKY.test(command)) return command;
  const fresh = (): SkeletonState => ({ first: true, sub: 0, program: '', subcommands: [], flagged: false, pathShown: false });
  let state = fresh();
  let out = '';
  for (const [word] of command.matchAll(TOKEN)) {
    if (word === ';') {
      out += ';';
      state = fresh();
      continue;
    }
    if (word === '&&' || word === '||' || word === '|') {
      out += ` ${word}`;
      state = fresh();
      continue;
    }
    const shown = skeletonWord(word, state);
    if (shown !== undefined) out += `${out ? ' ' : ''}${shown}`;
  }
  return out.trim();
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return '[unserializable input]';
  }
}

/** The call's input as `key=value` pairs; a Bash call shows its command alone (description dropped). */
function inputText(call: ToolCall): string {
  let entries: Array<[string, unknown]>;
  try {
    JSON.stringify(call.input);
    entries = Object.entries(call.input);
  } catch {
    return '[unserializable input]';
  }
  if (call.tool === 'Bash' && typeof call.input['command'] === 'string') {
    const others = entries.filter(([k]) => k !== 'command' && k !== 'description');
    const rest = others.map(([k, v]) => `${k}=${valueText(v)}`).join(' ');
    // Leading `cd DIR &&`, `VAR=value` and `echo "..."` banners carry nothing for the scorer.
    const command = skeletonCommand(elideSecrets(stripCommandPrefix(call.input['command']) || call.input['command']));
    return rest ? `${command} ${rest}` : command;
  }
  return entries.map(([k, v]) => `${k}=${valueText(v)}`).join(' ');
}

function oneLine(text: string): string {
  return text.replace(/\r?\n/g, '⏎').replace(/\s+/g, ' ').trim();
}

/** `t12 Bash msg 16/189 npm test → ok 4213ch ref-later:2 | PASS src/a.test.ts…` */
export function jevCandidateLine(call: ToolCall, ctx: JevContext): string {
  const parts = [
    `${call.id} ${call.tool} msg ${call.callIndex + 1}/${ctx.messageCount}`,
    clip(oneLine(inputText(call)), INPUT_CHARS),
    `→ ${call.isError ? 'error' : 'ok'} ${call.resultChars}ch`,
  ];
  if (typeof call.refLater === 'number' && call.refLater > 0) parts.push(`ref-later:${call.refLater}`);
  let line = parts.join(' ');
  const head = call.resultHead === undefined ? '' : oneLine(call.resultHead);
  if (head.length > 0) line += ` | ${clip(head, PREVIEW_CHARS)}`;
  return line;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `String.prototype.toWellFormed` (ES2024, past this build's lib): each lone surrogate becomes U+FFFD. */
export function toWellFormed(text: string): string {
  return text.replace(LONE_SURROGATE, '\uFFFD');
}

/**
 * The prompt for one fork. Every cut above keeps surrogate pairs whole, but a lone surrogate
 * can also arrive in the transcript itself (a tool input, a result head), and the API rejects a
 * request body carrying one, so the finished prompt is repaired as a last guard.
 */
export function buildJevPrompt(calls: readonly ToolCall[], ctx: JevContext): string {
  return toWellFormed([
    'Context maintenance request. Do not continue the task. Do not call any tool: none is available for this request. Answer directly, without deliberating.',
    'This conversation is about to be compacted. Below are earlier tool calls from it, one per line: id, tool, position (msg i/N), input, outcome and output size, ref-later:n when values its output introduced are used later, then the start of its output.',
    'Keep the call when its input still matters. Keep the result verbatim only when its exact text is still needed and re-running would not do. Prefer truncate over drop unless a later call superseded it.',
    'For every call answer two questions: must its RESULT stay verbatim, and does the CALL itself (knowing it was made, with its input) still matter? If you cannot tell, put it in unsure.',
    'Put every call in exactly one list: result_needed keeps it whole; call_matters and unsure keep the call and cut its output to its start; drop cuts its output to a one-line note. A call left out of every list is kept whole.',
    'Reply with the JSON object only, exactly this shape: {"result_needed":[],"call_matters":[],"unsure":[],"drop":[]}',
    '',
    ...calls.map((call) => jevCandidateLine(call, ctx)),
  ].join('\n'));
}

/** `t12` as written, or `12`: the prompt asks for bare numbers, which cost half the output tokens. */
function idOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  return Number.isSafeInteger(value) ? `t${value as number}` : undefined;
}

function idList(value: unknown, ids: ReadonlySet<string>): Set<string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const read = value.map(idOf);
  if (read.some((id) => id === undefined)) return undefined;
  return new Set((read as string[]).filter((id) => ids.has(id)));
}

/**
 * Parses the reply's JSON object (first `{` to last `}`). `result_needed` and `call_matters`
 * must be arrays of ids (`"t12"` or `12`), and `unsure` and `drop` too when present. Anything else, a cut-off reply
 * included, is undefined and decides nothing, as is a reply whose lists cover fewer than
 * MIN_COVERAGE of `ids`. Unknown ids are ignored.
 */
export function parseJevReply(text: string, ids: ReadonlySet<string>): JevAnswer | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const record = parsed as Record<string, unknown>;
  const optional = (key: string) => (record[key] === undefined ? new Set<string>() : idList(record[key], ids));
  const resultNeeded = idList(record['result_needed'], ids);
  const callMatters = idList(record['call_matters'], ids);
  const unsure = optional('unsure');
  const drop = optional('drop');
  if (!resultNeeded || !callMatters || !unsure || !drop) return undefined;
  const covered = new Set([...resultNeeded, ...callMatters, ...unsure, ...drop]);
  if (covered.size < MIN_COVERAGE * ids.size) return undefined;
  return { resultNeeded, callMatters, unsure, drop };
}

/**
 * What `unsure` becomes: `keepThreshold` is how sure a call must be to stay,
 * so a low one keeps the doubtful whole (< 0.5), the default truncates them
 * (0.5–0.75), a high one removes them (> 0.75).
 */
export function unsureAction(keepThreshold: number): JevAction {
  if (keepThreshold < 0.5) return 'keep';
  return keepThreshold <= 0.75 ? 'drop_result' : 'drop_call';
}

/**
 * Jev's decision per call: result_needed keeps, call_matters truncates, unsure follows
 * keepThreshold, drop drops, and a call in no list is kept. When lists overlap the one that
 * keeps more wins.
 */
export function decide(id: string, answer: JevAnswer, keepThreshold: number): JevAction {
  if (answer.resultNeeded.has(id)) return 'keep';
  const listed = answer.callMatters.has(id) || answer.unsure.has(id) || answer.drop.has(id);
  if (!listed) return 'keep';
  const unsure = answer.unsure.has(id) ? unsureAction(keepThreshold) : 'drop_call';
  if (unsure === 'keep') return 'keep';
  return answer.callMatters.has(id) ? 'drop_result' : unsure;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}
