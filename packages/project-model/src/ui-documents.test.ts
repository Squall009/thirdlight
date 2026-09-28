/**
 * Phase 23.9a — UI documents and themes as project data: shape rules,
 * engine limits, document-local references, project references (themes,
 * styles, icons, assets, show/hide targets) and the canonical
 * form. Neutral fixtures.
 */
import { describe, expect, it } from 'vitest';

import type { ModelErrorV2 } from './errors';
import { canonicalUiDocument, uiAssetRefs, uiDocumentsForRuntime, validateUiDocument, validateUiReferences, validateUiTheme, UI_LIMITS, type UiDocument, type UiTheme } from './ui-documents';

const doc = (over: Partial<UiDocument> = {}): UiDocument => ({
  uiDocumentId: 'hud',
  name: 'HUD',
  styles: { panel: { background: '#10203080', padding: 8, radius: 6, hover: { background: '#203040' } } },
  tweens: { pop: { kind: 'stamp', duration: 0.3 } },
  showTween: 'pop',
  root: {
    type: 'panel',
    stretch: 'both',
    children: [
      { id: 'hp', type: 'bar', anchor: [0, 0], offset: [16, 16], size: [200, 16], value: { bind: 'player.hp' }, max: { bind: 'player.max' }, fillColor: '#40c040' },
      { id: 'label', type: 'text', text: '[b]Score[/b] {score} [icon=star]', style: 'panel' },
      {
        id: 'menu',
        type: 'stack',
        direction: 'column',
        gap: 4,
        children: [
          { id: 'ok', type: 'button', text: 'OK', onClick: { do: 'event', name: 'ok', value: 1 }, nav: { down: 'cancel' } },
          { id: 'cancel', type: 'button', text: 'Cancel', onClick: [{ do: 'hide', doc: 'hud' }, { do: 'engine', action: 'resume' }] },
        ],
      },
      { id: 'items', type: 'list', items: { bind: 'inv' }, direction: 'grid', columns: 4, template: { type: 'button', text: '{$item.name}', onClick: { do: 'event', name: 'use', value: { bind: '$index' } } } },
      { id: 'tag', type: 'text', text: '{$item}', worldAnchor: { entity: { bind: 'target' }, offset: [0, 2, 0], clamp: true } },
    ],
  },
  icons: { star: { asset: 'tex-star' } },
  ...over,
});

const errs = (v: unknown): ModelErrorV2[] => {
  const e: ModelErrorV2[] = [];
  validateUiDocument(v, '', e);
  return e;
};

describe('UI documents: shape and limits', () => {
  it('accepts a document with every widget kind, bindings, actions, tweens and a world anchor', () => {
    expect(errs(doc())).toEqual([]);
  });

  it('refuses unknown fields, bad values, bad bindings and broken local references', () => {
    const cases: [string, unknown][] = [
      ['unknown field', doc({ root: { type: 'panel', colour: 'red' } as never })],
      ['unknown widget type', doc({ root: { type: 'slider' } as never })],
      ['bad colour', doc({ styles: { a: { color: 'red' } } })],
      ['raw css', doc({ styles: { a: { css: 'x' } as never } })],
      ['bad binding', doc({ root: { type: 'bar', value: { bind: 'a b' } } })],
      ['bad placeholder', doc({ root: { type: 'text', text: '{a..b}' } })],
      ['nav to nothing', doc({ root: { type: 'button', id: 'x', nav: { up: 'ghost' } } })],
      ['tween missing', doc({ showTween: 'nope' })],
      ['duplicate id', doc({ root: { type: 'panel', children: [{ type: 'text', id: 'a', text: '' }, { type: 'text', id: 'a', text: '' }] } })],
      ['list without template', doc({ root: { type: 'list', items: { bind: 'x' } } as never })],
      ['nested list', doc({ root: { type: 'list', items: { bind: 'x' }, template: { type: 'list', items: { bind: 'y' }, template: { type: 'text', text: '' } } } })],
      ['anchor with both', doc({ root: { type: 'text', text: '', worldAnchor: { entity: 'e', point: [0, 0, 0] } } })],
      ['bad engine action', doc({ root: { type: 'button', onClick: { do: 'engine', action: 'explode' } as never } })],
      ['tinted 9-slice', doc({ root: { type: 'image', image: 'tex', slice: [4, 4, 4, 4], tint: '#fff' } })],
      ['bad action map', doc({ actionMap: 'combat' })],
    ];
    for (const [what, v] of cases) expect(errs(v).length, what).toBeGreaterThan(0);
  });

  it('keeps the engine limits: widgets, depth and bytes', () => {
    const many = { type: 'panel' as const, children: Array.from({ length: 5 }, () => ({ type: 'panel' as const, children: Array.from({ length: 110 }, () => ({ type: 'text' as const, text: 'x' })) })) };
    expect(errs(doc({ root: many })).some((e) => e.code === 'limits_exceeded')).toBe(true);
    let deep: Record<string, unknown> = { type: 'text', text: 'x' };
    for (let i = 0; i < UI_LIMITS.depth + 1; i++) deep = { type: 'panel', children: [deep] };
    expect(errs(doc({ root: deep as never })).some((e) => e.code === 'limits_exceeded')).toBe(true);
    const big = { type: 'panel' as const, children: Array.from({ length: 60 }, () => ({ type: 'text' as const, text: 'y'.repeat(1000) })) };
    expect(errs(doc({ root: big })).some((e) => e.code === 'limits_exceeded')).toBe(true);
  });
});

describe('UI documents: project references', () => {
  const theme: UiTheme = { uiThemeId: 'base', name: 'Base', styles: { title: { font: 'font-a', fontSize: 24 } }, icons: { coin: { asset: 'tex-star', rect: [0, 0, 16, 16] } } };
  const kinds: Record<string, string> = { 'tex-star': 'texture', 'font-a': 'font' };
  const check = (content: Record<string, unknown>): ModelErrorV2[] => {
    const e: ModelErrorV2[] = [];
    validateUiReferences(content, e, (id) => kinds[id]);
    return e;
  };

  it('resolves styles and icons through the theme, assets by kind, show/hide targets', () => {
    const d = doc({ theme: 'base', root: { type: 'text', text: '[icon=coin]', style: ['title'] } });
    expect(validateUiTheme(theme, '', [])).not.toBeNull();
    expect(check({ uiDocuments: [d], uiThemes: [theme] })).toEqual([]);
    expect(check({ uiDocuments: [d], uiThemes: [] }).map((e) => e.path)).toContain('/uiDocuments/0/theme');
    const noStyle = doc({ root: { type: 'text', text: '', style: 'ghost' } });
    expect(check({ uiDocuments: [noStyle] }).some((e) => e.message.includes('ghost'))).toBe(true);
    const wrongKind = doc({ root: { type: 'image', image: 'font-a' } });
    expect(check({ uiDocuments: [wrongKind] }).some((e) => e.code === 'asset_reference_missing')).toBe(true);
    const badShow = doc({ root: { type: 'button', onClick: { do: 'show', doc: 'ghost' } } });
    expect(check({ uiDocuments: [badShow] }).some((e) => e.message.includes('ghost'))).toBe(true);
    expect(uiAssetRefs([d], [theme])).toEqual({ textures: ['tex-star'], fonts: ['font-a'] });
  });

  it('canonical form sorts keys and drops nothing; runtime rows carry id, layer and modal', () => {
    const d = doc({ layer: 3, modal: true });
    const c = canonicalUiDocument(d);
    expect(JSON.parse(JSON.stringify(c))).toEqual(JSON.parse(JSON.stringify(d)));
    expect(Object.keys(c)).toEqual([...Object.keys(c)].sort());
    expect(canonicalUiDocument(JSON.parse(JSON.stringify(c)))).toEqual(c);
    expect(uiDocumentsForRuntime([d, doc({ uiDocumentId: 'a-menu' })])).toEqual([
      { uiDocumentId: 'a-menu', layer: 0, modal: false },
      { uiDocumentId: 'hud', layer: 3, modal: true },
    ]);
    expect(uiDocumentsForRuntime([])).toBeUndefined();
  });
});

describe('phase 23.14: rebinding engine actions', () => {
  const docWith = (onClick: unknown): unknown => ({ uiDocumentId: 'keys', name: 'Keys', root: { type: 'button', text: 'x', onClick } });
  it('rebind names its input action (device, index, part, policy optional); cancelRebind and resetBindings', () => {
    expect(errs(docWith({ do: 'engine', action: 'rebind', input: 'jump', device: 'gamepad', index: 1, part: 'up', policy: 'refuse' }))).toEqual([]);
    expect(errs(docWith([{ do: 'engine', action: 'cancelRebind' }, { do: 'engine', action: 'resetBindings' }, { do: 'engine', action: 'resetBindings', input: 'jump' }]))).toEqual([]);
    expect(errs(docWith({ do: 'engine', action: 'rebind' })).map((e) => e.path)).toEqual(['/root/onClick/input']);
    expect(errs(docWith({ do: 'engine', action: 'rebind', input: 'jump', device: 'mouse', index: 9, part: 'in', policy: 'maybe' })).map((e) => e.path).sort()).toEqual(['/root/onClick/device', '/root/onClick/index', '/root/onClick/part', '/root/onClick/policy']);
  });
});
