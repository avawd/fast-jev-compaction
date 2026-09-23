import { describe, expect, it } from 'vitest';
import { compact, reductionRatio, resolveOptions, type Message, type Scorer, type ToolCall } from '../src/index.js';

const big = 'x'.repeat(4000);

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function use(id: string, tool: string, input: Record<string, unknown>): Message {
  return msg('assistant', '', { toolUses: [{ tool_use_id: id, tool, input }] });
}
function res(id: string, text: string, isError = false): Message {
  return msg('user', '', { toolResults: [{ tool_use_id: id, text, isError }] });
}

function transcript(): Message[] {
  return [
    msg('user', 'Fix the failing test.'),
    use('u1', 'Read', { file_path: 'src/a.ts' }),
    res('u1', big),
    use('u2', 'Bash', { command: 'npm test' }),
    res('u2', big),
    msg('assistant', 'Done reading.'),
    msg('user', 'next'),
    msg('assistant', 'ok'),
    msg('user', 'next'),
    msg('assistant', 'ok'),
    msg('user', 'next'),
  ];
}

describe('compact', () => {
  it('applies scorer verdicts, keeps text verbatim, and never scores pinned calls', async () => {
    let seen: readonly ToolCall[] = [];
    const scorer: Scorer = async (calls) => {
      seen = calls;
      return {
        claude: 'ran',
        verdicts: new Map([
          ['t1', { action: 'drop_result', source: 'rule', rule: 'stale_read' }],
          ['t2', { action: 'drop_call', source: 'claude' }],
        ]),
      };
    };
    const input = transcript();
    const out = await compact(input, scorer, { preserveRecentMessages: 6 });
    expect(seen.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(out.messages.map((m) => m.text)).toEqual(
      input.map((m) => m.text).filter((_, i) => i !== 3 && i !== 4),
    );
    expect(out.messages[2]?.toolResults?.[0]?.text.length).toBeLessThan(600);
    expect(out.stats).toMatchObject({ calls: 2, resultsDropped: 1, callsDropped: 1, byRule: 1, byClaude: 1, claude: 'ran' });
    expect(out.decisions.find((d) => d.id === 't1')).toMatchObject({ source: 'rule', rule: 'stale_read' });
    expect(reductionRatio(out)).toBeGreaterThan(0.5);
  });

  it('keeps everything and skips the scorer when there are no unpinned calls', async () => {
    let called = false;
    const scorer: Scorer = async () => {
      called = true;
      return { claude: 'ran', verdicts: new Map() };
    };
    const input = [msg('user', 'hi'), msg('assistant', 'hello')];
    const out = await compact(input, scorer);
    expect(called).toBe(false);
    expect(out.messages[0]).toBe(input[0]);
    expect(out.stats.claude).toBe('skipped');
  });

  it('ignores verdicts for pinned or unknown ids', async () => {
    const scorer: Scorer = async () => ({
      claude: 'ran',
      verdicts: new Map([
        ['t9', { action: 'drop_call', source: 'claude' }],
      ]),
    });
    const input = transcript();
    const out = await compact(input, scorer);
    expect(out.messages).toHaveLength(input.length);
    expect(out.stats.callsDropped).toBe(0);
  });
});

describe('resolveOptions', () => {
  it('uses defaults for missing, NaN and infinite values', () => {
    expect(resolveOptions()).toEqual({ preserveRecentMessages: 6, truncateHeadChars: 300 });
    expect(resolveOptions({ preserveRecentMessages: Number.NaN, truncateHeadChars: Number.POSITIVE_INFINITY }))
      .toEqual({ preserveRecentMessages: 6, truncateHeadChars: 300 });
  });
  it('clamps negatives to zero and floors fractions', () => {
    expect(resolveOptions({ preserveRecentMessages: -3, truncateHeadChars: -1 }))
      .toEqual({ preserveRecentMessages: 0, truncateHeadChars: 0 });
    expect(resolveOptions({ preserveRecentMessages: 2.9, truncateHeadChars: 10.5 }))
      .toEqual({ preserveRecentMessages: 2, truncateHeadChars: 10 });
  });
});
