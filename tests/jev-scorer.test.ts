import { describe, expect, it } from 'vitest';
import {
  buildJevPrompt, chunk, collectToolCalls, decide, jevCandidateLine, parseJevReply, type ToolCall,
} from '../src/index.js';

function c(id: string, tool: string, input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
  return {
    id, tool_use_id: `u-${id}`, tool, input, callIndex: 15, resultIndex: 16, resultChars: 4213,
    isError: false, pinned: false, ...extra,
  };
}

describe('candidate command text', () => {
  const line = (command: string) => jevCandidateLine(c('t1', 'Bash', { command }), { messageCount: 5 });
  it('drops leading cd hops, env assignments and echo banners (rules-bash stripCommandPrefix)', () => {
    expect(line('cd /srv/repo && npm test')).toContain(' msg 16/5 npm test → ');
    expect(line('cd "/a b/c"; git status')).toContain(' msg 16/5 git status → ');
    expect(line('cd /a && FOO=1 npm run build')).toContain(' msg 16/5 npm run build → ');
  });
  it('keeps a command that is only a prefix, and a cd later in the command', () => {
    expect(line('cd /only')).toContain(' msg 16/5 cd /only → ');
    expect(line('npm test && cd /a')).toContain(' msg 16/5 npm test && cd /a → ');
  });
});

describe('jevCandidateLine', () => {
  const ctx = { messageCount: 189 };

  it('shows id, tool, 1-based position, input, outcome, size and a result preview', () => {
    const line = jevCandidateLine(
      c('t12', 'Read', { file_path: 'src/a.ts' }, { resultHead: 'export const a = 1;\nexport const b = 2;' }),
      ctx,
    );
    expect(line).toBe(
      't12 Read msg 16/189 file_path=src/a.ts → ok 4213ch | export const a = 1;⏎export const b = 2;',
    );
  });

  it('shows a Bash command, cd prefix stripped, up to 200 chars (longer ones drew safeguard refusals live)', () => {
    const short = jevCandidateLine(c('t1', 'Bash', { command: 'cd /repo && npm test', description: 'run' }), ctx);
    expect(short).toContain(' npm test');
    expect(short).not.toContain('cd /repo');
    expect(short).not.toContain('description');
    const long = jevCandidateLine(c('t2', 'Bash', { command: `echo ${'x'.repeat(1000)}` }), ctx);
    const input = long.slice(long.indexOf('echo'), long.indexOf(' → '));
    expect(input.length).toBe(200);
    expect(input.endsWith('…')).toBe(true);
  });

  it('flags errors, and shows ref-later from the referenced-later count', () => {
    const line = jevCandidateLine(
      c('t3', 'Grep', { pattern: 'foo' }, { isError: true, resultChars: 20, refLater: 2 }), { messageCount: 10 },
    );
    expect(line).toContain('→ error 20ch');
    expect(line).toContain('ref-later:2');
    expect(jevCandidateLine(c('t4', 'Grep', { pattern: 'foo' }, { refLater: 0 }), { messageCount: 10 }))
      .not.toContain('ref-later');
  });

  it('caps the preview at 80 chars and never ends it on a lone high surrogate', () => {
    const head = `${'a'.repeat(79)}😀tail`;
    const line = jevCandidateLine(c('t5', 'Read', { file_path: 'x' }, { resultHead: head }), ctx);
    const preview = line.slice(line.indexOf(' | ') + 3);
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(/[\uD800-\uDBFF]…?$/.test(preview)).toBe(false);
  });

  it('survives an unserialisable input', () => {
    const input: Record<string, unknown> = {};
    input['self'] = input;
    expect(jevCandidateLine(c('t6', 'X', input), ctx)).toContain('[unserializable input]');
  });
});

describe('buildJevPrompt', () => {
  it('asks Jev\'s two questions with the policy text and the JSON reply shape', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).toContain('Keep the call when its input still matters.');
    expect(prompt).toContain('Keep the result verbatim only when its exact text is still needed and re-running would not do.');
    expect(prompt).toContain('Prefer truncate over drop unless a later call superseded it.');
    expect(prompt).toContain('{"result_needed":[],"call_matters":[],"unsure":[]}');
    expect(prompt).toMatch(/^t1 Read msg 16\/5/m);
  });

  it('asks for lists, never a per-call line or number: the API rejects that shape (probed live, 2.1.281)', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).not.toMatch(/one line per call|digit|0-9|END/);
  });
});

describe('parseJevReply', () => {
  const ids = new Set(['t1', 't2', 't3', 't4']);

  it('reads the three lists, ignoring unknown ids and prose around the object', () => {
    const out = parseJevReply('Here:\n{"result_needed":["t1"],"call_matters":["t2","t9"],"unsure":["t3"]}\nok', ids);
    expect(out && [...out.resultNeeded]).toEqual(['t1']);
    expect(out && [...out.callMatters]).toEqual(['t2']);
    expect(out && [...out.unsure]).toEqual(['t3']);
  });

  it('treats a missing unsure list as empty', () => {
    expect(parseJevReply('{"result_needed":[],"call_matters":["t1"]}', ids)?.unsure.size).toBe(0);
  });

  it('rejects anything that is not the full object: no JSON, a cut-off reply, a missing or mistyped list', () => {
    expect(parseJevReply('nope', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":["t1"],"call_matters":["t2"', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":["t1"]}', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":"t1","call_matters":[]}', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":[],"call_matters":[],"unsure":[1]}', ids)).toBeUndefined();
  });
});

describe('decide', () => {
  const answer = {
    resultNeeded: new Set(['t1', 't4']), callMatters: new Set(['t2', 't4']), unsure: new Set(['t3', 't4']),
  };

  it('result_needed keeps, call_matters truncates, neither drops; the safer list wins an overlap', () => {
    expect(decide('t1', answer, 0.5)).toBe('keep');
    expect(decide('t2', answer, 0.5)).toBe('drop_result');
    expect(decide('t4', answer, 0.5)).toBe('keep');
    expect(decide('t9', answer, 0.5)).toBe('drop_call');
  });

  it('maps unsure through keepThreshold: below 0.5 keep, up to 0.75 truncate, above drop', () => {
    expect(decide('t3', answer, 0.3)).toBe('keep');
    expect(decide('t3', answer, 0.5)).toBe('drop_result');
    expect(decide('t3', answer, 0.75)).toBe('drop_result');
    expect(decide('t3', answer, 0.9)).toBe('drop_call');
  });
});

describe('chunk', () => {
  it('splits into pieces of at most size, in order', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 60)).toEqual([]);
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
  });
});

describe('resultHead', () => {
  it('is the first 200 chars of the paired result, for the preview', () => {
    const calls = collectToolCalls([
      { role: 'user', text: 'go', toolUses: [] },
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text: 'r'.repeat(500) }] },
    ], 0);
    expect(calls[0]?.resultHead).toBe('r'.repeat(200));
    expect(calls[0]?.resultChars).toBe(500);
  });
});

describe('well-formed prompts', () => {
  const EMOJI = '🚨'; // one astral char: two UTF-16 units
  const wellFormed = (s: string) => (s as string & { isWellFormed(): boolean }).isWellFormed();

  it('resultHead never ends on half a surrogate pair, whatever the cut', () => {
    for (let pad = 190; pad <= 202; pad += 1) {
      const text = `${'r'.repeat(pad)}${EMOJI.repeat(10)}`;
      const calls = collectToolCalls([
        { role: 'user', text: 'go', toolUses: [] },
        { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }] },
        { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'u1', text }] },
      ], 0);
      expect(wellFormed(calls[0]!.resultHead!)).toBe(true);
    }
  });

  it('every built prompt is well-formed for astral chars at every cut boundary', () => {
    for (let pad = 0; pad < 12; pad += 1) {
      const long = (n: number) => `${'x'.repeat(n - 6 + pad)}${EMOJI.repeat(8)}`;
      const calls = [
        c('t1', 'Bash', { command: long(200) }, { resultHead: long(80) }),
        c('t2', 'Read', { file_path: long(200) }, { resultHead: long(200) }),
        c('t3', 'Grep', { pattern: EMOJI }, { resultHead: `${'y'.repeat(pad)}${EMOJI}` }),
      ];
      expect(wellFormed(buildJevPrompt(calls, { messageCount: 9 }))).toBe(true);
    }
  });

  it('repairs a lone surrogate that reaches the prompt from anywhere (a final guard)', () => {
    const broken = c('t1', 'Read', { file_path: 'a\uD83D' }, { resultHead: '\uDEA8b' });
    const prompt = buildJevPrompt([broken], { messageCount: 3 });
    expect(wellFormed(prompt)).toBe(true);
    expect(prompt).toContain('a�');
  });
});
