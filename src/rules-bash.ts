import { normalizePath } from './rules.js';
import { parseCommand, type Stage, type Step } from './shell.js';
import type { ToolCall, Verdict } from './types.js';

/** Commands that print (part of) a file. `sed` counts only with `-n` and without `-i`. */
const READ_COMMANDS = new Set(['cat', 'sed', 'head', 'tail', 'grep', 'rg', 'less', 'nl', 'wc']);
/** Commands that list or search without reading one file's content. */
const LIST_COMMANDS = new Set(['ls', 'find', 'tree', 'stat']);
/** Filters that may follow a read in a pipeline. */
const FILTER_COMMANDS = new Set(['sort', 'uniq', 'cut', 'tr', 'jq', 'column', 'head', 'tail', 'grep', 'rg', 'wc', 'nl', 'cat']);
/** `find` actions that write, delete or run something. */
const FIND_ACTIONS = /^-(?:delete|exec|execdir|ok|okdir|fprint\w*|fls)$/;
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const AGENT_BOILERPLATE = /Async agent launched successfully|Spawned successfully/;

/**
 * Read-only command families: the words that name one, and the subcommands
 * allowed (undefined = any). A family's key is these words plus the first
 * positional argument.
 */
const READONLY_FAMILIES: ReadonlyArray<{ words: readonly string[]; sub?: ReadonlySet<string> }> = [
  { words: ['git', 'status'] }, { words: ['git', 'log'] }, { words: ['git', 'diff'] },
  { words: ['git', 'branch'] }, { words: ['git', 'show'] },
  { words: ['git', 'rev-parse'] }, { words: ['git', 'rev-list'] },
  { words: ['git', 'worktree'], sub: new Set(['list']) }, { words: ['git', 'stash'], sub: new Set(['list', 'show']) },
  { words: ['gh', 'api'] },
  { words: ['gh', 'pr'], sub: new Set(['view', 'list', 'checks', 'diff', 'status']) },
  { words: ['gh', 'run'], sub: new Set(['view', 'list', 'watch']) },
  { words: ['docker', 'ps'] }, { words: ['docker', 'logs'] },
  { words: ['ls'] },
];
/** Flags that turn a read-only family member into a write. */
const WRITE_FLAGS = new Set([
  '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input',
  '-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '-u', '--set-upstream-to',
]);

/** The Bash command of a call, or '' for anything else. */
export function bashCommand(call: ToolCall): string {
  const command = call.tool === 'Bash' ? call.input['command'] : undefined;
  return typeof command === 'string' ? command : '';
}

const PREFIX = /^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:;|&&|\n)\s*|[A-Z_][A-Z0-9_]*=\S*\s+|echo\s+(?:"[^"]*"|'[^']*')\s*(?:;|&&|\n)\s*)/;

/** Drops leading `cd DIR &&`/`cd DIR;`, `VAR=value` assignments and `echo "..."` banners. */
export function stripCommandPrefix(command: string): string {
  let rest = command.trim();
  for (let i = 0; i < 8; i += 1) {
    const match = rest.match(PREFIX);
    if (!match) break;
    rest = rest.slice(match[0].length).trimStart();
  }
  return rest;
}

function leadingCd(steps: readonly Step[]): string | undefined {
  const first = steps[0]?.[0]?.words;
  const dir = first?.[0] === 'cd' && first.length === 2 ? first[1] : undefined;
  return dir && !dir.includes('$') && !dir.startsWith('~') ? dir : undefined;
}

const FILE_WORD = /^(?:\.{0,2}\/)?(?:[\w@.\-[\]]+\/)*[\w@.\-[\]]+\.[a-zA-Z]{1,6}$/;
/** Redirections that write nowhere: `2>&1`, `>/dev/null`. */
const HARMLESS_REDIRECT = /\d?>\s*&\d|\d?>\s*\/dev\/null|&>\s*\/dev\/null/g;

/** Expansion or redirection the shell performs outside quotes: the stage may do anything. */
function unsafe(stage: Stage): boolean {
  const bare = stage.bare.replace(/'[^']*'/g, "''");
  return /\$\(|`|<<|<\(/.test(bare) || bare.replace(HARMLESS_REDIRECT, '').includes('>');
}

function isNoop(stage: Stage): boolean {
  const first = stage.words[0] ?? '';
  return first === 'cd' || first === 'echo' || first === 'printf' || first === 'true' || first === 'sleep' ||
    (stage.words.length === 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first));
}

type StepKind = 'noop' | 'read' | 'list';

/** What one step (a pipeline) does, or undefined if it may do anything. */
function stepKind(step: Step): StepKind | undefined {
  if (step.some(unsafe)) return undefined;
  const [first, ...filters] = step;
  if (!first) return undefined;
  if (step.length === 1 && isNoop(first)) return 'noop';
  if (!filters.every((f) => FILTER_COMMANDS.has(f.words[0] ?? ''))) return undefined;
  const [command = '', ...args] = first.words;
  if (command === 'sed') return args.includes('-n') && !args.some((w) => w.startsWith('-i')) ? 'read' : undefined;
  if (READ_COMMANDS.has(command)) return 'read';
  if (command === 'find' && args.some((w) => FIND_ACTIONS.test(w))) return undefined;
  return LIST_COMMANDS.has(command) ? 'list' : undefined;
}

/** A command made only of file reads, listings and searches (cat, sed -n, grep, ls, find, wc...). */
export function isReadOnlyCommand(command: string): boolean {
  const kinds = parseCommand(command).map(stepKind);
  return kinds.length > 0 && kinds.every((k) => k !== undefined) && kinds.some((k) => k !== 'noop');
}

/** Flags whose next word is their value (a pattern, script, count), never a file operand. */
const VALUE_FLAGS = new Set(['-e', '-f', '--regexp', '--file', '--expression', '-A', '-B', '-C', '-m', '-n']);

/** The file operands of a read stage: positional words that look like files, minus a grep pattern or sed script. */
function filesOf(stage: Stage, cd: string | undefined): string[] {
  const [command = '', ...args] = stage.words;
  const operands: string[] = [];
  let explicitScript = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    // `sed -n` and `grep -n` take no value; every other VALUE_FLAG consumes the next word.
    if (VALUE_FLAGS.has(arg) && !(arg === '-n' && (command === 'sed' || command === 'grep' || command === 'rg'))) {
      if (arg === '-e' || arg === '-f' || arg.startsWith('--')) explicitScript = true;
      i += 1;
    } else if (!arg.startsWith('-')) {
      operands.push(arg);
    }
  }
  const scripted = command === 'grep' || command === 'rg' || command === 'sed';
  const files = scripted && !explicitScript ? operands.slice(1) : operands;
  return files
    .filter((w) => FILE_WORD.test(w))
    .map((raw) => normalizePath(cd && !raw.startsWith('/') ? `${cd}/${raw}` : raw));
}

/**
 * The files a Bash command only reads (every step is cat/sed -n/head/tail/
 * grep/rg/less/nl/wc naming a file, possibly piped through filters), relative
 * paths resolved against a leading `cd`. Empty when any step does something
 * else, lists or searches a directory, or names no file: then a later read of
 * those files could not stand in for the whole output.
 */
export function sourceReadPaths(command: string): string[] {
  const steps = parseCommand(command);
  const kinds = steps.map(stepKind);
  if (kinds.length === 0 || kinds.some((k) => k === undefined || k === 'list')) return [];
  const cd = leadingCd(steps);
  const perStep = steps.filter((_, i) => kinds[i] === 'read').map((step) => filesOf(step[0]!, cd));
  if (perStep.length === 0 || perStep.some((files) => files.length === 0)) return [];
  return [...new Set(perStep.flat())];
}

/** Drops git's global options (`-C dir`, `-c k=v`, `--no-pager`) from before the subcommand. */
function withoutGitGlobals(args: readonly string[]): string[] {
  let i = 0;
  while (i < args.length) {
    if (args[i] === '-C' || args[i] === '-c') i += 2;
    else if (args[i] === '--no-pager' || args[i] === '-P') i += 1;
    else break;
  }
  return args.slice(i);
}

/** `family firstArg[ | pipeline]` for one read-only step, or undefined. */
function stepFamilyKey(step: Step): string | undefined {
  if (step.some(unsafe)) return undefined;
  const [head, ...pipes] = step;
  let w = head!.words;
  if (w[0] === 'git') w = [w[0], ...withoutGitGlobals(w.slice(1))];
  const family = READONLY_FAMILIES.find((f) => f.words.every((word, i) => w[i] === word));
  if (!family) return undefined;
  const args = w.slice(family.words.length);
  if (args.some((a) => WRITE_FLAGS.has(a) || /^--method=/.test(a))) return undefined;
  const arg = args.find((x) => !x.startsWith('-'));
  if (family.sub && (!arg || !family.sub.has(arg))) return undefined;
  if (family.words.join(' ') === 'git branch' && arg) return undefined; // `git branch NAME` creates one
  const key = [...family.words, ...(arg ? [arg] : [])].join(' ');
  return pipes.length > 0 ? `${key} | ${pipes.map((p) => p.words.join(' ')).join(' | ')}` : key;
}

function workSteps(command: string): Step[] {
  return parseCommand(command).filter((step) => !(step.length === 1 && isNoop(step[0]!)));
}

/**
 * The family keys of a command made only of read-only steps (git status/log/
 * diff/branch/show, gh api/pr/run reads, docker ps/logs, ls), ignoring cd and
 * echo; undefined if any step is something else.
 */
export function readonlyStepKeys(command: string): string[] | undefined {
  const steps = workSteps(command);
  const keys = steps.map(stepFamilyKey);
  return keys.length > 0 && keys.every((k) => k !== undefined) ? (keys as string[]) : undefined;
}

/** `family firstArg[ | pipeline]` for a single read-only command; undefined for anything else, including chains. */
export function readonlyFamilyKey(command: string): string | undefined {
  const keys = readonlyStepKeys(command);
  return keys?.length === 1 ? keys[0] : undefined;
}

/** The family keys of whichever steps of any command are read-only: evidence of a newer output. */
function familyStepKeys(command: string): string[] {
  return workSteps(command).map(stepFamilyKey).filter((k): k is string => k !== undefined);
}

function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function isWrapper(call: ToolCall): boolean {
  return (call.resultText ?? '').startsWith('<persisted-output>');
}

function touchedPaths(call: ToolCall): string[] {
  if (call.tool === 'Read' || WRITE_TOOLS.has(call.tool)) {
    const p = call.input['file_path'] ?? call.input['notebook_path'];
    return typeof p === 'string' && p.length > 0 ? [normalizePath(p)] : [];
  }
  return sourceReadPaths(bashCommand(call));
}

/**
 * Verdicts for undecided calls: a Bash file read whose file is later Read,
 * written or read again (`bash_read_superseded`), a read-only command whose
 * every step is re-run later (`readonly_superseded`), and agent-launch boilerplate
 * (`agent_boilerplate`). Only successful later calls count as evidence.
 */
export function bashRules(calls: readonly ToolCall[], decided: ReadonlySet<string>): Map<string, Verdict> {
  const verdicts = new Map<string, Verdict>();
  const pathsLater: string[] = [];
  const familiesLater = new Set<string>();
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i]!;
    const command = bashCommand(call);
    const family = command ? readonlyStepKeys(command) : undefined;
    const reads = command ? sourceReadPaths(command) : [];
    if (!call.pinned && !call.isError && !decided.has(call.id) && !isWrapper(call)) {
      if (reads.length > 0 && reads.every((p) => pathsLater.some((q) => samePath(p, q)))) {
        verdicts.set(call.id, { action: 'drop_result', source: 'rule', rule: 'bash_read_superseded' });
      } else if (family && family.every((k) => familiesLater.has(k))) {
        verdicts.set(call.id, { action: 'drop_result', source: 'rule', rule: 'readonly_superseded' });
      } else if (AGENT_TOOLS.has(call.tool) && AGENT_BOILERPLATE.test((call.resultText ?? '').slice(0, 200))) {
        verdicts.set(call.id, { action: 'drop_result', source: 'rule', rule: 'agent_boilerplate' });
      }
    }
    if (!call.isError) {
      pathsLater.push(...touchedPaths(call));
      for (const key of familyStepKeys(command)) familiesLater.add(key);
    }
  }
  return verdicts;
}
