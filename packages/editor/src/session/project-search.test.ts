import { describe, expect, it } from 'vitest';

import { kindsOfType, parseSearch, typeOf, withType } from './project-search';

describe('the project window search', () => {
  it('reads t: kinds, l: labels and the words', () => {
    expect(parseSearch('t:audio l:voice hello')).toEqual({ kinds: ['audio'], labels: ['voice'], text: 'hello' });
    expect(parseSearch('  crate  ')).toEqual({ kinds: null, labels: [], text: 'crate' });
    expect(parseSearch('t:AudioClip t:Texture2D l:a l:b big red')).toEqual({ kinds: ['audio', 'texture'], labels: ['a', 'b'], text: 'big red' });
  });

  it('names kinds by kind, Unity type name or the start of a kind; an unknown type finds nothing', () => {
    expect(kindsOfType('material')).toEqual(['material']);
    expect(kindsOfType('Prefab')).toEqual(['prefab']);
    expect(kindsOfType('mat')).toEqual(['material']);
    expect(kindsOfType('script')).toEqual(['behavior', 'library']);
    expect(kindsOfType('asset')).toEqual(['model', 'audio', 'texture', 'font']);
    expect(kindsOfType('zzz')).toEqual(['none:zzz']);
  });

  it('the kind menu writes and reads the t: of the box', () => {
    expect(withType('l:voice t:model hello', 'audio')).toBe('t:audio l:voice hello');
    expect(withType('t:audio hello', null)).toBe('hello');
    expect(typeOf('t:audio hello')).toBe('audio');
    expect(typeOf('t:script')).toBeNull();
    expect(typeOf('hello')).toBeNull();
  });
});
