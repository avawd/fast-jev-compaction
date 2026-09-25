/**
 * A minimal stand-in for the engine around `register()`: captures the hooks it
 * registers and hands them a fake `$` and `next`. The `claude-code/testing` kit
 * is declared in types/claude-code.d.ts but has no runtime here, so vitest
 * cannot load it.
 */
import { register } from '../hooks/verbatim.ts';
import type { ForkReply } from '../src/index.js';

type Handler = ($: unknown, event: unknown, next: unknown) => Promise<unknown>;

export interface FakeOptions {
  fork?: (request: { prompt: string }) => Promise<ForkReply>;
  percent?: number | (() => Promise<number>);
  /** `context.tokens` from `$.session.usage()`; absent when undefined. */
  tokens?: number | (() => Promise<number>);
  /** Replaces `$.session.compact`, e.g. with the rejection a headless session gives. */
  sessionCompact?: () => Promise<unknown>;
  sleep?: (ms: number, options?: { signal?: AbortSignal }) => Promise<void>;
  toast?: (text: string) => void;
  log?: (text: string) => void;
  userConfig?: Record<string, string | number | boolean>;
  /** Makes `next()` reject with this error (the engine refusing the handed-off compaction). */
  nextThrows?: Error;
  /** Makes `next()` throw synchronously, as a validating engine may. */
  nextThrowsSync?: Error;
  /** Hands the hook a `next` without a `signal`. */
  noSignal?: boolean;
}

export interface Harness {
  compact: (event: Record<string, unknown>) => Promise<unknown>;
  turnComplete: (event: Record<string, unknown>) => Promise<unknown>;
  forkCalls: string[];
  toasts: string[];
  logs: string[];
  /** Lines logged with `{ to: 'debug' }`: the debug log only, never the transcript. */
  debugLogs: string[];
  sleeps: Array<{ ms: number; signal?: AbortSignal }>;
  /** Timers set with `$.clock.after`, not yet fired or cancelled. */
  timers: Array<{ ms: number; fn: () => void }>;
  /** Fires every pending timer once (in order) and waits for what they started to settle. */
  fireTimers: () => Promise<void>;
  usageCalls: number;
  compactCalls: number;
  nextCalls: unknown[];
  signal: AbortSignal;
}

/** Ids listed in a scorer prompt's candidate lines. */
function idsIn(prompt: string): string[] {
  return [...prompt.matchAll(/^(t\d+) /gm)].map((m) => m[1]!);
}

/** The fork reply that keeps every listed candidate whole. */
export function keepAll(prompt: string): string {
  return JSON.stringify({ result_needed: idsIn(prompt), call_matters: [], unsure: [], drop: [] });
}

/** The fork reply that drops every listed candidate. */
export function dropAll(prompt: string): string {
  return JSON.stringify({ result_needed: [], call_matters: [], unsure: [], drop: idsIn(prompt) });
}

export const NEXT_RESULT = { from: 'next' };

export function harness(options: FakeOptions = {}): Harness {
  const handlers = new Map<string, Handler>();
  const on = (event: string, handler: Handler) => {
    handlers.set(event, handler);
  };
  register(on as never, options.userConfig ?? {});
  const controller = new AbortController();
  const h: Harness = {
    compact: (event) => run('session.compact', event),
    turnComplete: (event) => run('turn.complete', event),
    forkCalls: [], toasts: [], logs: [], debugLogs: [], sleeps: [], timers: [],
    fireTimers: async () => {
      const due = h.timers.splice(0);
      for (const timer of due) timer.fn();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    usageCalls: 0, compactCalls: 0, nextCalls: [],
    signal: controller.signal,
  };
  const $ = {
    model: {
      fork: async (request: { prompt: string }) => {
        h.forkCalls.push(request.prompt);
        // The live 2.1.281 shape; tests pass the older `{ text }` / null shapes explicitly.
        return options.fork ? options.fork(request) : { isAnswered: true, text: keepAll(request.prompt) };
      },
    },
    session: {
      usage: async () => {
        h.usageCalls += 1;
        const p = options.percent;
        const t = options.tokens;
        const tokens = typeof t === 'function' ? await t() : t;
        return { context: { percent: typeof p === 'function' ? await p() : (p ?? 0), window: 1_000_000, ...(tokens === undefined ? {} : { tokens }) } };
      },
      compact: async () => {
        h.compactCalls += 1;
        return options.sessionCompact ? options.sessionCompact() : { messages: [] };
      },
    },
    ui: {
      log: (text: string, opts?: { to?: string }) => {
        (opts?.to === 'debug' ? h.debugLogs : h.logs).push(text);
        options.log?.(text);
      },
      toast: (text: string) => { h.toasts.push(text); options.toast?.(text); },
    },
    clock: {
      after: (ms: number, fn: () => void) => {
        const timer = { ms, fn };
        h.timers.push(timer);
        return { cancel: () => { const i = h.timers.indexOf(timer); if (i >= 0) h.timers.splice(i, 1); } };
      },
      sleep: (ms: number, opts?: { signal?: AbortSignal }) => {
        h.sleeps.push({ ms, signal: opts?.signal });
        return options.sleep ? options.sleep(ms, opts) : new Promise<void>(() => {});
      },
    },
  };
  function run(name: string, event: Record<string, unknown>): Promise<unknown> {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no ${name} hook registered`);
    const next = Object.assign((e: unknown) => {
      if (options.nextThrowsSync) {
        h.nextCalls.push(e);
        throw options.nextThrowsSync;
      }
      return nextAsync(e);
    }, options.noSignal ? {} : { signal: controller.signal });
    const nextAsync = async (e: unknown) => {
      h.nextCalls.push(e);
      // Mirrors the live engine (observed on 2.1.281): next() rejects a compaction
      // argument whose `messages` is empty, even when passed through unchanged.
      let msgs: unknown;
      try { msgs = (e as { messages?: unknown } | undefined)?.messages; } catch { msgs = undefined; }
      if (name === 'session.compact' && Array.isArray(msgs) && msgs.length === 0) {
        throw new Error('next() passed an argument with an empty messages (a compaction leaves at least one)');
      }
      if (options.nextThrows) throw options.nextThrows;
      return NEXT_RESULT;
    };
    return handler($, event, next);
  }
  return h;
}
