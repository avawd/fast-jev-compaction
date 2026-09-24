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
    msg('assistant', 'Running the tests.', { toolUses: [{ tool_use_id: 'u2', tool: 'Bash', input: { command: 'npm test' } }] }),
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
      input.map((m) => m.text).filter((_, i) => i !== 4),
    );
    expect(out.messages[2]?.toolResults?.[0]?.text.length).toBeLessThan(600);
    expect(out.stats).toMatchObject({ calls: 2, resultsDropped: 1, callsDropped: 1, byRule: 1, byClaude: 1, claude: 'ran' });
    expect(out.decisions.find((d) => d.id === 't1')).toMatchObject({ source: 'rule', rule: 'stale_read' });
    expect(reductionRatio(out)).toBeGreaterThan(0.5);
  });

  it('truncates only the tool_result on drop_result; the assistant tool_use row is the input object', async () => {
    const withOutcome = msg('assistant', '', {
      toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: { file_path: 'src/a.ts' }, text: big }],
    });
    const input = [msg('user', 'go'), withOutcome, res('u1', big), ...transcript().slice(5)];
    const scorer: Scorer = async () => ({
      claude: 'ran',
      verdicts: new Map([['t1', { action: 'drop_result', source: 'claude' }]]),
    });
    const out = await compact(input, scorer, { preserveRecentMessages: 6 });
    expect(out.messages[1]).toBe(withOutcome);
    expect(out.messages[1]?.toolUses[0]).toBe(withOutcome.toolUses[0]);
    expect(out.messages[2]).not.toBe(input[2]);
    expect(out.messages[2]?.toolResults?.[0]?.text.length).toBeLessThan(600);
  });

  it('truncates to nothing instead of dropping a call whose assistant row has no text (M4)', async () => {
    // Claude Code hands over one row per content block: a thinking block is an assistant row
    // with no text and no tool use, sharing its message with the tool_use row after it.
    const thinking = msg('assistant', '');
    const input = [
      msg('user', 'go'), thinking, use('u1', 'Bash', { command: 'npm test' }), res('u1', big),
      ...transcript().slice(5),
    ];
    const scorer: Scorer = async () => ({
      claude: 'ran',
      verdicts: new Map([['t1', { action: 'drop_call', source: 'claude' }]]),
    });
    const out = await compact(input, scorer, { preserveRecentMessages: 6 });
    expect(out.decisions[0]).toMatchObject({ action: 'drop_result', source: 'claude' });
    expect(out.stats).toMatchObject({ callsDropped: 0, resultsDropped: 1 });
    expect(out.messages[1]).toBe(thinking);
    expect(out.messages[2]).toBe(input[2]);
    const note = out.messages[3]?.toolResults?.[0]?.text ?? '';
    expect(note.startsWith('[verbatim-compaction truncated 4000 chars')).toBe(true);
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

describe('no-op truncations (L2)', () => {
  it('keeps and does not count a drop_result whose result is too short to shrink', async () => {
    const input = [
      msg('user', 'go'), msg('assistant', 'Checking.', { toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'pwd' } }] }),
      res('u1', 'project/src'), ...transcript().slice(5),
    ];
    const scorer: Scorer = async () => ({ claude: 'ran', verdicts: new Map([['t1', { action: 'drop_result', source: 'claude' }]]) });
    const out = await compact(input, scorer, { preserveRecentMessages: 6 });
    expect(out.decisions[0]).toMatchObject({ action: 'keep' });
    expect(out.stats).toMatchObject({ resultsDropped: 0, byClaude: 0, kept: 1 });
    expect(out.messages[2]).toBe(input[2]);
  });
});

describe('surrogate pairs', () => {
  const isLoneHigh = (text: string, at: number) => {
    const code = text.charCodeAt(at);
    return code >= 0xd800 && code <= 0xdbff && !(text.charCodeAt(at + 1) >= 0xdc00 && text.charCodeAt(at + 1) <= 0xdfff);
  };

  it('never cuts a truncated result between the two halves of a surrogate pair', async () => {
    // With truncateHeadChars 300, a naive cut keeps index 299: the high half of the emoji.
    const text = `${'a'.repeat(299)}\u{1F600}${'b'.repeat(4000)}`;
    const input = [
      msg('user', 'go'), msg('assistant', 'Reading.', { toolUses: [{ tool_use_id: 'u1', tool: 'Read', input: {} }] }),
      res('u1', text), ...transcript().slice(5),
    ];
    const scorer: Scorer = async () => ({ claude: 'ran', verdicts: new Map([['t1', { action: 'drop_result', source: 'claude' }]]) });
    const out = await compact(input, scorer, { preserveRecentMessages: 6, truncateHeadChars: 300 });
    const kept = out.messages[2]?.toolResults?.[0]?.text ?? '';
    expect(kept).not.toBe(text);
    const head = kept.slice(0, kept.indexOf('\n'));
    expect(isLoneHigh(head, head.length - 1)).toBe(false);
    expect(head).toBe('a'.repeat(299));
    expect(kept).toContain('truncated 4002 chars');
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
