/**
 * The hook module under seeded async orderings: forks that answer after the deadline, clocks
 * that reject or throw, `next` that throws synchronously or rejects, malformed and oversized
 * transcripts, precompute, subagents, and `$.session.compact()` refusing headless or otherwise.
 * `npm test` runs 300 seeds; FUZZ_SEEDS raises it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { register } from '../hooks/verbatim.ts';
import type { Message } from '../src/index.js';
import { chance, fakeFork, genTranscript, int, pick, rng, seedCount, wellFormed, type Rng } from './fuzz-gen.ts';

type Handler = ($: unknown, event: unknown, next: unknown) => Promise<unknown>;

const SEEDS = seedCount(300);
const HEADLESS = 'session.compact() is not available in a headless session';
/** A hook that has not settled by then is hung. */
const SETTLE_MS = 3000;

/**
 * fuzz-regressions.test.ts 'KNOWN BUG: a clock rejection is unhandled when every fork throws
 * synchronously'. While it stands, forks here never throw synchronously (no absent `$.model.fork`,
 * no sync-throw reply); set false once it is fixed, so the fuzz covers that path again.
 */
const KNOWN_BUG_SYNC_FORK_THROW = false;

const unhandled: unknown[] = [];
const trap = (reason: unknown) => { unhandled.push(reason); };
beforeAll(() => { process.on('unhandledRejection', trap); });
afterAll(() => { process.off('unhandledRejection', trap); });

type SleepMode = 'immediate' | 'instant' | 'abortAware' | 'rejectNow' | 'rejectLater' | 'syncThrow' | 'never';
type NextMode = 'ok' | 'syncValue' | 'syncThrow' | 'reject' | 'rejectLater';

interface Fake {
  $: Record<string, unknown>;
  forkCalls: number;
  toasts: string[];
  usageCalls: number;
  usageInFlight: number;
  usageMaxInFlight: number;
  compactCalls: number;
  compactRejections: string[];
}

function sleepFor(mode: SleepMode) {
  return (ms: number, options?: { signal?: AbortSignal }): Promise<void> => {
    switch (mode) {
      case 'immediate': return new Promise((resolve) => setImmediate(resolve));
      case 'instant': return Promise.resolve();
      case 'abortAware': return new Promise((resolve, reject) => {
        // The engine's clock: resolves after (a scaled-down) ms, rejects when its signal aborts.
        const timer = setTimeout(resolve, Math.min(4, ms));
        const signal = options?.signal;
        if (signal?.aborted) { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); return; }
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      });
      case 'rejectNow': return Promise.reject(new Error('clock refused'));
      case 'rejectLater': return new Promise((_, reject) => setTimeout(() => reject(new Error('clock failed late')), 1));
      case 'syncThrow': throw new Error('clock threw synchronously');
      case 'never': return new Promise(() => {});
    }
  };
}

function fakeEngine(seed: number, r: Rng): Fake {
  const sleepMode = pick<SleepMode>(r, ['immediate', 'instant', 'abortAware', 'abortAware', 'rejectNow', 'rejectLater', 'syncThrow', 'never']);
  // A fork that never answers needs a clock that eventually settles; the engine's always does.
  const fake = fakeFork(seed, sleepMode !== 'never', !KNOWN_BUG_SYNC_FORK_THROW);
  const throwsUi = chance(r, 0.15);
  const f: Fake = {
    $: {}, forkCalls: 0, toasts: [], usageCalls: 0, usageInFlight: 0, usageMaxInFlight: 0, compactCalls: 0, compactRejections: [],
  };
  const forkMode = pick(r, ['fake', 'fake', 'fake', KNOWN_BUG_SYNC_FORK_THROW ? 'fake' : 'missing']);
  const cwdMode = pick(r, ['ok', 'reject', 'missing', 'number']);
  const usageMode = () => pick(r, ['ok', 'ok', 'ok', 'noPercent', 'noContext', 'reject', 'syncThrow']);
  const compactMode = () => pick(r, ['ok', 'headless', 'busy', 'syncThrow']);
  const session: Record<string, unknown> = {
    usage: () => {
      f.usageCalls += 1;
      const mode = usageMode();
      if (mode === 'syncThrow') throw new Error('usage threw');
      f.usageInFlight += 1;
      f.usageMaxInFlight = Math.max(f.usageMaxInFlight, f.usageInFlight);
      return new Promise((resolve, reject) => setImmediate(() => {
        f.usageInFlight -= 1;
        if (mode === 'reject') reject(new Error('usage failed'));
        else if (mode === 'noContext') resolve({});
        else if (mode === 'noPercent') resolve({ context: {} });
        else resolve({ context: { percent: int(r, 0, 100) } });
      }));
    },
    compact: () => {
      f.compactCalls += 1;
      const mode = compactMode();
      if (mode === 'syncThrow') { f.compactRejections.push('sync'); throw new Error('compact threw'); }
      if (mode === 'headless') { f.compactRejections.push('headless'); return Promise.reject(new Error(HEADLESS)); }
      if (mode === 'busy') { f.compactRejections.push('busy'); return Promise.reject(new Error('a turn is running')); }
      return Promise.resolve({ messages: [] });
    },
  };
  if (cwdMode === 'ok') session['cwd'] = async () => '/repo';
  else if (cwdMode === 'reject') session['cwd'] = async () => { throw new Error('no cwd'); };
  else if (cwdMode === 'number') session['cwd'] = async () => 42;
  f.$ = {
    model: forkMode === 'missing' ? {} : { fork: (request: { prompt: string }) => { f.forkCalls += 1; return fake.fork(request); } },
    clock: { sleep: sleepFor(sleepMode) },
    session,
    ui: {
      log: () => { if (throwsUi) throw new Error('log broke'); },
      toast: (text: string) => { f.toasts.push(text); if (throwsUi) throw new Error('toast broke'); },
    },
  };
  return f;
}

const NEXT_VALUE = { from: 'next' };

interface NextFake {
  next: ((event: unknown) => unknown) & { signal?: AbortSignal };
  calls: number;
  error?: Error;
}

function fakeNext(r: Rng): NextFake {
  const mode = pick<NextMode>(r, ['ok', 'ok', 'syncValue', 'syncThrow', 'reject', 'rejectLater']);
  const error = new Error(`next failed (${mode})`);
  const n: NextFake = { calls: 0, next: () => undefined };
  const fn = (_event: unknown): unknown => {
    n.calls += 1;
    switch (mode) {
      case 'ok': return Promise.resolve(NEXT_VALUE);
      case 'syncValue': return NEXT_VALUE;
      case 'syncThrow': n.error = error; throw error;
      case 'reject': n.error = error; return Promise.reject(error);
      case 'rejectLater': n.error = error; return new Promise((_, reject) => setTimeout(() => reject(error), 1));
    }
  };
  const signalMode = pick(r, ['live', 'live', 'aborted', 'none']);
  if (signalMode === 'none') n.next = fn;
  else {
    const controller = new AbortController();
    if (signalMode === 'aborted') controller.abort();
    n.next = Object.assign(fn, { signal: controller.signal });
  }
  return n;
}

function messagesFor(seed: number, r: Rng): { messages: unknown; kind: string } {
  const valid = () => genTranscript(seed, { maxTurns: 10 }).messages as unknown[];
  const kind = pick(r, ['valid', 'valid', 'valid', 'valid', 'empty', 'huge', 'notArray', 'nullRow', 'nullResult', 'noToolUses', 'toolUsesNull', 'textNotString']);
  switch (kind) {
    case 'empty': return { kind, messages: [] };
    case 'huge': return { kind, messages: Array.from({ length: 4096 + int(r, 0, 3) }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}`, toolUses: [] })) };
    case 'notArray': return { kind, messages: pick(r, ['nope', undefined, null, 42, { length: 3 }]) };
    case 'nullRow': { const m = valid(); m.splice(int(r, 1, m.length - 1), 0, null); return { kind, messages: m }; }
    case 'nullResult': { const m = valid(); m.splice(1, 0, { role: 'user', text: '', toolUses: [], toolResults: [null] }); return { kind, messages: m }; }
    case 'noToolUses': { const m = valid(); m.splice(1, 0, { role: 'assistant', text: 'x' }); return { kind, messages: m }; }
    case 'toolUsesNull': { const m = valid(); m.splice(1, 0, { role: 'assistant', text: 'x', toolUses: null }); return { kind, messages: m }; }
    case 'textNotString': { const m = valid(); m.splice(1, 0, { role: 'assistant', text: 42, toolUses: [] }); return { kind, messages: m }; }
    default: return { kind, messages: valid() };
  }
}

type Settled = { ok: true; value: unknown } | { ok: false; error: unknown } | { hung: true };

async function settle(promise: Promise<unknown>): Promise<Settled> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<Settled>((resolve) => { timer = setTimeout(() => resolve({ hung: true }), SETTLE_MS); });
  const out = await Promise.race([
    promise.then((value): Settled => ({ ok: true, value }), (error): Settled => ({ ok: false, error })),
    hung,
  ]);
  clearTimeout(timer);
  return out;
}

function handlers(r: Rng): Map<string, Handler> {
  const map = new Map<string, Handler>();
  const config: Record<string, unknown> = {};
  if (chance(r, 0.3)) config['useClaudeScorer'] = chance(r, 0.5);
  if (chance(r, 0.3)) config['claudeTimeoutMs'] = pick(r, [-1, 500, 45_000, Number.NaN]);
  if (chance(r, 0.3)) config['forkChunkSize'] = pick(r, [0, 1, 7, 1000]);
  if (chance(r, 0.3)) config['minReductionRatio'] = pick(r, [0, 0.25, 0.99]);
  if (chance(r, 0.3)) config['minCandidateChars'] = pick(r, [0, 200, -1, 1e9]);
  register(((name: string, h: Handler) => { map.set(name, h); }) as never, config as never);
  return map;
}

/** The pairing and shape of messages the hook installs itself. */
function installedProblems(input: readonly Message[], out: unknown): string[] {
  const problems: string[] = [];
  if (!Array.isArray(out) || out.length === 0) return ['installed messages not a non-empty array'];
  const rows = out as Message[];
  if (rows.length > input.length) problems.push('installed more rows than it was given');
  if (rows[0] !== input[0]) problems.push('first row replaced');
  const inputs = new Set(input);
  const ownResults = new Set(input.flatMap((m) => m.toolResults ?? []));
  const seen = new Set<string>();
  rows.forEach((m, k) => {
    for (const u of m.toolUses) seen.add(u.tool_use_id);
    for (const res of m.toolResults ?? []) {
      if (!seen.has(res.tool_use_id)) problems.push(`row ${k}: result ${res.tool_use_id} before or without its tool_use`);
      if (!wellFormed(res.text)) problems.push(`row ${k}: lone surrogate`);
      if (!ownResults.has(res) && typeof res.isError !== 'boolean') problems.push(`row ${k}: rebuilt isError not boolean`);
    }
    if (!inputs.has(m) && m.text.trim() === '' && m.toolUses.length === 0 && (m.toolResults ?? []).length === 0) problems.push(`row ${k}: rebuilt empty row`);
  });
  return problems;
}

async function compactCase(seed: number): Promise<string[]> {
  const problems: string[] = [];
  const r = rng(seed * 31 + 7);
  const hooks = handlers(r);
  const engine = fakeEngine(seed, r);
  const next = fakeNext(r);
  const { messages, kind } = messagesFor(seed, r);
  const trigger = pick(r, ['auto', 'manual', 'precompute']);
  const event: Record<string, unknown> = { trigger, messages };
  if (chance(r, 0.3)) event['instructions'] = pick(r, ['focus on the parser', '   ', '']);
  if (chance(r, 0.15)) event['agentId'] = 'agent-1';
  const out = await settle(hooks.get('session.compact')!(engine.$, event, next.next));
  if ('hung' in out) return [`${kind}: hook never settled`];
  if (next.calls > 1) problems.push(`${kind}: next called ${next.calls} times`);
  if (!out.ok) {
    if (next.calls !== 1) problems.push(`${kind}: threw without handing off: ${String(out.error)}`);
    else if (out.error !== next.error) problems.push(`${kind}: threw something other than next's error: ${String(out.error)}`);
  } else if (next.calls === 1) {
    if (out.value !== NEXT_VALUE) problems.push(`${kind}: handed off but returned ${JSON.stringify(out.value)}`);
  } else {
    const value = out.value as { skip?: unknown; messages?: unknown } | undefined;
    if (value && typeof value.skip === 'string') {
      if (!(Array.isArray(messages) && messages.length === 0)) problems.push(`${kind}: skipped a non-empty transcript`);
    } else if (value && 'messages' in value) {
      problems.push(...installedProblems(messages as Message[], value.messages).map((p) => `${kind}: ${p}`));
    } else problems.push(`${kind}: returned ${JSON.stringify(value)}`);
  }
  const isArray = Array.isArray(messages);
  if (isArray && messages.length === 0 && next.calls !== 0) problems.push('empty transcript handed to next');
  if (isArray && messages.length >= 4096 && engine.forkCalls > 0) problems.push('forked on an oversized transcript');
  if (event['agentId'] !== undefined && engine.forkCalls > 0) problems.push('forked for a subagent');
  const summary = trigger === 'manual' && typeof event['instructions'] === 'string' && (event['instructions'] as string).trim().length > 0;
  if (summary && isArray && messages.length > 0 && (engine.forkCalls > 0 || next.calls !== 1)) problems.push('a /compact <instructions> was not handed straight to next');
  if (trigger === 'precompute' && engine.toasts.length > 0) problems.push(`precompute toasted: ${engine.toasts[0]}`);
  return problems;
}

async function turnCase(seed: number): Promise<string[]> {
  const problems: string[] = [];
  const r = rng(seed * 37 + 11);
  const hooks = handlers(r);
  const engine = fakeEngine(seed, r);
  const turn = hooks.get('turn.complete')!;
  const eventFor = () => {
    const event: Record<string, unknown> = { reason: pick(r, ['answer', 'answer', 'answer', 'error', 'interrupt']) };
    if (chance(r, 0.1)) event['agentId'] = 'agent-1';
    return event;
  };
  let off = false;
  for (let i = 0, turns = int(r, 1, 5); i < turns; i += 1) {
    const concurrent = chance(r, 0.25);
    const events = concurrent ? [eventFor(), eventFor()] : [eventFor()];
    const nexts = events.map(() => fakeNext(r));
    const usageBefore = engine.usageCalls;
    const rejectionsBefore = engine.compactRejections.length;
    const outs = await Promise.all(events.map((e, k) => settle(turn(engine.$, e, nexts[k]!.next))));
    outs.forEach((out, k) => {
      const n = nexts[k]!;
      if ('hung' in out) { problems.push('turn.complete never settled'); return; }
      if (n.calls !== 1) problems.push(`turn.complete called next ${n.calls} times`);
      if (out.ok && out.value !== NEXT_VALUE) problems.push(`turn.complete returned ${JSON.stringify(out.value)}`);
      if (!out.ok && out.error !== n.error) problems.push(`turn.complete threw something other than next's error: ${String(out.error)}`);
    });
    const eligible = events.filter((e) => e['reason'] === 'answer' && e['agentId'] === undefined).length;
    if (off && engine.usageCalls > usageBefore) problems.push('asked for usage after a headless refusal turned auto-compact off');
    if (!off && !concurrent && eligible === 1 && engine.usageCalls !== usageBefore + 1) problems.push('an eligible turn did not check usage');
    if (engine.compactRejections.slice(rejectionsBefore).includes('headless')) off = true;
  }
  if (engine.usageMaxInFlight > 1) problems.push(`${engine.usageMaxInFlight} usage checks ran at once`);
  return problems;
}

describe('fuzz: hook handlers under async orderings', () => {
  it(`session.compact and turn.complete hold their contract over ${SEEDS} seeds`, async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      for (const p of await compactCase(seed)) failures.push(`seed ${seed} compact: ${p}`);
      for (const p of await turnCase(seed)) failures.push(`seed ${seed} turn: ${p}`);
    }
    // Late timers (forks, clocks, next) settle within a few ms; give them the chance to leak.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const leaked = unhandled.map((e) => (e instanceof Error ? e.message : String(e)));
    expect({ failures: failures.slice(0, 25), total: failures.length, unhandled: leaked.slice(0, 10) })
      .toEqual({ failures: [], total: 0, unhandled: [] });
  }, Math.max(60_000, SEEDS * 100));
});
