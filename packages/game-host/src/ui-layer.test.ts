/**
 * Phase 23.9a — the game host's project UI layer on a small fake DOM: rich
 * text parsing, spatial navigation, bindings (text, bar, list, visibility),
 * UI events and engine actions from buttons, keyboard focus navigation,
 * action-map switching, host screen documents and world anchors.
 */
import { describe, expect, it } from 'vitest';

import type { UiDocument, UiEventRecord, UiOutput } from '@thirdlight/runtime';
import { createUiLayer } from './ui-layer';
import { orderPick, spatialPick } from './ui-nav';
import { parseRichText, uiValueText } from './ui-text';
import { placementProps, tweenKeyframes } from './ui-css';

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

describe('phase 23.14: glyphs in UI texts and rebinding engine actions', () => {
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

describe('phase 23.16: content text, typewriter reveal and dialogue actions', () => {
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
