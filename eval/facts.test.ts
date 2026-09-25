import { describe, expect, it } from 'vitest';
import { factSets, originIndices, survival, tokensOf } from './facts.ts';
import type { EvalMessage } from './parse.ts';

const call = (id: string, tool: string, input: Record<string, unknown>): EvalMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: id, tool, input }],
});
const result = (id: string, text: string): EvalMessage => ({
  role: 'user',
  text: '',
  toolUses: [],
  toolResults: [{ tool_use_id: id, text }],
});
const say = (text: string): EvalMessage => ({ role: 'assistant', text, toolUses: [] });

describe('tokensOf', () => {
  it('classifies distinctive tokens and ignores years and plain words', () => {
    const t = tokensOf('merged #922 as fe09588 for ABC-4534 in 2026, see /srv/example/app, cost $1,200 decade');
    expect(t.get('#922')).toBe('pr');
    expect(t.get('fe09588')).toBe('sha');
    expect(t.get('ABC-4534')).toBe('jira');
    expect(t.get('/srv/example/app')).toBe('path');
    expect(t.get('$1,200')).toBe('money');
    expect(t.has('2026')).toBe(false);
    expect(t.has('decade')).toBe(false);
  });
});

describe('factSets + survival', () => {
  const messages: EvalMessage[] = [
    { role: 'user', text: 'go', toolUses: [] },
    call('u1', 'Bash', { command: 'git log' }),
    result('u1', 'commit abc1234f quiet\ncommit 9999888 echoed'),
    say('I see 9999888.'),
    call('u2', 'Bash', { command: 'git show abc1234f' }),
    result('u2', 'ok'),
  ];
  const calls = [
    { tool_use_id: 'u1', tool: 'Bash', resultIndex: 2 },
    { tool_use_id: 'u2', tool: 'Bash', resultIndex: 5 },
  ];

  it('finds never-echoed facts and tokens a later call quotes', () => {
    const facts = factSets(messages, calls);
    expect(facts.neverEchoed.map((f) => f.token)).toEqual(['abc1234f']);
    expect(facts.laterReferenced.map((r) => [r.token, r.quotedAt])).toEqual([
      ['abc1234f', 4],
      ['9999888', 3],
    ]);
  });

  it('scores a compacted transcript: whole-context search for facts, own-result search for refs', () => {
    const facts = factSets(messages, calls);
    expect(survival(facts, messages, messages)).toEqual({ neverEchoedSurvived: 1, neverEchoedTotal: 1, laterRefLost: 0, laterRefTotal: 2 });
    const dropped = messages.filter((_, i) => i !== 1 && i !== 2);
    expect(survival(facts, dropped, messages)).toEqual({ neverEchoedSurvived: 1, neverEchoedTotal: 1, laterRefLost: 2, laterRefTotal: 2 });
  });
});

describe('laterRef lost', () => {
  // u1 introduces #4321 (a 'pr' and a 'num' token); u2 carries it again (newer); an assistant message quotes it after both.
  const messages: EvalMessage[] = [
    { role: 'user', text: 'go', toolUses: [] },
    call('u1', 'Bash', { command: 'gh pr list' }),
    result('u1', 'open: #4321 fix things'),
    call('u2', 'Bash', { command: 'gh pr view' }),
    result('u2', 'pr #4321 is open'),
    say('Merging #4321 now.'),
  ];
  const facts = factSets(messages, [
    { tool_use_id: 'u1', tool: 'Bash', resultIndex: 2 },
    { tool_use_id: 'u2', tool: 'Bash', resultIndex: 4 },
  ]);

  it('is not lost when a newer carrier still holds the token before the quote', () => {
    const withoutFirst = messages.filter((_, i) => i !== 1 && i !== 2);
    expect(survival(facts, withoutFirst, messages)).toMatchObject({ laterRefLost: 0, laterRefTotal: 2 });
  });

  it('is lost when the only remaining copies are at or after the quote', () => {
    const withoutBoth = messages.filter((_, i) => i < 1 || i > 4);
    expect(survival(facts, withoutBoth, messages)).toMatchObject({ laterRefLost: 2, laterRefTotal: 2 });
  });

  it('maps rebuilt (truncated) messages back by tool id, and an unknown row to the one before it', () => {
    const rebuilt = { ...messages[4]!, toolResults: [{ tool_use_id: 'u2', text: '[truncated]' }] };
    const summary = { role: 'user' as const, text: 'summary of earlier work', toolUses: [] };
    expect(originIndices([summary, messages[0]!, rebuilt, messages[5]!], messages)).toEqual([-1, 0, 4, 5]);
    const truncatedBoth = messages.map((m, i) => (i === 2 || i === 4 ? { ...m, toolResults: [{ tool_use_id: m.toolResults![0]!.tool_use_id, text: '[truncated]' }] } : m));
    expect(survival(facts, truncatedBoth, messages)).toMatchObject({ laterRefLost: 2 });
  });
});

describe('authoring inputs', () => {
  it('do not count as a later reference', () => {
    const messages: EvalMessage[] = [
      { role: 'user', text: 'go', toolUses: [] },
      call('u1', 'Read', { file_path: '/a/b.ts' }),
      result('u1', 'const someLongIdentifierName = 1'),
      call('u2', 'Edit', { file_path: '/a/b.ts', old_string: 'someLongIdentifierName', new_string: 'x' }),
    ];
    const facts = factSets(messages, [{ tool_use_id: 'u1', tool: 'Read', resultIndex: 2 }]);
    expect(facts.laterReferenced).toEqual([]);
  });
});
