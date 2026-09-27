/**
 * Phase 23.8: the in-game console's line parser (words, typed arguments by
 * position or name, usage text).
 */
import { describe, expect, it } from 'vitest';

import { consoleWords, parseConsoleLine, usage } from './debug-console';

const COMMANDS = [
  { name: 'giveItem', description: 'Give an item', args: [{ name: 'item', type: 'string' as const }, { name: 'count', type: 'number' as const, optional: true }] },
  { name: 'godMode', description: '', args: [{ name: 'on', type: 'boolean' as const }] },
  { name: 'heal', description: '', args: [] },
];

describe('the debug console line parser', () => {
  it('splits words; double quotes keep spaces', () => {
    expect(consoleWords('giveItem "iron key" 2')).toEqual(['giveItem', 'iron key', '2']);
    expect(consoleWords('  a   b  ')).toEqual(['a', 'b']);
    expect(consoleWords('say "" "he said \\"hi\\""')).toEqual(['say', '', 'he said "hi"']);
  });

  it('types the arguments by position or by name; optional ones may be left out', () => {
    expect(parseConsoleLine('giveItem lantern 3', COMMANDS)).toEqual({ ok: true, name: 'giveItem', args: { item: 'lantern', count: 3 } });
    expect(parseConsoleLine('giveItem count=2 item="iron key"', COMMANDS)).toEqual({ ok: true, name: 'giveItem', args: { item: 'iron key', count: 2 } });
    expect(parseConsoleLine('giveItem rope', COMMANDS)).toEqual({ ok: true, name: 'giveItem', args: { item: 'rope' } });
    expect(parseConsoleLine('godMode on', COMMANDS)).toEqual({ ok: true, name: 'godMode', args: { on: true } });
    expect(parseConsoleLine('godMode 0', COMMANDS)).toEqual({ ok: true, name: 'godMode', args: { on: false } });
    expect(parseConsoleLine('heal', COMMANDS)).toEqual({ ok: true, name: 'heal', args: {} });
  });

  it('explains what is wrong', () => {
    const msg = (line: string): string => {
      const r = parseConsoleLine(line, COMMANDS);
      return r.ok ? '' : r.message;
    };
    expect(msg('')).toContain('help');
    expect(msg('fly')).toContain('unknown command "fly"');
    expect(msg('giveItem')).toContain('needs item');
    expect(msg('giveItem rope many')).toContain('count must be a number');
    expect(msg('godMode maybe')).toContain('true or false');
    expect(msg('heal now')).toContain('takes 0 arguments');
    expect(usage(COMMANDS[0]!)).toBe('giveItem <item:string> [count:number]');
  });
});
