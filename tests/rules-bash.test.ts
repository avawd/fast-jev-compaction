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
    expect(readonlyFamilyKey('git log --oneline -5')).toBe('git log');
    expect(readonlyFamilyKey('git -C /r diff --stat main')).toBe('git diff main');
    expect(readonlyFamilyKey('gh api "repos/o/r/actions/runs?branch=b" --jq .x')).toBe('gh api repos/o/r/actions/runs?branch=b');
    expect(readonlyFamilyKey('gh pr view 12')).toBe('gh pr view');
    expect(readonlyFamilyKey('docker logs web --tail 50')).toBe('docker logs web');
    expect(readonlyFamilyKey('ls -la src')).toBe('ls src');
    expect(readonlyFamilyKey('git --no-pager diff --stat')).toBe('git diff');
    expect(readonlyFamilyKey('git worktree list | head -20')).toBe('git worktree list | head -20');
    expect(readonlyFamilyKey('sleep 30; gh run list')).toBe('gh run list');
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
      bash('sed -n 40,80p lib/b.ts'),
      bash('cat lib/c.ts'),
    ];
    const v = bashRules(calls, new Set());
    expect(v.get('t1')).toEqual({ action: 'drop_result', source: 'rule', rule: 'bash_read_superseded' });
    expect(v.get('t3')).toEqual({ action: 'drop_result', source: 'rule', rule: 'bash_read_superseded' });
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
    expect(v.get('t1')).toEqual({ action: 'drop_result', source: 'rule', rule: 'readonly_superseded' });
    expect(v.size).toBe(1);
  });

  it('drops a read-only chain once every step of it has been re-run later, in any chain', () => {
    fresh();
    const calls = [
      bash('cd /r && git status --short && echo --- && git log --oneline -3'),
      bash('cd /r && git status && gh pr view 12'),
      bash('git log -5 && npm test'),
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
