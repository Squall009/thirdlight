/**
 * The game host's project UI layer on a small fake DOM: rich
 * text parsing, spatial navigation, bindings (text, bar, list, visibility),
 * UI events and engine actions from buttons, keyboard focus navigation,
 * action-map switching, host screen documents and world anchors.
 */
import { describe, expect, it } from 'vitest';

import type { UiDocument, UiEventRecord, UiOutput } from '@thirdlight/runtime';
import { createUiLayer } from './ui-layer';
import { orderPick, spatialPick } from './ui-nav';
import { parseRichText, uiValueText } from './ui-text';
import { placementProps, rotationOrigin, scaleBox, tweenKeyframes } from './ui-css';

class El {
  children: El[] = [];
  attrs: Record<string, string> = {};
  style: Record<string, string> = {};
  textContent = '';
  value = '';
  parent: El | null = null;
  listeners = new Map<string, ((e?: unknown) => void)[]>();
  constructor(readonly tag: string) {}
  appendChild(c: El): void {
    c.parent?.children.splice(c.parent.children.indexOf(c), 1);
    c.parent = this;
    this.children.push(c);
  }
  insertBefore(c: El, ref: El | null): void {
    c.parent?.children.splice(c.parent.children.indexOf(c), 1);
    c.parent = this;
    const at = ref === null ? -1 : this.children.indexOf(ref);
    if (at < 0) this.children.push(c);
    else this.children.splice(at, 0, c);
  }
  remove(): void {
    if (this.parent !== null) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  addEventListener(t: string, h: (e?: unknown) => void): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), h]);
  }
  removeEventListener(t: string, h: (e?: unknown) => void): void {
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((x) => x !== h));
  }
  fire(t: string): void {
    for (const h of this.listeners.get(t) ?? []) h({ preventDefault() {} });
  }
  all(): El[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  text(): string {
    return this.textContent + this.children.map((c) => c.text()).join('');
  }
}
const fakeDom = { createElement: (t: string) => new El(t) };
const find = (root: El, pred: (e: El) => boolean): El[] => root.all().filter(pred);
const widget = (root: El, id: string): El => find(root, (e) => e.attrs['data-widget'] === id)[0]!;

const DOC: UiDocument = {
  uiDocumentId: 'shop',
  name: 'Shop',
  modal: true,
  actionMap: 'ui',
  styles: { btn: { background: '#223344', focus: { background: '#445566' } } },
  onCancel: { do: 'hide', doc: 'shop' },
  root: {
    type: 'stack',
    direction: 'column',
    children: [
      { id: 'title', type: 'text', text: '[b]Gold[/b]: {wallet.gold}' },
      { id: 'hp', type: 'bar', value: { bind: 'player.hp' }, max: { bind: 'player.max' } },
      { id: 'buy', type: 'button', text: 'Buy', style: 'btn', onClick: { do: 'event', name: 'buy', value: 5 } },
      { id: 'secret', type: 'button', text: 'Secret', visible: { bind: 'flags.secret' } },
      { id: 'goods', type: 'list', items: { bind: 'goods' }, template: { id: 'good', type: 'button', text: '{$item.name}', onClick: { do: 'event', name: 'pick', value: { bind: '$index' } } } },
      { id: 'resume', type: 'button', text: 'Resume', onClick: { do: 'engine', action: 'resume' } },
    ],
  },
};
const HUD: UiDocument = { uiDocumentId: 'hud', name: 'HUD', root: { type: 'panel', children: [{ id: 'tag', type: 'text', text: 'Hi', worldAnchor: { entity: 'npc-1', clamp: true, margin: 10 } }] } };

function layer() {
  const container = new El('div');
  const events: UiEventRecord[] = [];
  const engine: string[] = [];
  const maps: (readonly string[] | null)[] = [];
  const l = createUiLayer({
    dom: fakeDom as never,
    container: container as never,
    documents: [DOC, HUD],
    readArtifact: async () => new ArrayBuffer(0),
    queueEvent: (e) => events.push(e),
    engineAction: (a) => engine.push(a.action),
    setActiveMaps: (m) => maps.push(m),
    viewport: () => ({ width: 1000, height: 500 }),
  });
  const apply = (o: Partial<UiOutput>) => l.applyOutput({ set: [], commands: [], ...o });
  return { l, container, events, engine, maps, apply };
}

describe('rich text, navigation and CSS helpers (pure)', () => {
  it('parses markup, placeholders and icons; unknown tags stay text', () => {
    expect(parseRichText('a [b]bold {x.y}[/b] [icon=star] [[ [nope]')).toEqual([
      { t: 'text', text: 'a ', style: {} },
      { t: 'text', text: 'bold ', style: { bold: true } },
      { t: 'value', path: 'x.y', style: { bold: true } },
      { t: 'text', text: ' ', style: {} },
      { t: 'icon', name: 'star', style: {} },
      { t: 'text', text: ' [ [nope]', style: {} },
    ]);
    expect(parseRichText('[color=#ff0000]r[/color]')[0]).toEqual({ t: 'text', text: 'r', style: { color: '#ff0000' } });
    expect(uiValueText(1 / 3)).toBe('0.3333');
    expect(uiValueText(null)).toBe('');
  });
  it('picks the nearest widget in a direction, preferring straight ahead; order fallback wraps', () => {
    const r = (left: number, top: number) => ({ left, top, width: 10, height: 10 });
    const cands = [r(0, 0), r(0, 50), r(40, 20), r(100, 0)];
    expect(spatialPick(cands[0]!, cands, 'down', 0)).toBe(1);
    expect(spatialPick(cands[0]!, cands, 'right', 0)).toBe(2);
    expect(spatialPick(cands[0]!, cands, 'up', 0)).toBe(-1);
    expect(orderPick(3, 2, 'down')).toBe(0);
    expect(orderPick(3, 0, 'up')).toBe(2);
  });
  it('places by anchor, pivot and offset; stretches with margins; tweens as keyframes', () => {
    expect(placementProps({ type: 'text', anchor: [1, 0], offset: [-10, 8], size: [100, null] }, false)).toEqual([
      ['position', 'absolute'], ['left', 'calc(100% + -10px)'], ['width', '100px'], ['top', 'calc(0% + 8px)'], ['transform', 'translate(-100%, 0%)'],
    ]);
    expect(placementProps({ type: 'panel', stretch: 'both', margin: [1, 2, 3, 4] }, false)).toContainEqual(['right', '3px']);
    expect(tweenKeyframes({ kind: 'stamp', duration: 0.3 }).keyframes[0]).toEqual({ scale: '1.8', opacity: 0 });
    expect(tweenKeyframes({ kind: 'slide', duration: 1, direction: 'left', distance: 20 }).keyframes).toEqual([{ translate: '-20px 0px' }, { translate: '0px 0px' }]);
  });
});

describe('the UI layer', () => {
  it('draws shown documents bound to the view model; lists repeat; visibility binds', () => {
    const { l, container, apply } = layer();
    apply({ set: [['wallet', { gold: 12 }], ['player', { hp: 3, max: 4 }], ['goods', [{ name: 'Apple' }, { name: 'Pear' }]]], shown: [{ doc: 'shop', layer: 0, modal: true }] });
    l.frame();
    const root = container.children[0]!;
    const doc = find(root, (e) => e.attrs['data-tl-ui-doc'] === 'shop')[0]!;
    expect(widget(doc, 'title').text()).toBe('Gold: 12');
    expect(widget(doc, 'hp').attrs['data-value']).toBe('0.75');
    expect(find(doc, (e) => e.attrs['data-widget'] === 'good').map((e) => e.text())).toEqual(['Apple', 'Pear']);
    expect(widget(doc, 'secret').style['display']).toBe('none');
    apply({ set: [['wallet.gold', 7], ['flags', { secret: true }], ['goods', [{ name: 'Fig' }]]] });
    l.frame();
    expect(widget(doc, 'title').text()).toBe('Gold: 7');
    expect(widget(doc, 'secret').style['display']).toBe('');
    expect(find(doc, (e) => e.attrs['data-widget'] === 'good').map((e) => e.text())).toEqual(['Fig']);
    apply({ shown: [] });
    expect(find(container, (e) => e.attrs['data-tl-ui-doc'] === 'shop')).toHaveLength(0);
  });

  it('buttons raise UI events and engine actions; keyboard edges move the focus; cancel runs the document\'s action; the action map follows the focus', () => {
    const { l, container, events, engine, maps, apply } = layer();
    apply({ set: [['goods', [{ name: 'Apple' }, { name: 'Pear' }]]], shown: [{ doc: 'shop', layer: 0, modal: true }] });
    l.frame();
    expect(maps).toEqual([['ui']]);
    expect(l.observe().focus).toEqual({ doc: 'shop', widget: 'buy' });
    const doc = find(container, (e) => e.attrs['data-tl-ui-doc'] === 'shop')[0]!;
    widget(doc, 'buy').fire('click');
    expect(events.at(-1)).toEqual({ kind: 'click', doc: 'shop', widget: 'buy', name: 'buy', value: 5 });
    const none = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };
    const rest = l.handleEdges({ ...none, down: true, pause: true });
    expect(rest.down).toBe(false);
    expect(rest.pause).toBe(true); // passes through (the host's pause)
    expect(l.observe().focus).toEqual({ doc: 'shop', widget: 'good', index: 0 });
    expect(events.at(-1)).toEqual({ kind: 'focus', doc: 'shop', widget: 'good', name: '', index: 0 });
    l.handleEdges({ ...none, down: true });
    l.handleEdges({ ...none, submit: true });
    expect(events.at(-1)).toEqual({ kind: 'click', doc: 'shop', widget: 'good', name: 'pick', value: 1, index: 1 });
    l.handleEdges({ ...none, down: true });
    l.handleEdges({ ...none, submit: true });
    expect(engine).toEqual(['resume']);
    l.handleEdges({ ...none, cancel: true });
    expect(events.at(-1)).toEqual({ kind: 'hide', doc: 'shop', widget: '', name: '' });
    apply({ shown: [] });
    expect(maps.at(-1)).toBeNull();
    expect(l.hasFocus()).toBe(false);
  });

  it('draws a host screen document above the simulation\'s; world anchors follow, clamp to the edge or hide', () => {
    const { l, container, apply } = layer();
    apply({ shown: [{ doc: 'hud', layer: 0, modal: false }] });
    l.showScreen('shop');
    l.frame();
    expect(l.observe()).toMatchObject({ shown: ['hud'], screen: 'shop' });
    expect(l.hasFocus()).toBe(true);
    const tag = find(container, (e) => e.attrs['data-widget'] === 'tag')[0]!;
    l.updateAnchors((_t, out) => {
      out[0] = 0.25;
      out[1] = 0.5;
      out[2] = 1;
      return true;
    });
    expect([tag.style['left'], tag.style['top'], tag.attrs['data-anchor']]).toEqual(['250px', '250px', 'on']);
    l.updateAnchors((_t, out) => {
      out[0] = 1.5;
      out[1] = 0.5;
      out[2] = 1;
      return true;
    });
    expect([tag.style['left'], tag.attrs['data-anchor']]).toEqual(['990px', 'clamped']);
    l.updateAnchors(() => false);
    expect(tag.attrs['data-anchor']).toBe('offscreen');
    l.showScreen(null);
    expect(l.observe().screen).toBeNull();
    l.dispose();
    expect(container.children).toHaveLength(0);
  });
});

describe('glyphs in UI texts and rebinding engine actions', () => {
  it('{action:jump} is a glyph token; it draws the device\'s glyph and redraws when the glyph key changes', () => {
    expect(parseRichText('Press {action:jump} to jump')).toEqual([
      { t: 'text', text: 'Press ', style: {} },
      { t: 'glyph', action: 'jump', style: {} },
      { t: 'text', text: ' to jump', style: {} },
    ]);
    const doc: UiDocument = { uiDocumentId: 'tip', name: 'Tip', root: { type: 'panel', children: [{ id: 'hint', type: 'text', text: 'Press {action:jump}' }, { id: 'rb', type: 'button', text: 'Rebind', onClick: { do: 'engine', action: 'rebind', input: 'jump', device: 'gamepad' } }] } };
    const container = new El('div');
    let pad = false;
    let key = 0;
    const engine: unknown[] = [];
    const l = createUiLayer({
      dom: fakeDom as never,
      container: container as never,
      documents: [doc],
      readArtifact: async () => new ArrayBuffer(0),
      queueEvent: () => undefined,
      engineAction: (a) => engine.push(a),
      viewport: () => ({ width: 1000, height: 500 }),
      glyph: (action) => (action !== 'jump' ? null : pad ? { label: 'A', icon: 'pad-south', url: 'data:image/svg+xml,a' } : { label: 'Space', icon: 'key', url: 'data:image/svg+xml,s' }),
      glyphKey: () => String(key),
    });
    l.applyOutput({ set: [], commands: [], shown: [{ doc: 'tip', layer: 0, modal: false }] });
    l.frame();
    const glyph = (): El => find(container, (e) => e.attrs['data-action'] === 'jump')[0]!;
    expect(glyph().attrs['data-glyph']).toBe('Space');
    expect(glyph().attrs['aria-label']).toBe('Space');
    expect(glyph().style['background'] ?? '').toContain('data:image/svg+xml,s');
    pad = true;
    l.frame();
    expect(glyph().attrs['data-glyph']).toBe('Space'); // nothing said it changed
    key = 1;
    l.frame();
    expect(glyph().attrs['data-glyph']).toBe('A');
    expect(glyph().attrs['data-glyph-icon']).toBe('pad-south');
    find(container, (e) => e.attrs['data-widget'] === 'rb')[0]!.fire('click');
    expect(engine).toEqual([{ do: 'engine', action: 'rebind', input: 'jump', device: 'gamepad' }]);
  });
});

describe('content text, typewriter reveal and dialogue actions', () => {
  const DLG: UiDocument = {
    uiDocumentId: 'talk',
    name: 'Talk',
    root: {
      type: 'panel',
      children: [
        { id: 'line', type: 'text', content: { bind: 'd.text' }, reveal: { bind: 'd.reveal' } },
        { id: 'next', type: 'button', text: 'Next', onClick: { do: 'dialogue', input: 'advance' } },
        { id: 'opts', type: 'list', items: { bind: 'd.choices' }, template: { id: 'opt', type: 'button', text: '{$item.text}', onClick: { do: 'dialogue', input: 'choose' } } },
      ],
    },
  } as UiDocument;
  it('draws the bound rich text (braces are text), hides characters past the reveal in place, and sends dialogue inputs', () => {
    const container = new El('div');
    const inputs: unknown[] = [];
    const l = createUiLayer({ dom: fakeDom as never, container: container as never, documents: [DLG], readArtifact: async () => new ArrayBuffer(0), queueEvent: () => undefined, dialogueInput: (i) => inputs.push(i), engineAction: () => undefined, viewport: () => ({ width: 800, height: 450 }) });
    l.applyOutput({ set: [['d', { text: 'Hi [b]{you}[/b]!', reveal: 4, choices: [{ text: 'A' }, { text: 'B' }] }]], commands: [], shown: [{ doc: 'talk', layer: 0, modal: false }] });
    l.frame();
    const line = widget(container, 'line');
    expect(line.text()).toBe('Hi {you}!');
    const hidden = find(line, (e) => e.style['visibility'] === 'hidden');
    expect(hidden.map((e) => e.text()).join('')).toBe('you}!');
    expect(line.attrs['data-reveal']).toBe('4');
    // The whole line once the reveal passes its length.
    l.applyOutput({ set: [['d.reveal', 99]], commands: [] });
    l.frame();
    expect(find(widget(container, 'line'), (e) => e.style['visibility'] === 'hidden')).toEqual([]);
    widget(container, 'next').fire('click');
    find(container, (e) => e.attrs['data-widget'] === 'opt')[1]!.fire('click');
    expect(inputs).toEqual([{ kind: 'advance' }, { kind: 'choose', index: 1 }]);
  });
});

describe('a bindable size and start angle', () => {
  it('a bound size axis follows the view model (a non-number sizes it to the content); a radial bar\'s start angle binds', () => {
    const DOC2: UiDocument = {
      uiDocumentId: 'gauge',
      name: 'Gauge',
      root: {
        type: 'panel',
        children: [
          { id: 'box', type: 'panel', anchor: [0, 0], size: [{ bind: 'hud.w' }, 20] },
          { id: 'wide', type: 'panel', stretch: 'x', size: [{ bind: 'hud.w' }, { bind: 'hud.h' }] },
          { id: 'ring', type: 'bar', shape: 'radial', size: [40, 40], value: 0.25, startAngle: { bind: 'hud.a' }, fillColor: '#ff0000' },
        ],
      },
    };
    const container = new El('div');
    const l = createUiLayer({ dom: fakeDom as never, container: container as never, documents: [DOC2], readArtifact: async () => new ArrayBuffer(0), queueEvent: () => undefined, engineAction: () => undefined, viewport: () => ({ width: 800, height: 450 }) });
    l.applyOutput({ set: [['hud', { w: 120, h: 30, a: 90 }]], commands: [], shown: [{ doc: 'gauge', layer: 0, modal: false }] });
    l.frame();
    expect(widget(container, 'box').style['width']).toBe('120px');
    expect(widget(container, 'box').style['height']).toBe('20px');
    // A stretched axis keeps its stretch; the other bound axis applies.
    expect(widget(container, 'wide').style['width']).toBeUndefined();
    expect(widget(container, 'wide').style['height']).toBe('30px');
    const fill = () => widget(container, 'ring').children[0]!.style['background'];
    expect(fill()).toContain('from 90deg');
    l.applyOutput({ set: [['hud.w', 64], ['hud.a', -45]], commands: [] });
    l.frame();
    expect(widget(container, 'box').style['width']).toBe('64px');
    expect(fill()).toContain('from -45deg');
    l.applyOutput({ set: [['hud.w', 'wide']], commands: [] });
    l.frame();
    expect(widget(container, 'box').style['width']).toBe('');
  });
});

describe('bound lists keep their items; offset, opacity and rotation; scale modes; the view', () => {
  const MENU: UiDocument = {
    uiDocumentId: 'menu',
    name: 'Menu',
    modal: true,
    root: {
      type: 'stack',
      children: [
        { id: 'tab', type: 'button', text: 'Tab' },
        { id: 'rows', type: 'list', items: { bind: 'rows' }, template: { id: 'row', type: 'button', text: '{$item.label} {$item.value}' } },
        { id: 'slots', type: 'list', items: { bind: 'slots' }, itemKey: 'id', template: { id: 'slot', type: 'button', text: '{$item.id}' } },
      ],
    },
  };
  function menuLayer() {
    const container = new El('div');
    const events: UiEventRecord[] = [];
    const l = createUiLayer({ dom: fakeDom as never, container: container as never, documents: [MENU], readArtifact: async () => new ArrayBuffer(0), queueEvent: (e) => events.push(e), engineAction: () => undefined, viewport: () => ({ width: 1000, height: 500 }) });
    const apply = (o: Partial<UiOutput>) => l.applyOutput({ set: [], commands: [], ...o });
    return { l, container, events, apply };
  }
  const rows = (v: number) => [{ label: 'Music', value: v }, { label: 'Sfx', value: 1 }];
  const none = { up: false, down: false, left: false, right: false, submit: false, cancel: false, pause: false };

  it('a value change keeps the item widgets and the focus (by index); the focus moves on from there', () => {
    const { l, container, events, apply } = menuLayer();
    apply({ set: [['rows', rows(0.8)]], shown: [{ doc: 'menu', layer: 0, modal: true }] });
    l.frame();
    l.handleEdges({ ...none, down: true });
    expect(l.observe().focus).toEqual({ doc: 'menu', widget: 'row', index: 0 });
    const before = find(container, (e) => e.attrs['data-widget'] === 'row');
    apply({ set: [['rows', rows(0.9)]] });
    l.frame();
    const after = find(container, (e) => e.attrs['data-widget'] === 'row');
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[0]!.text()).toBe('Music 0.9');
    expect(l.observe().focus).toEqual({ doc: 'menu', widget: 'row', index: 0 });
    l.handleEdges({ ...none, down: true });
    expect(l.observe().focus).toEqual({ doc: 'menu', widget: 'row', index: 1 });
    expect(events.at(-1)).toMatchObject({ kind: 'focus', widget: 'row', index: 1 });
  });

  it('an itemKey keeps an item through a reorder (its element moves, its index follows); a removed focused item passes the focus to the item at its place', () => {
    const { l, container, apply } = menuLayer();
    apply({ set: [['slots', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]]], shown: [{ doc: 'menu', layer: 0, modal: true }] });
    l.frame();
    const els = () => find(container, (e) => e.attrs['data-widget'] === 'slot');
    const [a, b, c] = els();
    apply({ commands: [{ op: 'focus', doc: 'menu', widget: 'slot', index: 2 }] });
    expect(l.observe().focus).toEqual({ doc: 'menu', widget: 'slot', index: 2 });
    apply({ set: [['slots', [{ id: 'c' }, { id: 'a' }, { id: 'b' }]]] });
    l.frame();
    expect(els()).toEqual([c, a, b]);
    expect(els().map((e) => e.attrs['data-index'])).toEqual(['0', '1', '2']);
    expect(l.observe().focus).toEqual({ doc: 'menu', widget: 'slot', index: 0 });
    // c (focused) goes: the focus goes to the item now first, not the document's first widget.
    apply({ set: [['slots', [{ id: 'a' }, { id: 'b' }]]] });
    l.frame();
    expect(els()).toEqual([a, b]);
    expect(l.observe().focus).toEqual({ doc: 'menu', widget: 'slot', index: 0 });
  });

  it('offset, opacity and rotation read the view model; a non-number puts them back', () => {
    const container = new El('div');
    const l = createUiLayer({
      dom: fakeDom as never, container: container as never, readArtifact: async () => new ArrayBuffer(0), queueEvent: () => undefined, engineAction: () => undefined, viewport: () => ({ width: 1000, height: 500 }),
      documents: [{ uiDocumentId: 'fx', name: 'Fx', root: { type: 'panel', children: [{ id: 'petal', type: 'panel', anchor: [0.5, 1], pivot: [0.5, 0.5], offset: [{ bind: 'p.x' }, -20], size: [10, 10], opacity: { bind: 'p.a' }, rotation: { bind: 'p.r' } }] } }],
    });
    l.applyOutput({ set: [['p', { x: 30, a: 0.25, r: 45 }]], shown: [{ doc: 'fx', layer: 0, modal: false }], commands: [] });
    l.frame();
    const petal = widget(container, 'petal');
    expect([petal.style['left'], petal.style['top'], petal.style['filter'], petal.style['rotate'], petal.style['transform-origin']]).toEqual(['calc(50% + 30px)', 'calc(100% + -20px)', 'opacity(0.25)', '45deg', '0px 0px']);
    l.applyOutput({ set: [['p', { x: 'far', a: 2 }]], commands: [] });
    l.frame();
    expect([petal.style['left'], petal.style['filter'], petal.style['rotate']]).toEqual(['calc(50% + 0px)', '', '']);
    expect(rotationOrigin({ type: 'panel', rotation: 5 }, true)).toBe('50% 50%');
  });

  it('scale modes: fit, cover and expand; $flow.view is the view drawn over', () => {
    expect(scaleBox('fit', [1920, 1080], 2560, 1080)).toEqual({ s: 1, width: 1920, height: 1080, ox: 320, oy: 0 });
    expect(scaleBox('cover', [1920, 1080], 2560, 1080)).toEqual({ s: 2560 / 1920, width: 1920, height: 1080, ox: 0, oy: (1080 - 1080 * (2560 / 1920)) / 2 });
    expect(scaleBox('expand', [1920, 1080], 2560, 1080)).toEqual({ s: 1, width: 2560, height: 1080, ox: 0, oy: 0 });
    expect(scaleBox('expand', [1920, 1080], 960, 720)).toEqual({ s: 0.5, width: 1920, height: 1440, ox: 0, oy: 0 });
    const container = new El('div');
    const l = createUiLayer({
      dom: fakeDom as never, container: container as never, readArtifact: async () => new ArrayBuffer(0), queueEvent: () => undefined, engineAction: () => undefined, viewport: () => ({ width: 800, height: 400 }),
      documents: [{ uiDocumentId: 'v', name: 'V', root: { type: 'panel', children: [{ id: 'size', type: 'text', text: '{$flow.view.width}x{$flow.view.height} {$flow.view.aspect}' }] } }],
    });
    l.applyOutput({ set: [], shown: [{ doc: 'v', layer: 0, modal: false }], commands: [] });
    l.frame();
    expect(widget(container, 'size').text()).toBe('800x400 2');
    expect(l.view()).toMatchObject({ width: 800, height: 400, aspect: 2 });
  });
});
