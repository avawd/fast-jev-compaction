import { describe, expect, it } from 'vitest';
import {
  applyRules,
  bashRules,
  isReadOnlyCommand,
  readonlyFamilyKey,
  sourceReadPaths,
  stripCommandPrefix,
  type ToolCall,
} from '../src/index.js';

let n = 0;
function c(tool: string, input: Record<string, unknown>, extra: Partial<ToolCall> = {}): ToolCall {
  n += 1;
  return {
    id: `t${n}`, tool_use_id: `u${n}`, tool, input, callIndex: n, resultIndex: n,
    resultChars: 1000, isError: false, pinned: false, resultText: 'x'.repeat(1000), ...extra,
  };
}
const bash = (command: string, extra: Partial<ToolCall> = {}) => c('Bash', { command }, extra);
function fresh(): void { n = 0; }

describe('stripCommandPrefix', () => {
  it('drops leading cd, env assignments and echo banners', () => {
    expect(stripCommandPrefix('cd /repo && git status')).toBe('git status');
    expect(stripCommandPrefix('cd /repo; FOO=1 BAR=x npm test')).toBe('npm test');
    expect(stripCommandPrefix('git log -3')).toBe('git log -3');
  });
});

describe('sourceReadPaths', () => {
  it('returns the files a pure read command reads, resolved against a leading cd', () => {
    expect(sourceReadPaths('cat src/a.ts')).toEqual(['src/a.ts']);
    expect(sourceReadPaths('cd /repo && sed -n 1,80p lib/x.ts')).toEqual(['/repo/lib/x.ts']);
    expect(sourceReadPaths('head -50 /abs/y.md | nl')).toEqual(['/abs/y.md']);
    expect(sourceReadPaths('grep -n foo src/a.ts; echo ===; tail -20 src/b.ts').sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('refuses anything that is not a pure read', () => {
    expect(sourceReadPaths('sed -i s/a/b/ src/a.ts')).toEqual([]);
    expect(sourceReadPaths('cat src/a.ts && npm test')).toEqual([]);
    expect(sourceReadPaths('npm test')).toEqual([]);
    expect(sourceReadPaths('cat > src/a.ts <<EOF')).toEqual([]);
    expect(sourceReadPaths('grep -rn foo src')).toEqual([]);
    // Every read step must name a file, or a later read of one file cannot stand in for it.
    expect(sourceReadPaths('cat a/x.ts; grep -rn foo lib')).toEqual([]);
    expect(sourceReadPaths('cat a/x.ts; ls lib')).toEqual([]);
  });
});

describe('isReadOnlyCommand', () => {
  it('accepts chains of reads, listings and searches, with or without file paths', () => {
    expect(isReadOnlyCommand('cd /r; grep -rn foo lib --include=*.ts | head; echo ---; wc -l a.ts; ls lib/core/ | head -40')).toBe(true);
    expect(isReadOnlyCommand('M=/x; grep -n foo $M/a.md')).toBe(true);
    expect(isReadOnlyCommand('find . -name "*.ts" | head')).toBe(true);
  });

  it('reads through quoted patterns that contain | ; > or $( )', () => {
    const cmd = 'cd /r; grep -n -B2 -A8 "type X\\|interface Y" lib/a.ts; echo; sed -n 1,200p lib/b.test.ts';
    expect(isReadOnlyCommand(cmd)).toBe(true);
    expect(sourceReadPaths(cmd).sort()).toEqual(['/r/lib/a.ts', '/r/lib/b.test.ts']);
    expect(isReadOnlyCommand(`grep -n "=> \\$(x)" a.ts`)).toBe(true);
    expect(isReadOnlyCommand(`grep -n -i -E "error|fail" "$TMPDIR/x.log" | grep -v -i "audit fix" | head -20`)).toBe(true);
  });

  it('does not mistake a grep pattern or a sed script for a file', () => {
    expect(sourceReadPaths('grep -n "foo.ts" lib/a.ts')).toEqual(['lib/a.ts']);
    expect(sourceReadPaths("sed -n '1,80p' lib/a.ts")).toEqual(['lib/a.ts']);
    expect(sourceReadPaths('grep -e x.ts -e y.ts lib/a.ts')).toEqual(['lib/a.ts']);
  });

  it('refuses writes, deletes, redirections and anything else', () => {
    expect(isReadOnlyCommand('find . -name x -delete')).toBe(false);
    expect(isReadOnlyCommand('find . -exec rm {} ;')).toBe(false);
    expect(isReadOnlyCommand('cat a.ts > b.ts')).toBe(false);
    expect(isReadOnlyCommand('ls && npm test')).toBe(false);
    expect(isReadOnlyCommand('python3 - <<EOF')).toBe(false);
    expect(isReadOnlyCommand('cat a.ts | sh')).toBe(false);
    expect(isReadOnlyCommand('grep x $(cat list)')).toBe(false);
    expect(isReadOnlyCommand('ls; rm -rf x')).toBe(false);
  });
});

describe('readonlyFamilyKey', () => {
  it('keys read-only commands by family and first argument', () => {
    expect(readonlyFamilyKey('cd /r && git status')).toBe('git status');
    expect(readonlyFamilyKey('git status --short')).toBe('git status');
    expect(readonlyFamilyKey('git log --oneline -5')).toBe('git log -5');
    expect(readonlyFamilyKey('git -C /r diff --stat main')).toBe('git diff --stat main');
    expect(readonlyFamilyKey('gh api "repos/o/r/actions/runs?branch=b" --jq .x')).toBe('gh api repos/o/r/actions/runs?branch=b --jq .x');
    expect(readonlyFamilyKey('gh pr view 12')).toBe('gh pr view 12');
    expect(readonlyFamilyKey('docker logs web --tail 50')).toBe('docker logs web --tail 50');
    expect(readonlyFamilyKey('ls -la src')).toBe('ls src');
    expect(readonlyFamilyKey('git --no-pager diff --stat')).toBe('git diff --stat');
    expect(readonlyFamilyKey('git worktree list | head -20')).toBe('git worktree list | head -20');
    expect(readonlyFamilyKey('sleep 30; gh run list')).toBe('gh run list');
  });

  it('tells apart commands that print different things (F3)', () => {
    for (const [a, b] of [
      ['gh pr view 123', 'gh pr view 456'], ['gh pr view 123 --json body', 'gh pr view 123'],
      ['gh run view 111 --log', 'gh run view 222'], ['gh pr checks 12', 'gh pr checks 34'],
      ['git log -20 --oneline', 'git log -1'], ['git diff', 'git diff --cached'], ['git diff HEAD~3', 'git diff HEAD~1'],
      ['git show abc123', 'git show def456'], ['git stash show 0', 'git stash show 1'],
      ['gh api repos/o/r/pulls/12', 'gh api repos/o/r/pulls/12/comments'],
      ['docker logs app --tail 50', 'docker logs app --tail 5'],
      ['git log --oneline -5 -- src/a.ts', 'git log --oneline -5 -- src/b.ts'], ['git log -n 5', 'git log -n 50'],
    ]) {
      expect(readonlyFamilyKey(a!), `${a} vs ${b}`).not.toBe(readonlyFamilyKey(b!));
    }
    expect(readonlyFamilyKey('git status')).toBe(readonlyFamilyKey('git status -sb'));
  });

  it('keeps a pipeline in the key so a different filter is a different command', () => {
    expect(readonlyFamilyKey('gh api x | jq .a')).not.toBe(readonlyFamilyKey('gh api x | jq .b'));
  });

  it('refuses chains and non-family commands', () => {
    expect(readonlyFamilyKey('git status && git push')).toBeUndefined();
    expect(readonlyFamilyKey('git commit -m x')).toBeUndefined();
    expect(readonlyFamilyKey('gh pr merge 610 --squash')).toBeUndefined();
    expect(readonlyFamilyKey('gh pr create --title x')).toBeUndefined();
    expect(readonlyFamilyKey('gh api repos/o/r/issues -f title=x')).toBeUndefined();
    expect(readonlyFamilyKey('gh api -X POST repos/o/r/dispatches')).toBeUndefined();
    expect(readonlyFamilyKey('gh run rerun 5')).toBeUndefined();
    expect(readonlyFamilyKey('git worktree remove x')).toBeUndefined();
    expect(readonlyFamilyKey('git stash pop')).toBeUndefined();
    expect(readonlyFamilyKey('npm test')).toBeUndefined();
  });
});

describe('bashRules', () => {
  it('drops the result of a Bash file read when the file is later Read, edited, or read again', () => {
    fresh();
    const calls = [
      bash('cd /repo && cat lib/a.ts'),
      c('Edit', { file_path: '/repo/lib/a.ts', old_string: 'a', new_string: 'b' }),
      bash('sed -n 1,40p lib/b.ts'),
      bash('sed -n 1,40p lib/b.ts'),
      bash('cat lib/c.ts'),
    ];
    const v = bashRules(calls, new Set());
    expect(v.get('t1')).toMatchObject({ action: 'drop_result', source: 'rule', rule: 'bash_read_superseded', evidence: 't2' });
    expect(v.get('t3')).toMatchObject({ action: 'drop_result', source: 'rule', rule: 'bash_read_superseded', evidence: 't4' });
    expect(v.has('t4')).toBe(false);
    expect(v.has('t5')).toBe(false);
  });

  it('supersedes a multi-file read only when every file is read again', () => {
    fresh();
    const calls = [bash('cat a/x.ts; cat a/y.ts'), c('Read', { file_path: 'a/x.ts' })];
    expect(bashRules(calls, new Set()).size).toBe(0);
    fresh();
    const both = [bash('cat a/x.ts; cat a/y.ts'), c('Read', { file_path: 'a/x.ts' }), c('Edit', { file_path: 'a/y.ts' })];
    expect(bashRules(both, new Set()).get('t1')?.rule).toBe('bash_read_superseded');
  });

  it('does not count a failed later touch as evidence', () => {
    fresh();
    const calls = [bash('cat a/x.ts'), c('Read', { file_path: 'a/x.ts' }, { isError: true })];
    expect(bashRules(calls, new Set()).size).toBe(0);
  });

  it('drops the older result of a read-only command re-run later', () => {
    fresh();
    const calls = [
      bash('git status'),
      bash('npm test'),
      bash('cd /r && git status --short'),
      bash('gh run list'),
    ];
    const v = bashRules(calls, new Set());
    expect(v.get('t1')).toMatchObject({ action: 'drop_result', source: 'rule', rule: 'readonly_superseded', evidence: 't3' });
    expect(v.size).toBe(1);
  });

  it('drops a read-only chain once every step of it has been re-run later, in any chain', () => {
    fresh();
    const calls = [
      bash('cd /r && git status --short && echo --- && git log --oneline -3'),
      bash('cd /r && git status && gh pr view 12'),
      bash('git log --oneline -3 && npm test'),
      bash('cd /r && git status && gh pr view 12'),
    ];
    const v = bashRules(calls, new Set());
    expect(v.get('t1')?.rule).toBe('readonly_superseded');
    expect(v.get('t2')?.rule).toBe('readonly_superseded');
    expect(v.has('t3')).toBe(false);
  });

  it('keeps a chain with a step that was not re-run', () => {
    fresh();
    const calls = [bash('git status && git diff main'), bash('git status')];
    expect(bashRules(calls, new Set()).size).toBe(0);
  });

  it('drops the result of agent launch boilerplate', () => {
    fresh();
    const calls = [
      c('Agent', { prompt: 'go' }, { resultText: 'Async agent launched successfully. agentId: a1 ...' }),
      c('Agent', { prompt: 'go' }, { resultText: 'The agent found three bugs ...' }),
      c('Task', { prompt: 'go' }, { resultText: 'Spawned successfully as worker-2' }),
    ];
    const v = bashRules(calls, new Set());
    expect(v.get('t1')?.rule).toBe('agent_boilerplate');
    expect(v.has('t2')).toBe(false);
    expect(v.get('t3')?.rule).toBe('agent_boilerplate');
  });

  it('never targets pinned, failed, already-decided calls or persisted-output wrappers', () => {
    fresh();
    const calls = [
      bash('git status', { pinned: true }),
      bash('git status', { isError: true }),
      bash('git status'),
      bash('git status', { resultText: '<persisted-output>\nOutput too large ...' }),
      bash('git status'),
    ];
    const v = bashRules(calls, new Set(['t3']));
    expect([...v.keys()]).toEqual([]);
  });
});

describe('bashRules: only a whole read is evidence (F1)', () => {
  const full = (label: string, later: ToolCall) => it(`a full read is superseded by ${label}`, () => {
    fresh();
    expect(bashRules([bash('cat src/a.ts'), later], new Set()).get('t1')?.rule).toBe('bash_read_superseded');
  });
  const partial = (label: string, later: () => ToolCall) => it(`a full read is NOT superseded by ${label}`, () => {
    fresh();
    const first = bash('cat src/a.ts');
    expect(bashRules([first, later()], new Set()).has('t1')).toBe(false);
  });
  full('an unranged Read', { ...c('Read', { file_path: 'src/a.ts' }), id: 't2' });
  full('an Edit', { ...c('Edit', { file_path: 'src/a.ts' }), id: 't2' });
  full('a later cat of the whole file', { ...bash('cat -n src/a.ts'), id: 't2' });
  partial('a ranged Read', () => c('Read', { file_path: 'src/a.ts', offset: 100, limit: 20 }));
  partial('a PDF page Read', () => c('Read', { file_path: 'src/a.ts', pages: '2' }));
  partial('wc -l', () => bash('wc -l src/a.ts'));
  partial('grep', () => bash('grep foo src/a.ts'));
  partial('head', () => bash('head -3 src/a.ts'));
  partial('sed -n', () => bash("sed -n '1,5p' src/a.ts"));
  partial('cat piped through head', () => bash('cat src/a.ts | head -5'));

  it('a partial read is superseded by an identical later command', () => {
    fresh();
    const v = bashRules([bash('cd /r && grep -n foo src/a.ts'), bash('cd /r; grep -n foo src/a.ts')], new Set());
    expect(v.get('t1')).toMatchObject({ rule: 'bash_read_superseded', evidence: 't2' });
    fresh();
    expect(bashRules([bash('cd /r && grep -n foo src/a.ts'), bash('cd /s && grep -n foo src/a.ts')], new Set()).size).toBe(0);
  });
});

describe('bashRules: paths resolve against the session cwd (F2)', () => {
  const at = (cwd: string) => (x: ToolCall): ToolCall => ({ ...x, cwd });
  it('does not cross worktrees when the cwd is known', () => {
    fresh();
    const calls = [bash('cat src/compact.ts'), c('Read', { file_path: '/other/worktree/src/compact.ts' })].map(at('/w/opt'));
    expect(bashRules(calls, new Set()).size).toBe(0);
    fresh();
    const same = [bash('cat src/compact.ts'), c('Read', { file_path: '/w/opt/src/compact.ts' })].map(at('/w/opt'));
    expect(bashRules(same, new Set()).get('t1')?.evidence).toBe('t2');
  });

  it('honours a leading cd, absolute or relative to the cwd', () => {
    fresh();
    expect(bashRules([bash('cd /a && cat x/README.md'), c('Read', { file_path: '/b/x/README.md' })].map(at('/w')), new Set()).size).toBe(0);
    fresh();
    expect(bashRules([bash('cd sub && cat x/R.md'), c('Read', { file_path: '/w/sub/x/R.md' })].map(at('/w')), new Set()).size).toBe(1);
  });

  it('never matches two different absolute paths by suffix', () => {
    fresh();
    expect(bashRules([bash('cat /a/x/README.md'), c('Read', { file_path: '/b/x/README.md' })], new Set()).size).toBe(0);
  });

  it('falls back to suffix matching only when no cwd is known', () => {
    fresh();
    expect(bashRules([bash('cat src/a.ts'), c('Read', { file_path: '/repo/src/a.ts' })], new Set()).size).toBe(1);
  });
});

describe('bashRules evidence', () => {
  it('names the nearest later call that re-read the file', () => {
    fresh();
    const calls = [bash('cat a/x.ts'), c('Read', { file_path: 'a/x.ts' }), c('Read', { file_path: 'a/x.ts' })];
    expect(bashRules(calls, new Set()).get('t1')).toEqual({
      action: 'drop_result', source: 'rule', rule: 'bash_read_superseded', evidence: 't2',
    });
  });

  it('names every call it relied on when several files or steps were covered by different calls', () => {
    fresh();
    const calls = [
      bash('cat a/x.ts; cat a/y.ts'), c('Read', { file_path: 'a/x.ts' }), c('Edit', { file_path: 'a/y.ts' }),
      bash('git status && git log'), bash('git log'), bash('git status'),
    ];
    const v = bashRules(calls, new Set());
    expect(v.get('t1')).toMatchObject({ evidence: 't2', moreEvidence: ['t3'] });
    expect(v.get('t4')).toMatchObject({ rule: 'readonly_superseded', evidence: 't6', moreEvidence: ['t5'] });
  });
});

describe('applyRules with the extra rules', () => {
  it('fills calls the core rules leave undecided and never overrides them', () => {
    fresh();
    const calls = [
      bash('git status', { isError: true }),
      bash('git status'),
      bash('git status'),
      c('mcp__r__createJiraIssue', {}, { resultChars: 5000 }),
    ];
    const v = applyRules(calls);
    expect(v.get('t1')?.rule).toBe('failed_then_fixed');
    expect(v.get('t2')?.rule).toBe('readonly_superseded');
    expect(v.has('t3')).toBe(false);
    expect(v.get('t4')?.rule).toBe('mcp_write_echo');
  });
});
