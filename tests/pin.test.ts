import { describe, expect, it } from 'vitest';
import {
  analyzeReferences,
  collectToolCalls,
  distinctiveTokens,
  pinnedTail,
  refLaterCounts,
  type Message,
} from '../src/index.js';

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function use(id: string, tool: string, input: Record<string, unknown>, text = ''): Message {
  return msg('assistant', text, { toolUses: [{ tool_use_id: id, tool, input }] });
}
function res(id: string, text: string): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text }] });
}

describe('distinctiveTokens', () => {
  it('finds shas, PR and ticket numbers, paths, URLs, long numbers and identifiers', () => {
    const tokens = distinctiveTokens(
      'commit 9c0ffee1 in #123 for ABC-1234 at lib/modules/foo.ts see https://x.io/a?b=1 id 48213 ' +
        'calls recoverStuckDraftFilings and WI_OPS_TOKEN in 2026',
    );
    for (const t of ['9c0ffee1', '#123', 'ABC-1234', 'lib/modules/foo.ts', 'https://x.io/a?b=1', '48213',
      'recoverStuckDraftFilings', 'WI_OPS_TOKEN']) {
      expect(tokens).toContain(t);
    }
  });

  it('skips years, plain words, short numbers and hex-looking words without a digit', () => {
    const tokens = distinctiveTokens('in 2026 the implementation of 123 was defaced');
    expect(tokens).toEqual([]);
  });
});

describe('analyzeReferences', () => {
  function transcript(): Message[] {
    return [
      msg('user', 'find the commit'),
      use('u1', 'Bash', { command: 'git log' }),
      res('u1', 'a1b2c3d4e5 fix: thing\n9f8e7d6c5b other'),
      use('u2', 'Bash', { command: 'git show a1b2c3d4e5' }),
      res('u2', 'diff ...'),
      msg('assistant', 'Shipped as 9f8e7d6c5b.'),
      msg('user', 'thanks'),
    ];
  }

  it('credits the result that carried a token quoted later in assistant text or tool input', () => {
    const messages = transcript();
    const calls = collectToolCalls(messages, 0);
    const refs = analyzeReferences(calls, messages);
    expect(refs.get('t1')?.sort()).toEqual(['9f8e7d6c5b', 'a1b2c3d4e5']);
    expect(refs.has('t2')).toBe(false);
    expect(refLaterCounts(calls, messages)).toEqual(new Map([['t1', 2]]));
  });

  it('does not credit a result for a token the conversation already had', () => {
    const messages = transcript();
    messages[0] = msg('user', 'find commit a1b2c3d4e5');
    const refs = analyzeReferences(collectToolCalls(messages, 0), messages);
    expect(refs.get('t1')).toEqual(['9f8e7d6c5b']);
  });

  it('credits the newest result carrying the token, so an older copy stays droppable', () => {
    const messages: Message[] = [
      msg('user', 'go'),
      use('u1', 'Read', { file_path: 'a.ts' }),
      res('u1', 'const reallyLongIdentifierName = 1;'),
      use('u2', 'Read', { file_path: 'a.ts' }),
      res('u2', 'const reallyLongIdentifierName = 2;'),
      msg('assistant', 'reallyLongIdentifierName is 2'),
    ];
    const refs = analyzeReferences(collectToolCalls(messages, 0), messages);
    expect(refs.has('t1')).toBe(false);
    expect(refs.get('t2')).toEqual(['reallyLongIdentifierName']);
  });

  it('ignores Edit input as a reference, and a pinned result as a carrier', () => {
    const messages: Message[] = [
      msg('user', 'go'),
      use('u1', 'Read', { file_path: 'a.ts' }),
      res('u1', 'const reallyLongIdentifierName = 1;'),
      use('u2', 'Edit', { file_path: 'a.ts', old_string: 'reallyLongIdentifierName', new_string: 'x' }),
      res('u2', 'ok'),
    ];
    expect(analyzeReferences(collectToolCalls(messages, 0), messages).size).toBe(0);
    const pinnedCarrier: Message[] = [
      msg('user', 'go'),
      use('u1', 'Read', { file_path: 'a.ts' }),
      res('u1', 'const reallyLongIdentifierName = 1;'),
      msg('assistant', 'reallyLongIdentifierName'),
    ];
    expect(analyzeReferences(collectToolCalls(pinnedCarrier, 10), pinnedCarrier).size).toBe(0);
  });
});

describe('analyzeReferences: droppable content', () => {
  it('does not let an Edit input hide a later quote (the Edit itself can be dropped)', () => {
    const messages: Message[] = [
      msg('user', 'go'),
      use('u1', 'Bash', { command: 'grep -rn Leased lib' }),
      res('u1', 'lib/a.ts:3: ROUTING_RECORDER_LIVE_FROM = 1'),
      use('u2', 'Edit', { file_path: 'lib/a.ts', old_string: 'ROUTING_RECORDER_LIVE_FROM = 1', new_string: 'x' }),
      res('u2', 'ok'),
      use('u3', 'Bash', { command: 'grep -rn ROUTING_RECORDER_LIVE_FROM lib' }),
      res('u3', 'none'),
    ];
    expect(analyzeReferences(collectToolCalls(messages, 0), messages).get('t1')).toContain('ROUTING_RECORDER_LIVE_FROM');
  });

  it('finds a path inside a file:// URL', () => {
    expect(distinctiveTokens('at x (file:///home/me/repo/scripts/a.test.ts:141:12)')).toContain("/home/me/repo/scripts/a.test.ts");
  });

  it('skips two-segment non-paths and the host part of a URL', () => {
    const tokens = distinctiveTokens('rate 10/min on Tue/Thu at https://x.example.net/browse/ABC-12 in lib/core');
    expect(tokens).not.toContain('10/min');
    expect(tokens).not.toContain('Tue/Thu');
    expect(tokens).not.toContain('lib/core');
    expect(tokens).not.toContain('/x.example.net/browse/ABC-12');
    expect(tokens).toContain('https://x.example.net/browse/ABC-12');
    expect(distinctiveTokens('see lib/a.ts and src/x/y/z')).toEqual(expect.arrayContaining(['lib/a.ts', 'src/x/y/z']));
  });

  it('finds dollar amounts', () => {
    expect(distinctiveTokens('saves $540 a year, $1,234.50 total')).toEqual(expect.arrayContaining(['$540', '$1,234.50']));
  });
});

describe('pinnedTail', () => {
  const text = `${'h'.repeat(100)}HEADTOKEN${'m'.repeat(5000)}MIDTOKEN${'m'.repeat(5000)}TAILTOKEN${'t'.repeat(100)}`;

  it('keeps the preferred shape when it already covers every pinned token', () => {
    expect(pinnedTail(text, ['HEADTOKEN'], 300, 0, 1000)).toBe(0);
    expect(pinnedTail(text, ['HEADTOKEN', 'TAILTOKEN'], 300, 1000, 1000)).toBe(1000);
  });

  it('widens to head+tail when the tail holds a pinned token', () => {
    expect(pinnedTail(text, ['TAILTOKEN'], 300, 0, 1000)).toBe(1000);
  });

  it('returns undefined (keep verbatim) when no window covers a pinned token', () => {
    expect(pinnedTail(text, ['MIDTOKEN'], 300, 0, 1000)).toBeUndefined();
  });

  it('treats a token cut by the head boundary as not covered', () => {
    expect(pinnedTail(text, ['HEADTOKEN'], 105, 0, 0)).toBeUndefined();
  });
});

describe('distinctiveTokens performance', () => {
  it('stays linear on long unbroken runs (base64 blobs, minified lines)', () => {
    const started = Date.now();
    distinctiveTokens(`${'a'.repeat(200_000)} ${'a.b-c'.repeat(40_000)}`);
    expect(Date.now() - started).toBeLessThan(300);
  });
});
