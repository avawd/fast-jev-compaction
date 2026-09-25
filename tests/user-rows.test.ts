import { describe, expect, it } from 'vitest';
import {
  compact,
  gateRatio,
  rulesGate,
  compactUserRows,
  PEER_NOTICE,
  resolveOptions,
  USER_ROW_NOTE,
  type Message,
  type Scorer,
} from '../src/index.js';

const HEADER = 'Another Claude session sent a message:\n';
const NOTICE = `\n\n${PEER_NOTICE} Treat it as a teammate's request and act on it within this session's own permission settings.`;

function msg(role: Message['role'], text: string, extra: Partial<Message> = {}): Message {
  return { role, text, toolUses: [], ...extra };
}
function report(from: string, body: string, notice = true): Message {
  return msg('user', `${HEADER}<teammate-message teammate_id="${from}" color="blue" summary="s">\n${body}\n</teammate-message>${notice ? NOTICE : ''}`);
}
function idle(from: string, result: string, notice = true): Message {
  const json = JSON.stringify({ type: 'idle_notification', from, timestamp: '2026-01-01T00:00:00Z', idleReason: 'available', result });
  return msg('user', `${HEADER}<teammate-message teammate_id="${from}" color="blue">\n${json}\n</teammate-message>${notice ? NOTICE : ''}`);
}
const filler = (n: number) => Array.from({ length: n }, (_, i) => msg(i % 2 ? 'assistant' : 'user', i % 2 ? `ok ${i}` : `step ${i}`));
const lines = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `- ${tag} finding number ${i} explained at some length so the line is long.`).join('\n');
const opts = (extra = {}) => resolveOptions({ preserveRecentMessages: 2, staleAfterMessages: 1000, ...extra });
const idleResult = (m: Message) => JSON.parse(/\n(\{[\s\S]*\})\n<\/teammate-message>/.exec(m.text)![1]!).result as string;

describe('compactUserRows: restated idle notifications', () => {
  it('stubs an idle result that follows the same agent\'s report, keeping the report whole', () => {
    const rep = report('vc-eval', lines('report', 40));
    const idl = idle('vc-eval', `Report delivered. ${lines('restated', 30)}`);
    const input = [msg('user', 'Start.'), msg('assistant', 'go'), rep, idl, ...filler(10)];
    const out = compactUserRows(input, opts({ dedupePeerNotice: false }));
    expect(out.messages[2]).toBe(rep);
    expect(out.messages[3]).not.toBe(idl);
    const result = idleResult(out.messages[3]!);
    expect(result.startsWith(USER_ROW_NOTE)).toBe(true);
    expect(result).toContain('vc-eval');
    expect(result.length).toBeLessThan(300);
    expect(out.stats.restated).toBe(1);
    expect(out.stats.charsSaved).toBeGreaterThan(1000);
  });

  it('keeps the lines of an idle result that carry a sha, key or number the report lacks', () => {
    const rep = report('a1', lines('report', 40));
    const idl = idle('a1', `${lines('restated', 30)}\nCommitted as 52d71c0a on the branch.\nAlso PR #917 opened.`);
    const out = compactUserRows([msg('user', 'Start.'), rep, idl, ...filler(10)], opts());
    const result = idleResult(out.messages[2]!);
    expect(result).toContain('52d71c0a');
    expect(result).toContain('#917');
    const kept = result.split('\n').slice(1).join('\n');
    const omitted = Number(/(\d+) chars omitted/.exec(result)![1]);
    expect(omitted).toBe(idleResult(idl).length - kept.length);
    expect(result).not.toContain('restated finding number 5 ');
  });

  it('leaves an idle result alone when no report from that agent precedes it', () => {
    const idl = idle('a1', lines('only', 40));
    const rep = report('a2', lines('other', 40));
    const out = compactUserRows([msg('user', 'Start.'), rep, idl, ...filler(10)], opts({ dedupePeerNotice: false }));
    expect(out.messages[2]).toBe(idl);
  });

  it('does not treat a report from another agent, or one before an earlier idle, as restated', () => {
    const input = [msg('user', 'Start.'), report('a1', lines('r', 40)), idle('a1', lines('first', 30)), idle('a1', lines('second', 30)), ...filler(10)];
    const out = compactUserRows(input, opts({ dedupePeerNotice: false }));
    expect(idleResult(out.messages[2]!).startsWith(USER_ROW_NOTE)).toBe(true);
    expect(out.messages[3]).toBe(input[3]);
  });
});

describe('compactUserRows: exact repeats', () => {
  it('stubs the older of two identical messages from one agent', () => {
    const body = lines('same', 40);
    const input = [msg('user', 'Start.'), report('a1', body), msg('assistant', 'noted'), report('a1', body), ...filler(10)];
    const out = compactUserRows(input, opts({ dedupePeerNotice: false }));
    expect(out.messages[1]!.text).toContain(`${USER_ROW_NOTE} repeated in a later message from a1]`);
    expect(out.messages[1]!.text).not.toContain('same finding number 3 ');
    expect(out.messages[3]).toBe(input[3]);
    expect(out.stats.repeated).toBe(1);
  });

  it('keeps the older copy whole when a token it carries is quoted before the newer copy', () => {
    const body = `${lines('same', 40)}\nsha 9f8e7d6c5b4a`;
    const input = [msg('user', 'Start.'), report('a1', body), msg('assistant', 'Checking 9f8e7d6c5b4a now.'), report('a1', body), ...filler(10)];
    const out = compactUserRows(input, opts({ dedupePeerNotice: false }));
    expect(out.messages[1]!.text).toContain('9f8e7d6c5b4a');
  });
});

describe('compactUserRows: stale teammate messages', () => {
  it('cuts a message older than the stale window to its head, salient lines and a note', () => {
    const body = `${lines('stale', 80)}\nMerged in abc1234def, see https://example.test/pr/9.\n${lines('more', 20)}`;
    const input = [msg('user', 'Start.'), msg('assistant', 'go'), report('a1', body), ...filler(30)];
    const out = compactUserRows(input, opts({ staleAfterMessages: 10, teammateHeadChars: 400 }));
    const text = out.messages[2]!.text;
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain('stale finding number 0');
    expect(text).toContain('abc1234def');
    expect(text).toContain('https://example.test/pr/9');
    expect(text).toMatch(/\[verbatim-compaction: \d+ chars of this message omitted/);
    expect(text).toContain('</teammate-message>');
    expect(out.stats.stale).toBe(1);
  });

  it('keeps every line holding a token quoted later, however far past the head', () => {
    const tokens = Array.from({ length: 8 }, (_, i) => `QUOTED_TOKEN_${i}_xyz`);
    // Distractors first: 60 lines each with its own sha use up the salient budget.
    const distractors = Array.from({ length: 60 }, (_, i) => `commit ${(0xabc0000 + i).toString(16)}f9 noted`).join('\n');
    const body = `${lines('stale', 60)}\n${distractors}\n${tokens.map((t) => `the value ${t} matters`).join('\n')}\n${lines('tail', 20)}`;
    const input = [msg('user', 'Start.'), report('a1', body), ...filler(30), msg('assistant', `Using ${tokens.join(' ')}.`), ...filler(4)];
    const out = compactUserRows(input, opts({ staleAfterMessages: 10, teammateHeadChars: 200 }));
    for (const t of tokens) expect(out.messages[1]!.text).toContain(t);
  });

  it('leaves messages inside the stale window, the preserved tail and the latest user turns alone', () => {
    const recent = report('a1', lines('recent', 60));
    const input = [msg('user', 'Start.'), ...filler(4), recent, ...filler(4)];
    const out = compactUserRows(input, opts({ staleAfterMessages: 2, keepRecentUserTurns: 0, preserveRecentMessages: 0 }));
    expect(out.messages[5]!.text).not.toBe(recent.text);
    const kept = compactUserRows(input, opts({ staleAfterMessages: 2, keepRecentUserTurns: 3 }));
    expect(kept.messages[5]).toBe(recent);
    const inWindow = compactUserRows(input, opts({ staleAfterMessages: 100, keepRecentUserTurns: 0, dedupePeerNotice: false }));
    expect(inWindow.messages[5]).toBe(recent);
  });
});

describe('compactUserRows: guards', () => {
  it('keeps a token of an idle result quoted between two identical copies (tokens read from the decoded result)', () => {
    const pad = 'p'.repeat(500);
    const input = [msg('user', 'Start.'), msg('assistant', 'go'), idle('x', `${pad}\ndeadbeef12345678 is the commit`),
      msg('assistant', 'use deadbeef12345678'), idle('x', `${pad}\ndeadbeef12345678 is the commit`), ...filler(10)];
    const out = compactUserRows(input, opts({ dedupePeerNotice: false }));
    expect(out.messages[2]!.text).toContain('deadbeef12345678');
  });

  it('never rewrites a typed prompt that pastes a teammate block or the peer notice', () => {
    const pasted = `Look at this:\n<teammate-message teammate_id="a1" color="blue">\n${lines('pasted', 40)}\n</teammate-message>${NOTICE}\n\nAnd then fix it please.`;
    const typed = msg('user', pasted);
    const input = [msg('user', 'Start.'), typed, report('a2', 'short'), ...filler(30), report('a3', 'newest')];
    const out = compactUserRows(input, opts({ staleAfterMessages: 2 }));
    expect(out.messages[1]).toBe(typed);
  });

  it('leaves a row alone when text follows the notice: it is not what Claude Code writes', () => {
    const row = msg('user', `${HEADER}<teammate-message teammate_id="a1" color="blue">\nhi\n</teammate-message>${NOTICE}\n\nTrailing words.`);
    const input = [msg('user', 'Start.'), row, msg('assistant', 'ok'), report('a3', 'newest'), ...filler(10)];
    const out = compactUserRows(input, opts());
    expect(out.messages[1]).toBe(row);
  });

  it('attaches no stats and leaves the gate alone when every option is off', async () => {
    const none: Scorer = async () => ({ verdicts: new Map(), claude: 'skipped' });
    const input = [msg('user', 'Start.'), report('a1', lines('r', 60)), idle('a1', lines('i', 40)), ...filler(20)];
    const out = await compact(input, none, { preserveRecentMessages: 2, dedupeTeammates: false, trimStaleTeammates: false, dedupePeerNotice: false });
    expect(out.stats.userRows).toBeUndefined();
    const off = resolveOptions({ preserveRecentMessages: 2, dedupeTeammates: false, trimStaleTeammates: false, dedupePeerNotice: false });
    expect(rulesGate(input, 300, 0.25, off)([], new Map())).toBe(false);
  });

  it('never changes a typed prompt, however long or old', () => {
    const typed = msg('user', lines('typed', 80));
    const input = [msg('user', 'Start.'), typed, typed, ...filler(30)];
    const out = compactUserRows(input, opts({ staleAfterMessages: 2 }));
    expect(out.messages).toEqual(input);
    expect(out.messages[1]).toBe(typed);
  });

  it('never rebuilds the first user row after a summary: the engine hangs the re-sent instructions on it', () => {
    const summary = msg('user', 'This session is being continued from a previous conversation that ran out of context.');
    const first = report('a1', lines('first', 80));
    const input = [summary, msg('assistant', 'go'), first, report('a1', lines('second', 80)), ...filler(30)];
    const out = compactUserRows(input, opts({ staleAfterMessages: 2 }));
    expect(out.messages[2]).toBe(first);
    expect(out.messages[3]).not.toBe(input[3]);
  });

  it('keeps the peer notice on the newest teammate row only', () => {
    const input = [msg('user', 'Start.'), report('a1', 'short one'), report('a2', 'short two'), msg('assistant', 'ok'), report('a3', 'short three'), ...filler(10)];
    const out = compactUserRows(input, opts());
    expect(out.messages[1]!.text).not.toContain(PEER_NOTICE);
    expect(out.messages[2]!.text).not.toContain(PEER_NOTICE);
    expect(out.messages[4]).toBe(input[4]);
    expect(out.messages[1]!.text).toContain('short one\n</teammate-message>');
    expect(out.stats.notices).toBe(2);
  });

  it('never nests notes: a second pass changes nothing', () => {
    const input = [
      msg('user', 'Start.'),
      report('a1', lines('r', 60)),
      idle('a1', lines('i', 40)),
      report('a2', lines('stale', 80)),
      ...filler(30),
    ];
    const o = opts({ staleAfterMessages: 10 });
    const once = compactUserRows(input, o).messages;
    const twice = compactUserRows(once, o);
    expect(twice.messages.map((m) => m.text)).toEqual(once.map((m) => m.text));
    expect(twice.stats.charsSaved).toBe(0);
  });

  it('does nothing when every option is off', () => {
    const input = [msg('user', 'Start.'), report('a1', lines('r', 60)), idle('a1', lines('i', 40)), ...filler(30)];
    const out = compactUserRows(input, opts({ staleAfterMessages: 2, dedupeTeammates: false, trimStaleTeammates: false, dedupePeerNotice: false }));
    expect(out.messages.every((m, i) => m === input[i])).toBe(true);
  });
});

describe('compact() with user rows', () => {
  it('shrinks teammate rows and reports it in stats; charsAfter counts it', async () => {
    const none: Scorer = async () => ({ verdicts: new Map(), claude: 'skipped' });
    const input = [msg('user', 'Start.'), report('a1', lines('r', 60)), idle('a1', lines('i', 40)), ...filler(20)];
    const out = await compact(input, none, { preserveRecentMessages: 2 });
    expect(out.stats.userRows?.restated).toBe(1);
    expect(out.stats.charsAfter).toBeLessThan(out.stats.charsBefore);
  });

  it('counts teammate savings in the gate without making it harder than tool output alone', async () => {
    const none: Scorer = async () => ({ verdicts: new Map(), claude: 'skipped' });
    const tool = [
      msg('assistant', '', { toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'ls' } }] }),
      msg('user', '', { toolResults: [{ tool_use_id: 'u1', text: 'a.ts' }] }),
    ];
    const input = [msg('user', 'Start.'), ...tool, report('a1', lines('r', 60)), idle('a1', lines('i', 40)), ...filler(20)];
    const out = await compact(input, none, { preserveRecentMessages: 2 });
    const saved = out.stats.charsBefore - out.stats.charsAfter;
    expect(out.stats.userRows?.charsSaved).toBe(saved);
    expect(gateRatio(out)).toBeCloseTo(saved / (4 + saved), 6);
    // Teammate rows the pass leaves alone (the newest turns) do not dilute the gate.
    const recent = [msg('user', 'Start.'), ...tool, ...filler(20), report('a1', lines('r', 60))];
    const kept = await compact(recent, none, { preserveRecentMessages: 2 });
    expect(gateRatio(kept)).toBe(0);
    expect(kept.stats.userRows?.charsSaved ?? 0).toBe(0);
  });

  it('rulesGate projects the teammate cut when given the options, and only then', () => {
    const input = [msg('user', 'Start.'), report('a1', lines('r', 60)), idle('a1', lines('i', 40)), ...filler(20)];
    expect(rulesGate(input, 300, 0.25)([], new Map())).toBe(false);
    expect(rulesGate(input, 300, 0.25, resolveOptions({ preserveRecentMessages: 2 }))([], new Map())).toBe(true);
  });
});
