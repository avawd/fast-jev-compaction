import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/shell.js';

const shape = (cmd: string) => parseCommand(cmd).map((step) => step.map((stage) => stage.words));

describe('parseCommand', () => {
  it('splits steps on ; && || and newlines, and stages on |', () => {
    expect(shape('cd /r; ls a | head -3 && echo x || true\nwc -l f.ts')).toEqual([
      [['cd', '/r']], [['ls', 'a'], ['head', '-3']], [['echo', 'x']], [['true']], [['wc', '-l', 'f.ts']],
    ]);
  });

  it('does not split inside quotes, and removes the quotes from words', () => {
    expect(shape(`grep -n -E "a|b; c" 'x && y' lib/f.ts | head`)).toEqual([
      [['grep', '-n', '-E', 'a|b; c', 'x && y', 'lib/f.ts'], ['head']],
    ]);
    expect(shape('grep "a\\"|b" f.ts')).toEqual([[['grep', 'a"|b', 'f.ts']]]);
  });

  it('exposes the unquoted skeleton so operators inside quotes are not mistaken for real ones', () => {
    const [[stage]] = parseCommand(`grep "=> \\$(x)" f.ts 2>&1`) as [[{ bare: string }]];
    expect(stage.bare).not.toContain('=>');
    expect(stage.bare).not.toContain('$(');
    expect(stage.bare).toContain('2>&1');
  });

  it('treats a trailing & as a step boundary', () => {
    expect(shape('sleep 1 & ls')).toEqual([[['sleep', '1']], [['ls']]]);
  });
});
