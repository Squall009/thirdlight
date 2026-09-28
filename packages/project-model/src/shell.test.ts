/** Phase 24.4j: the game shell block — its shape, and its documents. */
import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { canonicalShell, validateShell, validateShellReferences } from './shell';

const errorsOf = (v: unknown): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  validateShell(v, '/shell', e);
  return e;
};
const refs = (content: Record<string, unknown>): string[] => {
  const e: ModelErrorV2[] = [];
  validateShellReferences(content, e);
  return e.map((x) => `${x.code} ${x.path}`);
};

describe('the shell block', () => {
  it('accepts every field and refuses a bad shape', () => {
    expect(errorsOf({})).toEqual([]);
    expect(errorsOf({ screens: { title: 't', pause: 'p', settings: 's', controls: 'c', save: 'sv', load: 'ld' }, hud: ['h1', 'h2'], scenes: [{ scene: 'scene-a', spawn: 'spawn-1' }, { scene: 'scene-b' }], pause: false, status: true })).toEqual([]);
    const codes = (v: unknown): string[] => errorsOf(v).map((e) => `${e.code} ${e.path}`);
    expect(codes({ levels: [] })).toEqual(['field_unexpected /shell/levels']);
    expect(codes({ screens: { gameOver: 'x' } })).toEqual(['field_unexpected /shell/screens/gameOver']);
    expect(codes({ screens: { title: 'Not An Id' } })).toEqual(['field_value /shell/screens/title']);
    expect(codes({ hud: ['a', 'a'] })).toEqual(['field_value /shell/hud']);
    expect(codes({ hud: Array.from({ length: 9 }, (_, i) => `d${i}`) })).toEqual(['field_value /shell/hud']);
    expect(codes({ scenes: [] })).toEqual(['field_value /shell/scenes']);
    expect(codes({ scenes: [{ scene: 'a', at: 1 }] })).toEqual(['field_unexpected /shell/scenes/0/at']);
    expect(codes({ pause: 1, status: 'on' })).toEqual(['field_type /shell/pause', 'field_type /shell/status']);
    expect(codes('shell')).toEqual(['field_type /shell']);
  });

  it('names documents of the project', () => {
    const docs = [{ uiDocumentId: 'title', name: 'T', root: { type: 'panel' } }];
    expect(refs({ uiDocuments: docs, shell: { screens: { title: 'title' } } })).toEqual([]);
    expect(refs({ uiDocuments: docs, shell: { screens: { pause: 'gone' }, hud: ['title', 'nope'] } })).toEqual(['reference_missing /shell/screens/pause', 'reference_missing /shell/hud/1']);
  });

  it('is canonical whatever order its keys were given in', () => {
    const c = canonicalShell({ status: true, scenes: [{ spawn: 's', scene: 'a' }], screens: { load: 'l', title: 't' }, pause: true, hud: ['h'] } as never);
    expect(JSON.stringify(c)).toBe(JSON.stringify({ screens: { title: 't', load: 'l' }, hud: ['h'], scenes: [{ scene: 'a', spawn: 's' }], pause: true, status: true }));
  });
});
