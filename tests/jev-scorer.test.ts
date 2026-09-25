import { describe, expect, it } from 'vitest';
import {
  elideSecrets, skeletonCommand, buildJevPrompt, chunk, collectToolCalls, decide, jevCandidateLine, parseJevReply, type ToolCall,
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

describe('skeletonCommand (refusal-prone commands)', () => {
  it('reduces remote, network, container and env-loading commands to program, subcommand, flags and paths', () => {
    expect(skeletonCommand("ssh -F /dev/null deploy@10.1.2.3 'cd /srv/app && docker exec app node -e \"x\"'"))
      .toBe("ssh -F /dev/null <host> '…'");
    expect(skeletonCommand('curl -s -H "Accept: json" "https://api.example.test/v1/items?token=abc"')).toBe("curl -s -H '…' <url>");
    expect(skeletonCommand('gh api -X PUT repos/o/r/pulls/922/merge -f merge_method=squash'))
      .toBe('gh api -X repos/o/r/pulls/922/merge -f');
    expect(skeletonCommand('set -a; . ./.env.local; set +a; gh pr merge 12 --squash'))
      .toBe('set -a; . ./.env.local; set +a; gh pr merge --squash');
    expect(skeletonCommand('ssh box.example.test uptime')).toBe('ssh');
    expect(skeletonCommand('scp build.tgz ops@host.example.test:/tmp/')).toBe('scp build.tgz <host>');
    expect(skeletonCommand("docker exec app-server sh -c 'grep -rl foo /app'")).toBe("docker exec sh -c '…'");
    expect(skeletonCommand('source ~/.profile && wget http://10.0.0.5:8080/x')).toBe('source ~/.profile && wget <url>');
  });

  it('leaves other commands alone', () => {
    for (const cmd of ['npm test', 'git log --oneline -5', 'grep -n "foo bar" src/a.ts', 'gh pr view 12']) {
      expect(skeletonCommand(cmd)).toBe(cmd);
    }
  });

  it('is what a candidate line shows for such a command', () => {
    const line = jevCandidateLine(c('t1', 'Bash', { command: 'ssh ops@10.9.8.7 "docker logs app | tail"' }), { messageCount: 5 });
    expect(line).toContain(" msg 16/5 ssh <host> '…' → ");
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

  it('shows a Bash command, cd prefix stripped, up to 120 chars (longer ones drew safeguard refusals live)', () => {
    const short = jevCandidateLine(c('t1', 'Bash', { command: 'cd /repo && npm test', description: 'run' }), ctx);
    expect(short).toContain(' npm test');
    expect(short).not.toContain('cd /repo');
    expect(short).not.toContain('description');
    const long = jevCandidateLine(c('t2', 'Bash', { command: `echo ${'x'.repeat(1000)}` }), ctx);
    const input = long.slice(long.indexOf('echo'), long.indexOf(' → '));
    expect(input.length).toBe(120);
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
  it('asks Jev\'s two questions with the policy text and the four-list JSON shape', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).toContain('Keep the call when its input still matters.');
    expect(prompt).toContain('Keep the result verbatim only when its exact text is still needed and re-running would not do.');
    expect(prompt).toContain('Prefer truncate over drop unless a later call superseded it.');
    expect(prompt).toContain('{"result_needed":[],"call_matters":[],"unsure":[],"drop":[]}');
    expect(prompt).toMatch(/^t1 Read msg 16\/5/m);
  });

  it('asks for lists, never a per-call line or number: the API refused that shape (probed live, 2.1.281)', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).not.toMatch(/one line per call|digit|0-9|END/);
  });

  it('says what each list does truthfully: nothing is "removed with its output", an unlisted call is kept', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).not.toMatch(/removed with its output/);
    expect(prompt).toContain('Put every call in exactly one list');
    expect(prompt).toContain('A call left out of every list is kept whole');
    expect(prompt).toMatch(/drop.*one-line note/);
  });

  it('asks for a direct answer without deliberation: thinking tokens are most of what a fork waits on', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).toMatch(/without deliberating/);
  });

  it('asks for the ids as written, not bare numbers (a first ask was refused with bare numbers asked for)', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).not.toMatch(/number alone/);
  });

  it('tells the fork not to call tools and to reply with the JSON only', () => {
    const prompt = buildJevPrompt([c('t1', 'Read', { file_path: 'a' })], { messageCount: 5 });
    expect(prompt).toContain('Do not call any tool');
    expect(prompt).toContain('Reply with the JSON object only');
  });
});

describe('parseJevReply', () => {
  const ids = new Set(['t1', 't2', 't3', 't4', 't5']);
  const all = '"result_needed":["t1"],"call_matters":["t2","t9"],"unsure":["t3"],"drop":["t4","t5"]';

  it('reads the four lists, ignoring unknown ids and prose around the object', () => {
    const out = parseJevReply(`Here:\n{${all}}\nok`, ids);
    expect(out && [...out.resultNeeded]).toEqual(['t1']);
    expect(out && [...out.callMatters]).toEqual(['t2']);
    expect(out && [...out.unsure]).toEqual(['t3']);
    expect(out && [...out.drop]).toEqual(['t4', 't5']);
  });

  it('treats missing unsure and drop lists as empty', () => {
    const out = parseJevReply('{"result_needed":["t1","t2"],"call_matters":["t3","t4","t5"]}', ids);
    expect(out?.unsure.size).toBe(0);
    expect(out?.drop.size).toBe(0);
  });

  it('rejects a lazy reply that sorts under 80% of the ids asked about (it would otherwise decide nothing for most)', () => {
    expect(parseJevReply('{"result_needed":[],"call_matters":[],"unsure":[],"drop":["t1","t2","t3"]}', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":["t1"],"call_matters":[],"unsure":[],"drop":["t2","t3","t4"]}', ids)).toBeDefined();
    const forty = new Set(Array.from({ length: 40 }, (_, i) => `t${i + 1}`));
    expect(parseJevReply('{"result_needed":[],"call_matters":["t1","t2","t3"],"unsure":[],"drop":[]}', forty)).toBeUndefined();
  });

  it('rejects anything that is not the full object: no JSON, a cut-off reply, a missing or mistyped list', () => {
    expect(parseJevReply('nope', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":["t1"],"call_matters":["t2"', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":["t1","t2","t3","t4"]}', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":"t1","call_matters":[]}', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":[],"call_matters":["t1","t2","t3","t4"],"drop":[true]}', ids)).toBeUndefined();
    expect(parseJevReply('{"result_needed":[],"call_matters":["t1","t2","t3","t4"],"drop":[1.5]}', ids)).toBeUndefined();
  });

  it('reads bare numbers as ids (12 is t12): half the output tokens of a quoted id', () => {
    const out = parseJevReply('{"result_needed":[1],"call_matters":[2,9],"unsure":["t3"],"drop":[4,5]}', ids);
    expect(out && [...out.resultNeeded]).toEqual(['t1']);
    expect(out && [...out.callMatters]).toEqual(['t2']);
    expect(out && [...out.unsure]).toEqual(['t3']);
    expect(out && [...out.drop]).toEqual(['t4', 't5']);
  });
});

describe('decide', () => {
  const answer = {
    resultNeeded: new Set(['t1', 't4']), callMatters: new Set(['t2', 't4', 't5']), unsure: new Set(['t3', 't4']),
    drop: new Set(['t5', 't6']),
  };

  it('result_needed keeps, call_matters truncates, drop drops, absent keeps; the list that keeps more wins an overlap', () => {
    expect(decide('t1', answer, 0.5)).toBe('keep');
    expect(decide('t2', answer, 0.5)).toBe('drop_result');
    expect(decide('t4', answer, 0.5)).toBe('keep');
    expect(decide('t5', answer, 0.5)).toBe('drop_result');
    expect(decide('t6', answer, 0.5)).toBe('drop_call');
    expect(decide('t9', answer, 0.5)).toBe('keep');
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

describe('elideSecrets (data minimisation for the fork)', () => {
  it('keeps env assignment names, not their values', () => {
    expect(elideSecrets('set -a; GH_TOKEN=$GITHUB_TOKEN gh api repos/x')).toBe('set -a; GH_TOKEN=… gh api repos/x');
    expect(elideSecrets('FOO="a b" BAR=\'c\' make')).toBe('FOO=… BAR=… make');
    expect(elideSecrets('npm test --reporter=dot')).toBe('npm test --reporter=dot');
  });
  it('keeps header names, not their values', () => {
    expect(elideSecrets(`curl -H 'Authorization: Bearer abc.def' -H "X-Api-Key: k1" https://h/x`))
      .toBe(`curl -H 'Authorization: …' -H "X-Api-Key: …" https://h/x`);
    expect(elideSecrets('curl --header "Cookie: s=1" u')).toBe('curl --header "Cookie: …" u');
  });
  it('replaces a heredoc body with a marker', () => {
    expect(elideSecrets("cat > f <<'EOF'\nsecret line\nmore\nEOF\necho done")).toBe("cat > f <<EOF …>\necho done");
    expect(elideSecrets('git commit -F - <<-END\nmsg\n\tEND')).toBe('git commit -F - <<END …>');
  });
  it('is applied to Bash candidate lines', () => {
    const line = jevCandidateLine(c('t1', 'Bash', { command: 'X_TOKEN=s3cr3t curl -H "Authorization: Bearer s3cr3t" u' }), { messageCount: 5 });
    expect(line).not.toContain('s3cr3t');
  });
});
