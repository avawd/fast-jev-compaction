/**
 * A minimal stand-in for the engine around `register()`: captures the hooks it
 * registers and hands them a fake `$` and `next`. The `claude-code/testing` kit
 * is declared in types/claude-code.d.ts but has no runtime here, so vitest
 * cannot load it.
 */
import { register } from '../hooks/verbatim.ts';

type Handler = ($: unknown, event: unknown, next: unknown) => Promise<unknown>;

export interface FakeOptions {
  fork?: (request: { prompt: string }) => Promise<{ text: string } | null>;
  percent?: number | (() => Promise<number>);
  sleep?: (ms: number, options?: { signal?: AbortSignal }) => Promise<void>;
  toast?: (text: string) => void;
  log?: (text: string) => void;
  userConfig?: Record<string, string | number | boolean>;
}

export interface Harness {
  compact: (event: Record<string, unknown>) => Promise<unknown>;
  turnComplete: (event: Record<string, unknown>) => Promise<unknown>;
  forkCalls: string[];
  toasts: string[];
  logs: string[];
  sleeps: Array<{ ms: number; signal?: AbortSignal }>;
  usageCalls: number;
  compactCalls: number;
  nextCalls: unknown[];
  signal: AbortSignal;
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
    forkCalls: [], toasts: [], logs: [], sleeps: [],
    usageCalls: 0, compactCalls: 0, nextCalls: [],
    signal: controller.signal,
  };
  const $ = {
    model: {
      fork: async (request: { prompt: string }) => {
        h.forkCalls.push(request.prompt);
        return options.fork ? options.fork(request) : { text: '{"drop":[],"truncate":[]}' };
      },
    },
    session: {
      usage: async () => {
        h.usageCalls += 1;
        const p = options.percent;
        return { context: { percent: typeof p === 'function' ? await p() : (p ?? 0) } };
      },
      compact: async () => {
        h.compactCalls += 1;
        return { messages: [] };
      },
    },
    ui: {
      log: (text: string) => { h.logs.push(text); options.log?.(text); },
      toast: (text: string) => { h.toasts.push(text); options.toast?.(text); },
    },
    clock: {
      sleep: (ms: number, opts?: { signal?: AbortSignal }) => {
        h.sleeps.push({ ms, signal: opts?.signal });
        return options.sleep ? options.sleep(ms, opts) : new Promise<void>(() => {});
      },
    },
  };
  function run(name: string, event: Record<string, unknown>): Promise<unknown> {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`no ${name} hook registered`);
    const next = Object.assign(async (e: unknown) => {
      h.nextCalls.push(e);
      // Mirrors the live engine (observed on 2.1.281): next() rejects a compaction
      // argument whose `messages` is empty, even when passed through unchanged.
      let msgs: unknown;
      try { msgs = (e as { messages?: unknown } | undefined)?.messages; } catch { msgs = undefined; }
      if (name === 'session.compact' && Array.isArray(msgs) && msgs.length === 0) {
        throw new Error('next() passed an argument with an empty messages (a compaction leaves at least one)');
      }
      return NEXT_RESULT;
    }, { signal: controller.signal });
    return handler($, event, next);
  }
  return h;
}
