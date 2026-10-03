/**
 * Project UI styles, layout and tweens as CSS — pure functions
 * from validated document data to CSS declarations and Web Animations
 * keyframes. Every value comes from the closed style vocabulary (numbers,
 * validated colours, generated font-family names and blob: URLs the host
 * made), never raw CSS from the project.
 */
import type { UiScaleMode, UiStyle, UiStyleValues, UiTween, UiWidget } from '@thirdlight/runtime';

/** The generic font families (the same stacks as the built-in menus). */
export const GENERIC_FONTS: Readonly<Record<string, string>> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace',
  rounded: '"Nunito", "Varela Round", system-ui, sans-serif',
};

/** The CSS family name a project font asset is registered under (FontFace). */
export const fontFamilyOf = (assetId: string): string => `tl-font-${assetId}`;

export interface CssAssets {
  /** The blob: URL of a texture asset (null while its bytes are not read yet). */
  image(assetId: string): string | null;
  /** The font stack for a style's `font` (a project font asset or a generic family). */
  font(font: string): string;
}

const px = (n: number): string => `${Math.round(n * 1000) / 1000}px`;
const cssUrl = (u: string): string => `url("${u.replace(/["\\\n]/g, '')}")`;

/** One style's declarations (without its states). */
export function styleDeclarations(s: UiStyleValues, assets: CssAssets): string {
  const d: string[] = [];
  if (s.color !== undefined) d.push(`color:${s.color}`);
  if (s.background !== undefined) d.push(`background-color:${s.background}`);
  if (s.backgroundImage !== undefined) {
    const url = assets.image(s.backgroundImage);
    if (url !== null) {
      if (s.slice !== undefined) {
        const [t, r, b, l] = s.slice;
        d.push('border-style:solid', `border-width:${px(t)} ${px(r)} ${px(b)} ${px(l)}`, `border-image:${cssUrl(url)} ${t} ${r} ${b} ${l} fill / ${px(t)} ${px(r)} ${px(b)} ${px(l)} stretch`);
      } else d.push(`background-image:${cssUrl(url)}`, 'background-size:100% 100%', 'background-repeat:no-repeat');
    }
  }
  if (s.opacity !== undefined) d.push(`opacity:${s.opacity}`);
  if (s.font !== undefined) d.push(`font-family:${assets.font(s.font)}`);
  if (s.fontSize !== undefined) d.push(`font-size:${px(s.fontSize)}`);
  if (s.bold !== undefined) d.push(`font-weight:${s.bold ? 700 : 400}`);
  if (s.italic !== undefined) d.push(`font-style:${s.italic ? 'italic' : 'normal'}`);
  if (s.align !== undefined) d.push(`text-align:${s.align}`);
  if (s.lineHeight !== undefined) d.push(`line-height:${s.lineHeight}`);
  if (s.letterSpacing !== undefined) d.push(`letter-spacing:${px(s.letterSpacing)}`);
  if (s.padding !== undefined) {
    const p = typeof s.padding === 'number' ? [s.padding, s.padding, s.padding, s.padding] : s.padding;
    d.push(`padding:${p.map(px).join(' ')}`);
  }
  if (s.radius !== undefined) d.push(`border-radius:${px(s.radius)}`);
  if (s.borderWidth !== undefined && !(s.backgroundImage !== undefined && s.slice !== undefined)) d.push(`border-width:${px(s.borderWidth)}`, 'border-style:solid');
  if (s.borderColor !== undefined) d.push(`border-color:${s.borderColor}`);
  if (s.textShadow !== undefined) d.push(`text-shadow:0 1px 2px ${s.textShadow}`);
  if (s.shadow !== undefined) d.push(`box-shadow:0 4px 12px ${s.shadow}`);
  return d.join(';');
}

/** The rules of one style under a class: the base, then its hover / focus / pressed / disabled states. */
export function styleRules(cls: string, s: UiStyle, assets: CssAssets): string {
  const rules: string[] = [];
  const base = styleDeclarations(s, assets);
  if (base !== '') rules.push(`.${cls}{${base}}`);
  const state = (sel: string, v: UiStyleValues | undefined): void => {
    if (v === undefined) return;
    const decl = styleDeclarations(v, assets);
    if (decl !== '') rules.push(`${sel}{${decl}}`);
  };
  state(`.${cls}.is-hover`, s.hover);
  state(`.${cls}.is-focused`, s.focus);
  state(`.${cls}.is-pressed`, s.pressed);
  state(`.${cls}.is-disabled`, s.disabled);
  return rules.join('\n');
}

/** The base rules every UI document shares (scoped by `.tl-ui`). */
export const UI_BASE_CSS = `
.tl-ui{position:fixed;inset:0;pointer-events:none;overflow:hidden;font-family:${GENERIC_FONTS['sans']};color:#f4f1e8}
.tl-ui__backdrop{position:absolute;inset:0;pointer-events:auto}
.tl-ui__root{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:0 0}
.tl-ui-w{box-sizing:border-box}
.tl-ui-button,.tl-ui-input{pointer-events:auto;font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer;text-align:inherit}
.tl-ui-input{cursor:text}
.tl-ui-button.is-disabled{cursor:default}
.tl-ui-text{white-space:pre-wrap}
.tl-ui-text.is-nowrap{white-space:pre}
.tl-ui-icon{display:inline-block;width:1em;height:1em;vertical-align:-0.15em;background-repeat:no-repeat;background-size:100% 100%}
.tl-ui-bar{position:relative;overflow:hidden}
.tl-ui-bar__fill{position:absolute;left:0;top:0;width:100%;height:100%}
.tl-ui-anchored{position:absolute}
.tl-ui-anchored.is-offscreen{display:none}
.tl-ui-indicator{display:none}
.tl-ui-anchored.is-clamped .tl-ui-indicator{display:block;transform:rotate(var(--tl-angle,0rad))}
`;

/** One CSS property to set on an element (through the CSSOM: a page's CSP may refuse style attributes). */
export type CssProp = readonly [string, string];

/**
 * A widget's placement: inside a panel (anchors + pivot + offset, a size or
 * a stretch with margins), or as a flow item of a stack/grid/list parent
 * (only its size and grow apply).
 */
export function placementProps(w: UiWidget, parentFlows: boolean): CssProp[] {
  const out: CssProp[] = [];
  const size = w.size ?? [null, null];
  if (parentFlows) {
    out.push(['position', 'relative']);
    if (typeof size[0] === 'number') out.push(['width', px(size[0])]);
    if (typeof size[1] === 'number') out.push(['height', px(size[1])]);
    if (w.grow !== undefined) out.push(['flex-grow', String(w.grow)]);
    if (w.stretch === 'x' || w.stretch === 'both') out.push(['align-self', 'stretch']);
    return out;
  }
  out.push(['position', 'absolute']);
  const anchor = w.anchor ?? [0, 0];
  const pivot = w.pivot ?? anchor;
  // A bound axis is placed at its anchor here; the layer moves it by the view model's value.
  const offset = (w.offset ?? [0, 0]).map((x) => (typeof x === 'number' ? x : 0));
  const margin = w.margin ?? [0, 0, 0, 0];
  const stretchX = w.stretch === 'x' || w.stretch === 'both';
  const stretchY = w.stretch === 'y' || w.stretch === 'both';
  let tx = '0px';
  let ty = '0px';
  if (stretchX) out.push(['left', px(margin[0])], ['right', px(margin[2])]);
  else {
    out.push(['left', anchorCalc(anchor[0], offset[0]!)]);
    if (typeof size[0] === 'number') out.push(['width', px(size[0])]);
    tx = `${-pivot[0] * 100}%`;
  }
  if (stretchY) out.push(['top', px(margin[1])], ['bottom', px(margin[3])]);
  else {
    out.push(['top', anchorCalc(anchor[1], offset[1]!)]);
    if (typeof size[1] === 'number') out.push(['height', px(size[1])]);
    ty = `${-pivot[1] * 100}%`;
  }
  if (tx !== '0px' || ty !== '0px') out.push(['transform', `translate(${tx}, ${ty})`]);
  return out;
}

/** A panel child's edge along one axis: its anchor in the parent plus its offset in px. */
export function anchorCalc(anchor: number, offset: number): string {
  return `calc(${anchor * 100}% + ${px(offset)})`;
}

/** The axes of a panel child's offset that read the view model ([x, y]; a stretched axis has margins instead). */
export function boundOffsetAxes(w: UiWidget, parentFlows: boolean): [boolean, boolean] {
  const offset = w.offset;
  if (offset === undefined || parentFlows || w.worldAnchor !== undefined) return [false, false];
  const bound = (v: unknown): boolean => typeof v === 'object' && v !== null && typeof (v as { bind?: unknown }).bind === 'string';
  return [bound(offset[0]) && w.stretch !== 'x' && w.stretch !== 'both', bound(offset[1]) && w.stretch !== 'y' && w.stretch !== 'both'];
}

/**
 * Where a widget turns (`transform-origin`): a panel child or a
 * world-anchored widget about its pivot — its layout transform moved the
 * pivot onto the box's top-left corner, so 0 there (a stretched axis: the
 * middle); a flowed child about its centre.
 */
export function rotationOrigin(w: UiWidget, parentFlows: boolean): string {
  if (parentFlows && w.worldAnchor === undefined) return '50% 50%';
  const x = w.worldAnchor === undefined && (w.stretch === 'x' || w.stretch === 'both') ? '50%' : '0px';
  const y = w.worldAnchor === undefined && (w.stretch === 'y' || w.stretch === 'both') ? '50%' : '0px';
  return `${x} ${y}`;
}

/**
 * The view box of a scaled document: the reference size `ref` [w, h] in a
 * view of `vw` × `vh` CSS px — the scale, the box's size in reference px and
 * where its top-left corner is in the view. `fit` shows all of it, `width` /
 * `height` match one side, `cover` fills the view (the box larger than it,
 * centred), `expand` fits and grows the box to the view's shape.
 */
export function scaleBox(mode: UiScaleMode, ref: readonly [number, number], vw: number, vh: number): { s: number; width: number; height: number; ox: number; oy: number } {
  const [rw, rh] = ref;
  const sx = vw / rw;
  const sy = vh / rh;
  const s = mode === 'width' ? sx : mode === 'height' ? sy : mode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const width = mode === 'expand' ? vw / s : rw;
  const height = mode === 'expand' ? vh / s : rh;
  return { s, width, height, ox: (vw - width * s) / 2, oy: (vh - height * s) / 2 };
}

/**
 * The axes of a widget's size that read the view model and
 * apply (a stretched axis of a panel child ignores its size), as [width, height].
 */
export function boundSizeAxes(w: UiWidget, parentFlows: boolean): [boolean, boolean] {
  const size = w.size;
  if (size === undefined) return [false, false];
  const bound = (v: unknown): boolean => typeof v === 'object' && v !== null && typeof (v as { bind?: unknown }).bind === 'string';
  const anchored = w.worldAnchor !== undefined;
  const sx = !parentFlows && !anchored && (w.stretch === 'x' || w.stretch === 'both');
  const sy = !parentFlows && !anchored && (w.stretch === 'y' || w.stretch === 'both');
  return [bound(size[0]) && !sx, bound(size[1]) && !sy];
}

const ALIGN: Readonly<Record<string, string>> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' };
const JUSTIFY: Readonly<Record<string, string>> = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around' };

/** A container's own layout: a panel positions its children, a stack/list/button flows them, a grid places them in columns. */
export function containerProps(w: UiWidget): CssProp[] {
  const out: CssProp[] = [];
  const flowDir = w.direction === 'row' || w.direction === 'column' ? w.direction : undefined;
  const grid = w.type === 'grid' || (w.type === 'list' && w.direction === 'grid');
  if (grid) {
    const cols = w.columns ?? 1;
    out.push(['display', 'grid'], ['grid-template-columns', w.cellSize !== undefined ? `repeat(${cols}, ${px(w.cellSize[0])})` : `repeat(${cols}, minmax(0, 1fr))`]);
    if (w.cellSize !== undefined) out.push(['grid-auto-rows', px(w.cellSize[1])]);
    if (w.gap !== undefined) out.push(['gap', px(w.gap)]);
    if (w.align !== undefined) out.push(['align-items', ALIGN[w.align] ?? 'stretch'], ['justify-items', ALIGN[w.align] ?? 'stretch']);
    return out;
  }
  if (w.type === 'stack' || w.type === 'list' || (w.type === 'button' && (w.children?.length ?? 0) > 0)) {
    out.push(['display', 'flex'], ['flex-direction', flowDir ?? 'column']);
    if (w.gap !== undefined) out.push(['gap', px(w.gap)]);
    if (w.align !== undefined) out.push(['align-items', ALIGN[w.align] ?? 'stretch']);
    if (w.justify !== undefined) out.push(['justify-content', JUSTIFY[w.justify] ?? 'flex-start']);
    if (w.wrap === true) out.push(['flex-wrap', 'wrap']);
  }
  return out;
}

/** The children of this widget flow (a stack, grid, list or a button with children) rather than being anchored. */
export function childrenFlow(w: UiWidget): boolean {
  return w.type === 'stack' || w.type === 'grid' || w.type === 'list' || w.type === 'button';
}

const EASING: Readonly<Record<string, string>> = {
  linear: 'linear',
  easeIn: 'cubic-bezier(0.42, 0, 1, 1)',
  easeOut: 'cubic-bezier(0, 0, 0.58, 1)',
  easeInOut: 'cubic-bezier(0.42, 0, 0.58, 1)',
  back: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
};

/**
 * A tween as Web Animations keyframes and timing. The individual `scale` /
 * `translate` properties compose with a widget's layout transform.
 */
export function tweenKeyframes(t: UiTween): { keyframes: Record<string, string | number>[]; options: { duration: number; delay: number; easing: string; fill: 'both' } } {
  const options = { duration: t.duration * 1000, delay: (t.delay ?? 0) * 1000, easing: EASING[t.easing ?? (t.kind === 'stamp' ? 'back' : 'easeOut')] ?? 'ease-out', fill: 'both' as const };
  switch (t.kind) {
    case 'fade':
      return { keyframes: [{ opacity: t.from ?? 0 }, { opacity: t.to ?? 1 }], options };
    case 'scale':
      return { keyframes: [{ scale: String(t.from ?? 0) }, { scale: String(t.to ?? 1) }], options };
    case 'stamp':
      return { keyframes: [{ scale: String(t.from ?? 1.8), opacity: 0 }, { opacity: 1, offset: 0.4 }, { scale: String(t.to ?? 1), opacity: 1 }], options };
    case 'slide': {
      const dist = t.distance ?? 40;
      const dir = t.direction ?? 'down';
      const at = (p: number): string => {
        const d = dist * p;
        return dir === 'left' ? `${-d}px 0px` : dir === 'right' ? `${d}px 0px` : dir === 'up' ? `0px ${-d}px` : `0px ${d}px`;
      };
      return { keyframes: [{ translate: at(t.from ?? 1) }, { translate: at(t.to ?? 0) }], options };
    }
  }
}
