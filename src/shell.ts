/**
 * Just enough shell parsing to classify a Bash command: steps separated by
 * `;`, `&&`, `||`, `&` or newlines, each a pipeline of stages, each stage a
 * list of words. Quotes and backslash escapes are honoured, so a `|` or `;`
 * inside a grep pattern stays in its word. Not a shell: expansions are left
 * as written, and anything this does not understand is the caller's cue to
 * treat the command as unknown.
 */

export interface Stage {
  /** Words with quotes removed. */
  words: string[];
  /** The stage's text with every quoted span emptied: what the shell sees as operators. */
  bare: string;
}

export type Step = Stage[];

export function parseCommand(command: string): Step[] {
  const steps: Step[] = [];
  let stages: Stage[] = [];
  let words: string[] = [];
  let bare = '';
  let word: string | undefined;
  let quote: '"' | "'" | undefined;

  const endWord = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  const endStage = () => {
    endWord();
    if (words.length > 0 || bare.trim().length > 0) stages.push({ words, bare: bare.trim() });
    words = [];
    bare = '';
  };
  const endStep = () => {
    endStage();
    if (stages.length > 0) steps.push(stages);
    stages = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) {
        quote = undefined;
        bare += ch;
      } else if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        word = (word ?? '') + command[i + 1]!;
        i += 1;
      } else {
        word = (word ?? '') + ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      word = word ?? '';
      bare += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') word = (word ?? '') + command[i + 1]!;
      bare += command[i + 1] === '\n' ? ' ' : `\\${command[i + 1]!}`;
      i += 1;
      continue;
    }
    const pair = command.slice(i, i + 2);
    if (pair === '&&' || pair === '||') {
      endStep();
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '\n' || (ch === '&' && command[i - 1] !== '>' && command[i + 1] !== '>')) {
      endStep();
      continue;
    }
    if (ch === '|') {
      endStage();
      continue;
    }
    bare += ch;
    if (/\s/.test(ch)) endWord();
    else word = (word ?? '') + ch;
  }
  endStep();
  return steps;
}
