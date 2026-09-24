import { describe, expect, it } from 'vitest';
import {
  runFork, scoreWithClaude, selectCandidates,
  type ClaudeScoreOptions, type ForkFn, type ToolCall,
} from '../src/index.js';

function c(id: string, tool: string, input: Record<string, unknown>, resultChars = 100, isError = false): ToolCall {
  return { id, tool_use_id: `u-${id}`, tool, input, callIndex: 1, resultIndex: 2, resultChars, isError, pinned: false };
}

const calls = [
  c('t1', 'Read', { file_path: 'src/a.ts' }, 4213),
  c('t2', 'Bash', { command: 'x'.repeat(500) }, 20, true),
  c('t3', 'Grep', { pattern: 'foo' }, 900),
];

const opts = (extra: Partial<ClaudeScoreOptions> = {}): ClaudeScoreOptions => ({
  maxCandidates: 400, keepThreshold: 0.5, chunkSize: 60, context: { messageCount: 10 }, ...extra,
});

const reply = (lists: { result_needed?: string[]; call_matters?: string[]; unsure?: string[] }) =>
  JSON.stringify({ result_needed: [], call_matters: [], unsure: [], ...lists });

/** Ids listed in a prompt's candidate lines. */
function idsIn(prompt: string): string[] {
  return [...prompt.matchAll(/^(t\d+) /gm)].map((m) => m[1]!);
}

describe('selectCandidates', () => {
  it('caps by largest results and keeps transcript order', () => {
    const many = [c('t1', 'A', {}, 5), c('t2', 'B', {}, 50), c('t3', 'C', {}, 500)];
    expect(selectCandidates(many, 2).map((x) => x.id)).toEqual(['t2', 't3']);
    expect(selectCandidates(many, 5)).toHaveLength(3);
  });
});

describe('scoreWithClaude', () => {
  it('turns the lists into Jev decisions: needed keeps, matters truncates, neither drops', async () => {
    const fork: ForkFn = async () => ({ text: reply({ result_needed: ['t3'], call_matters: ['t1'] }) });
    const out = await scoreWithClaude(fork, calls, opts());
    expect(out.status).toBe('ran');
    expect(out.verdicts.get('t1')).toEqual({ action: 'drop_result', source: 'claude' });
    expect(out.verdicts.get('t2')).toEqual({ action: 'drop_call', source: 'claude' });
    expect(out.verdicts.has('t3')).toBe(false);
    expect(out.forks).toHaveLength(1);
  });

  it('maps unsure through keepThreshold', async () => {
    const fork: ForkFn = async () => ({ text: reply({ result_needed: ['t2', 't3'], unsure: ['t1'] }) });
    expect((await scoreWithClaude(fork, calls, opts({ keepThreshold: 0.3 }))).verdicts.has('t1')).toBe(false);
    expect((await scoreWithClaude(fork, calls, opts())).verdicts.get('t1')?.action).toBe('drop_result');
    expect((await scoreWithClaude(fork, calls, opts({ keepThreshold: 0.9 }))).verdicts.get('t1')?.action).toBe('drop_call');
  });

  it('reads the 2.1.281 answered shape', async () => {
    const fork: ForkFn = async () => ({ isAnswered: true, text: reply({ result_needed: ['t1', 't3'] }), usage: {} } as never);
    const out = await scoreWithClaude(fork, calls, opts());
    expect(out.status).toBe('ran');
    expect(out.verdicts.get('t2')?.action).toBe('drop_call');
  });

  it('splits candidates into chunks, runs the forks concurrently and merges their answers', async () => {
    const many = Array.from({ length: 130 }, (_, i) => c(`t${i + 1}`, 'Bash', { command: `echo ${i}` }));
    const prompts: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fork: ForkFn = async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 3) release();
      await gate; // resolves only once all three forks have started: proves they are concurrent
      return { text: reply({ call_matters: idsIn(prompt) }) };
    };
    const out = await scoreWithClaude(fork, many, opts({ chunkSize: 60 }));
    expect(prompts.map((p) => idsIn(p).length)).toEqual([60, 60, 10]);
    expect(out.verdicts.size).toBe(130);
    expect([...out.verdicts.values()].every((v) => v.action === 'drop_result')).toBe(true);
    expect(out.status).toBe('ran');
    expect(out.forks.map((f) => f.candidates)).toEqual([60, 60, 10]);
  });

  it('applies the chunks that answered and reports partial when others fail; a failed chunk keeps its calls', async () => {
    const many = Array.from({ length: 4 }, (_, i) => c(`t${i + 1}`, 'Bash', { command: `echo ${i}` }));
    const fork: ForkFn = async ({ prompt }) =>
      idsIn(prompt).includes('t1') ? { text: reply({}) } : { text: '{"result_needed":["t3"],"call_ma' };
    const out = await scoreWithClaude(fork, many, opts({ chunkSize: 2 }));
    expect(out.status).toBe('partial');
    expect([...out.verdicts.keys()]).toEqual(['t1', 't2']);
    // the failed chunk was retried as two halves, which failed the same way
    expect(out.forks.map((f) => `${f.candidates} ${f.status}${f.retry ? ' retry' : ''}`))
      .toEqual(['2 ran', '2 unparseable', '1 unparseable retry', '1 unparseable retry']);
  });

  it('retries a chunk the API rejected as two concurrent halves, once', async () => {
    const many = Array.from({ length: 4 }, (_, i) => c(`t${i + 1}`, 'Bash', { command: `echo ${i}` }));
    const sizes: number[] = [];
    const fork: ForkFn = async ({ prompt }) => {
      const ids = idsIn(prompt);
      sizes.push(ids.length);
      if (ids.length === 4) return { isAnswered: false, reason: 'api-error', status: null } as never;
      if (ids.includes('t3')) return { text: '{"result_needed":["t3"' }; // one half still fails: no deeper retry
      return { text: reply({ call_matters: ids }) };
    };
    const out = await scoreWithClaude(fork, many, opts());
    expect(sizes).toEqual([4, 2, 2]);
    expect([...out.verdicts.keys()]).toEqual(['t1', 't2']);
    expect(out.status).toBe('partial');
    expect(out.forks).toEqual([
      { candidates: 4, ms: expect.any(Number), status: 'api-error' },
      { candidates: 2, ms: expect.any(Number), status: 'ran', retry: true },
      { candidates: 2, ms: expect.any(Number), status: 'unparseable', retry: true },
    ]);
  });

  it('does not retry a timeout, an abort, a missing fork, or a single-call chunk', async () => {
    for (const answer of [{ isAnswered: false, reason: 'aborted' }, { isAnswered: false, reason: 'nothing-to-fork' }]) {
      let n = 0;
      await scoreWithClaude((async () => { n += 1; return answer; }) as unknown as ForkFn, calls, opts());
      expect(n).toBe(1);
    }
    let m = 0;
    await scoreWithClaude(async () => { m += 1; return { text: 'nope' }; }, [calls[0]!], opts());
    expect(m).toBe(1);
    const timedOut = await scoreWithClaude(() => new Promise(() => {}), calls, opts({ timeout: { timeoutMs: 1, sleep: async () => {} } }));
    expect(timedOut.forks).toHaveLength(1);
  });

  it('reports the failure itself when every fork fails', async () => {
    expect((await scoreWithClaude(async () => null, calls, opts())).status).toBe('null');
    expect((await scoreWithClaude(async () => ({ text: 'nope' }), calls, opts())).status).toBe('unparseable');
    const boom: ForkFn = async () => { throw new Error('api down'); };
    const out = await scoreWithClaude(boom, calls, opts());
    expect(out.status).toBe('error');
    expect(out.verdicts.size).toBe(0);
  });

  it.each([
    [{ isAnswered: false, reason: 'nothing-to-fork' }, 'no-fork'],
    [{ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded' }, 'api-error 529'],
    [{ isAnswered: false, reason: 'api-error', status: null, error: 'invalid_request' }, 'api-error'],
    [{ isAnswered: false, reason: 'aborted' }, 'aborted'],
    [{ isAnswered: false, reason: 'empty-reply' }, 'empty'],
    [{ isAnswered: false, reason: 'some-future-reason' }, 'error'],
  ])('labels the unanswered 2.1.281 shape %j as %s, never unparseable', async (answer, status) => {
    const fork = (async () => answer) as unknown as ForkFn;
    const out = await scoreWithClaude(fork, calls, opts());
    expect(out.status).toBe(status);
    expect(out.verdicts.size).toBe(0);
  });

  it('skips the fork when there is nothing to score', async () => {
    let called = false;
    const out = await scoreWithClaude(async () => { called = true; return null; }, [], opts());
    expect(called).toBe(false);
    expect(out.status).toBe('skipped');
    expect(out.forks).toEqual([]);
  });

  it('gives every fork one shared deadline: a single sleep, status timeout', async () => {
    const many = Array.from({ length: 5 }, (_, i) => c(`t${i + 1}`, 'Bash', { command: `echo ${i}` }));
    const waited: number[] = [];
    const sleep = async (ms: number) => { waited.push(ms); };
    const out = await scoreWithClaude(() => new Promise(() => {}), many, opts({
      chunkSize: 2, timeout: { timeoutMs: 6000, sleep },
    }));
    expect(out.status).toBe('timeout');
    expect(out.verdicts.size).toBe(0);
    expect(waited).toEqual([6000]);
    expect(out.forks).toHaveLength(3); // a timeout is never retried
  });

  it('uses the reply when the fork answers before the timeout', async () => {
    const fork: ForkFn = async () => ({ text: reply({}) });
    const out = await scoreWithClaude(fork, calls, opts({ timeout: { timeoutMs: 6000, sleep: () => new Promise(() => {}) } }));
    expect(out.status).toBe('ran');
  });

  it('treats a reply without string text as empty, not unparseable', async () => {
    const bad = (async () => ({})) as unknown as ForkFn;
    expect((await scoreWithClaude(bad, calls, opts())).status).toBe('empty');
  });

  it('times each fork with the injected clock', async () => {
    let t = 1000;
    const fork: ForkFn = async () => { t += 250; return { text: reply({}) }; };
    const out = await scoreWithClaude(fork, calls, opts({ now: () => t }));
    expect(out.forks).toEqual([{ candidates: 3, ms: 250, status: 'ran' }]);
  });
});

describe('runFork', () => {
  it('reduces every outcome to text or a status', async () => {
    expect(await runFork(async () => ({ isAnswered: true, text: 'hi' }), 'p')).toEqual({ text: 'hi' });
    expect(await runFork(async () => ({ text: 'old' }), 'p')).toEqual({ text: 'old' });
    expect(await runFork(async () => ({ isAnswered: false, reason: 'api-error', status: 500 }), 'p')).toEqual({ status: 'api-error 500' });
    expect(await runFork(async () => { throw new Error('x'); }, 'p')).toEqual({ status: 'error' });
    expect(await runFork(() => new Promise(() => {}), 'p', { timeoutMs: 5, sleep: async () => {} })).toEqual({ status: 'timeout' });
  });
});
