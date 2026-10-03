/**
 * The project UI layer of the game host — UI documents drawn as
 * DOM/CSS over the game view, in Play and in exported games alike (the
 * runtime never draws; nothing here imports the editor).
 *
 * What it draws: the documents the simulation shows (`ctx.ui.show`, a
 * frame's show/hide entry), bound to the scripts' view model (the runtime's
 * `UiOutput` diffs, applied once per frame), plus the screen document the
 * host shows (a game shell screen, a mode's pause screen). Widgets: panel, stack,
 * grid, text (rich text in project fonts), image (9-slice), bar (linear or
 * radial), button, list (repeated from a bound array) and a text input;
 * styles and themes compile to a constructed stylesheet (the Play page's CSP
 * refuses inline <style>; CSSOM sheets and element styles are allowed).
 *
 * What it sends back: UI events (clicks with an event action, submits, focus
 * changes, show/hide from a button) go to the runtime's queue
 * (`queueUiEvent`) and ride on the next sampled input frame, so a replay
 * sees them exactly; engine actions (resume, quit to title, save, load, a
 * setting) go to the host (its game shell or the engine pause). Keyboard/gamepad focus navigation uses the
 * input owner's ui edges; the pointer uses DOM events; the focused
 * document's action map becomes the input owner's active map. World-anchored
 * widgets follow an entity or a point through the renderer's camera.
 */
import { createResourceManager, type DialogueInputRecord, type ResourceManager } from '@thirdlight/runtime';
import { UI_LIMITS, applyUiOutputToModel, readUiPath, uiPathSegments, type UiAction, type UiDocument, type UiEventRecord, type UiOutput, type UiShownDocument, type UiStyle, type UiTheme, type UiTween, type UiWidget } from '@thirdlight/runtime';
import type { UiEdges } from './dom';
import type { HostDom, HostDomNode } from './dom';
import { GENERIC_FONTS, UI_BASE_CSS, boundSizeAxes, childrenFlow, containerProps, fontFamilyOf, placementProps, styleRules, tweenKeyframes, type CssAssets, type CssProp } from './ui-css';
import { orderPick, spatialPick, type NavDirection, type NavRect } from './ui-nav';
import { parseRichText, uiValueText, type RichToken } from './ui-text';
import type { UiHitTarget } from './ui-hit';

/** The DOM surface the layer uses (real elements have it; optional members degrade in a headless page). */
interface UiNode extends HostDomNode {
  style?: { setProperty?(k: string, v: string): void; removeProperty?(k: string): void; cssText?: string; [k: string]: unknown };
  removeAttribute?(name: string): void;
  getBoundingClientRect?(): NavRect;
  focus?(): void;
  blur?(): void;
  value?: string;
  animate?(keyframes: Record<string, string | number>[], options: Record<string, unknown>): { cancel(): void; finished?: Promise<unknown> };
}

/** Project a world target through the rendered camera: out = [x 0–1 from the left, y 0–1 from the top, 1 in front / 0 behind]. */
export type UiProjector = (target: { readonly entityId?: string; readonly point?: readonly number[]; readonly offset?: readonly number[] }, out: number[]) => boolean;

export interface UiLayerDeps {
  readonly dom: HostDom;
  readonly container: HostDomNode;
  readonly documents: readonly UiDocument[];
  readonly themes?: readonly UiTheme[];
  readonly assetPaths?: Readonly<Record<string, string>>;
  /** The path of an asset `assetPaths` does not name (a build's catalog read as the game needs it). */
  readonly lookupPath?: (assetId: string) => Promise<string | undefined>;
  readonly readArtifact: (path: string) => Promise<ArrayBuffer>;
  /**
   * The page's resource manager: the layer's images and fonts are held
   * there while it exists (absent: a manager of the layer's own).
   */
  readonly resources?: ResourceManager;
  /** A UI event for the simulation (the runtime's `queueUiEvent`). */
  readonly queueEvent: (event: UiEventRecord) => void;
  /** A dialogue input for the simulation (the runtime's `queueDialogueInput`). */
  readonly dialogueInput?: (input: DialogueInputRecord) => void;
  /** An engine action (the host's shell or engine pause: resume, quit to title, save, load, a setting, mute). */
  readonly engineAction: (action: Extract<UiAction, { do: 'engine' }>) => void;
  /** The host values `$flow.*` bindings read (null: none). */
  readonly flowValues?: () => Readonly<Record<string, unknown>> | null;
  /** Make only these input action maps active (null: every map). */
  readonly setActiveMaps?: (maps: readonly string[] | null) => void;
  /**
   * An input action's glyph for the device used last (a label
   * and an image URL — the project's texture or the engine's generic SVG);
   * `glyphKey` changes whenever a glyph may have (device, bindings).
   */
  readonly glyph?: (action: string) => { readonly label: string; readonly icon: string; readonly url: string } | null;
  readonly glyphKey?: () => string;
  /** The view size in CSS px (default: the window's). */
  readonly viewport?: () => { width: number; height: number };
  /**
   * A save slot's picture for an image widget's `saveSlot`: a stamp that
   * changes when the slot is saved again and the picture (a data URL); null
   * while the slot has none (absent: the game has no saves).
   */
  readonly saveThumbnail?: (slot: number) => { readonly stamp: string; picture(): Promise<string | null> } | null;
  /** Changes whenever a slot's picture may have (a save, a delete). */
  readonly saveThumbnailsKey?: () => string;
  /**
   * Mark every widget element with its place in the document's
   * tree (`data-tl-path`: `r` for the root, then child indices, `t` for a
   * list's template: `r.0.2.t`) — the UI document editor's preview selects
   * widgets by it. Off in Play and exports.
   */
  readonly annotate?: boolean;
}

export interface UiLayerObservation {
  /** The documents the simulation shows, bottom first. */
  readonly shown: readonly string[];
  /** The screen document the host shows (null: none). */
  readonly screen: string | null;
  /** The HUD documents the host shows (the game shell's). */
  readonly hud?: readonly string[];
  readonly focus: { readonly doc: string; readonly widget: string; readonly index?: number } | null;
  /** The input action map made active by the focused document (null: every map). */
  readonly actionMap: string | null;
}

/**
 * One element as tl_game_observe lists it — its document and
 * widget, the list item, the rectangle in fractions of the view ([x, y, w, h],
 * 0,0 top left) and whether a pointer press there goes to the UI (`hit`).
 */
export interface UiElementObservation {
  readonly doc: string;
  readonly widget: string;
  readonly type: string;
  readonly index?: number;
  readonly rect: readonly [number, number, number, number];
  readonly hit?: true;
  readonly disabled?: true;
  readonly focused?: true;
}

export { hitUiTargets, type UiHitTarget } from './ui-hit';

export interface UiLayer {
  /** Apply the simulation's UI diff (view model, shown documents, tween/focus commands). */
  applyOutput(out: UiOutput): void;
  /** Draw this document as the host's screen (null: none). */
  showScreen(docId: string | null): void;
  /** The HUD documents the host shows while the game plays (under the simulation's; never focused). */
  setHud(docIds: readonly string[]): void;
  /** Once per frame: $flow values and the view size. */
  frame(): void;
  /** Keyboard/gamepad edges: the focused document takes what it uses; the rest is returned. */
  handleEdges(edges: UiEdges): UiEdges;
  /** A document with the focus is shown (its edges go to the UI). */
  hasFocus(): boolean;
  /** Place the world-anchored widgets (after the frame is rendered). */
  updateAnchors(project: UiProjector): void;
  observe(): UiLayerObservation;
  /** The shown widgets with an id or that take the pointer, with their rectangles (at most `max`, document order, bottom document first). */
  elements(max?: number): UiElementObservation[];
  /** Where a pointer press goes to the UI, topmost first (cached for the frame). */
  hitTargets(): readonly UiHitTarget[];
  /** A click on the target with this key (a button runs its click, an input takes the focus); false when it is gone. */
  click(key: string): boolean;
  dispose(): void;
}

interface Scope {
  readonly item?: unknown;
  readonly index?: number;
}

interface Rec {
  readonly w: UiWidget;
  readonly el: UiNode;
  readonly scope: Scope;
  readonly kids: Rec[];
  /** A list's item roots (rebuilt as the bound array changes). */
  items?: Rec[];
  itemsHost?: UiNode;
  visible: boolean;
  enabled: boolean;
  textKey?: string;
  tokens?: RichToken[];
  /** The content binding's text the tokens were parsed from. */
  contentText?: string;
  textEl?: UiNode;
  textSpans?: UiNode[];
  barFill?: UiNode;
  barKey?: string;
  /** The size axes bound to the view model ([width, height]) and the last applied values. */
  sizeAxes?: [boolean, boolean];
  sizeKey?: string;
  imageKey?: string;
  anchorEntity?: string | null;
  indicator?: Rec;
  anchorState?: string;
  listeners?: { type: string; fn: (e?: unknown) => void }[];
}

const hasOwn = Object.prototype.hasOwnProperty;

function setProp(el: UiNode, k: string, v: string | null): void {
  const st = el.style;
  if (st === undefined) return;
  if (typeof st.setProperty === 'function') {
    if (v === null) st.removeProperty?.(k);
    else st.setProperty(k, v);
  } else st[k] = v ?? '';
}
function setProps(el: UiNode, props: readonly CssProp[]): void {
  for (const [k, v] of props) setProp(el, k, v);
}
function classes(el: UiNode, list: readonly string[]): void {
  el.setAttribute?.('class', list.filter((c) => c !== '').join(' '));
}
function toggleClass(el: UiNode, cls: string, on: boolean): void {
  const cur = ((el as { getAttribute?(n: string): string | null }).getAttribute?.('class') ?? (el as unknown as { attrs?: Record<string, string> }).attrs?.['class'] ?? '').split(/\s+/).filter((c) => c !== '');
  const has = cur.includes(cls);
  if (has === on) return;
  classes(el, on ? [...cur, cls] : cur.filter((c) => c !== cls));
}
function listen(rec: Rec, type: string, fn: (e?: unknown) => void): void {
  (rec.el.addEventListener as ((t: string, h: (e?: unknown) => void) => void) | undefined)?.call(rec.el, type, fn);
  (rec.listeners ??= []).push({ type, fn });
}
function unlistenTree(rec: Rec): void {
  for (const l of rec.listeners ?? []) (rec.el.removeEventListener as ((t: string, h: (e?: unknown) => void) => void) | undefined)?.call(rec.el, l.type, l.fn);
  rec.listeners = [];
  for (const k of rec.kids) unlistenTree(k);
  for (const k of rec.items ?? []) unlistenTree(k);
}
function isBinding(v: unknown): v is { bind: string } {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { bind?: unknown }).bind === 'string';
}
const actionsOf = (a: UiAction | UiAction[] | undefined): UiAction[] => (a === undefined ? [] : Array.isArray(a) ? a : [a]);
const focusableByDefault = (w: UiWidget): boolean => w.type === 'button' || w.type === 'input';

/** One shown document. */
class DocView {
  readonly root: UiNode;
  readonly content: UiNode;
  private readonly backdrop: UiNode | null;
  private sheet: { replaceSync(t: string): void } | null = null;
  private styleEl: UiNode | null = null;
  private readonly classOf = new Map<string, string>();
  private readonly ownCss = new Map<UiWidget, string>();
  /** Each widget's tree path (only with `annotate`). */
  private readonly pathOf = new Map<UiWidget, string>();
  private serial = 0;
  top: Rec | null = null;
  focus: Rec | null = null;
  leaving = false;
  scale = { s: 1, ox: 0, oy: 0, key: '' };

  constructor(
    private readonly layer: LayerImpl,
    readonly doc: UiDocument,
    readonly theme: UiTheme | undefined,
    readonly source: 'sim' | 'screen' | 'hud',
    readonly modal: boolean,
  ) {
    const dom = layer.dom;
    this.root = dom.createElement('div') as UiNode;
    classes(this.root, ['tl-ui', modal ? 'is-modal' : '']);
    this.root.setAttribute?.('data-tl-ui-doc', doc.uiDocumentId);
    this.root.setAttribute?.('data-tl-ui-source', source);
    this.backdrop = modal ? (dom.createElement('div') as UiNode) : null;
    if (this.backdrop !== null) {
      classes(this.backdrop, ['tl-ui__backdrop']);
      this.root.appendChild(this.backdrop);
      // A press on the backdrop keeps the keyboard focus on the game surface (the input
      // owner listens there), as a press on a widget does.
      (this.backdrop.addEventListener as ((t: string, h: (e?: unknown) => void) => void) | undefined)?.call(this.backdrop, 'pointerdown', (e?: unknown) => (e as { preventDefault?: () => void } | undefined)?.preventDefault?.());
    }
    this.content = dom.createElement('div') as UiNode;
    classes(this.content, ['tl-ui__root']);
    this.root.appendChild(this.content);
    this.installStyles();
    this.top = this.build(doc.root, this.content, {}, false);
  }

  /** Focus is wanted: a modal, a document that asks for it, a host screen. */
  get wantsFocus(): boolean {
    return this.source === 'screen' || (this.source === 'sim' && (this.doc.focus ?? this.modal));
  }

  // --- styles ---------------------------------------------------------------

  private styleClass(name: string): string {
    let c = this.classOf.get(name);
    if (c === undefined) {
      c = `tl-s-${this.layer.nextId()}`;
      this.classOf.set(name, c);
    }
    return c;
  }

  private styleNamed(name: string): UiStyle | undefined {
    const own = this.doc.styles;
    if (own !== undefined && hasOwn.call(own, name)) return own[name];
    const th = this.theme?.styles;
    return th !== undefined && hasOwn.call(th, name) ? th[name] : undefined;
  }

  cssText(): string {
    const assets = this.layer.cssAssets;
    const rules: string[] = [];
    const names = new Set<string>([...Object.keys(this.theme?.styles ?? {}), ...Object.keys(this.doc.styles ?? {})]);
    for (const n of names) {
      const s = this.styleNamed(n);
      if (s !== undefined) rules.push(styleRules(this.styleClass(n), s, assets));
    }
    for (const [w, cls] of this.ownCss) if (w.css !== undefined) rules.push(styleRules(cls, w.css, assets));
    return rules.filter((r) => r !== '').join('\n');
  }

  private installStyles(): void {
    // Assign classes for the styles and widgets' own css first (build reads them).
    for (const n of [...Object.keys(this.theme?.styles ?? {}), ...Object.keys(this.doc.styles ?? {})]) this.styleClass(n);
    const visit = (w: UiWidget): void => {
      if (w.css !== undefined) this.ownCss.set(w, `tl-c-${this.layer.nextId()}`);
      for (const c of w.children ?? []) visit(c);
      if (w.template !== undefined) visit(w.template);
    };
    visit(this.doc.root);
    if (this.layer.annotate) {
      const mark = (w: UiWidget, p: string): void => {
        this.pathOf.set(w, p);
        (w.children ?? []).forEach((c, i) => mark(c, `${p}.${i}`));
        if (w.template !== undefined) mark(w.template, `${p}.t`);
      };
      mark(this.doc.root, 'r');
    }
    const css = this.cssText();
    const Sheet = (globalThis as { CSSStyleSheet?: new () => { replaceSync(t: string): void } }).CSSStyleSheet;
    const docLike = this.layer.dom as unknown as { adoptedStyleSheets?: unknown[] };
    if (Array.isArray(docLike.adoptedStyleSheets) && Sheet !== undefined) {
      try {
        const sheet = new Sheet();
        sheet.replaceSync(css);
        docLike.adoptedStyleSheets = [...docLike.adoptedStyleSheets, sheet];
        this.sheet = sheet;
        return;
      } catch {
        this.sheet = null;
      }
    }
    this.styleEl = this.layer.dom.createElement('style') as UiNode;
    this.styleEl.textContent = css;
    this.root.appendChild(this.styleEl);
  }

  /** Recompile the stylesheet (an image's bytes arrived). */
  refreshStyles(): void {
    const css = this.cssText();
    if (this.sheet !== null) this.sheet.replaceSync(css);
    else if (this.styleEl !== null) this.styleEl.textContent = css;
  }

  // --- building -------------------------------------------------------------

  private build(w: UiWidget, parent: UiNode, scope: Scope, parentFlows: boolean): Rec {
    const dom = this.layer.dom;
    const tag = w.type === 'button' ? 'button' : w.type === 'input' ? 'input' : 'div';
    const el = dom.createElement(tag) as UiNode;
    const rec: Rec = { w, el, scope, kids: [], visible: true, enabled: true };
    const styleNames = w.style === undefined ? [] : Array.isArray(w.style) ? w.style : [w.style];
    const anchored = w.worldAnchor !== undefined;
    classes(el, ['tl-ui-w', `tl-ui-${w.type}`, anchored ? 'tl-ui-anchored' : '', ...styleNames.map((n) => this.styleClass(n)), this.ownCss.get(w) ?? '', w.type === 'text' && w.wrap === false ? 'is-nowrap' : '']);
    if (w.id !== undefined) el.setAttribute?.('data-widget', w.id);
    const treePath = this.pathOf.get(w);
    if (treePath !== undefined) el.setAttribute?.('data-tl-path', treePath);
    if (scope.index !== undefined) el.setAttribute?.('data-index', String(scope.index));
    if (tag === 'button') el.setAttribute?.('type', 'button');
    if (anchored) {
      setProps(el, [['position', 'absolute'], ['left', '0px'], ['top', '0px'], ...(typeof w.size?.[0] === 'number' ? [['width', `${w.size[0]}px`] as const] : []), ...(typeof w.size?.[1] === 'number' ? [['height', `${w.size[1]}px`] as const] : [])]);
      const pivot = w.pivot ?? [0.5, 0.5];
      setProp(el, 'transform', `translate(${-pivot[0] * 100}%, ${-pivot[1] * 100}%)`);
      rec.anchorEntity = null;
    } else setProps(el, placementProps(w, parentFlows));
    const sizeAxes = boundSizeAxes(w, parentFlows);
    if (sizeAxes[0] || sizeAxes[1]) rec.sizeAxes = sizeAxes;
    setProps(el, containerProps(w));
    // A world-anchored widget is placed in the document's own box (not its parent's), whatever its parent lays out.
    (anchored ? this.content : parent).appendChild(el);
    if (w.type === 'text' || (w.type === 'button' && w.text !== undefined)) {
      rec.tokens = w.type === 'text' && w.content !== undefined ? [] : parseRichText(w.text ?? '');
      rec.textEl = w.type === 'text' ? el : (dom.createElement('span') as UiNode);
      if (rec.textEl !== el) {
        classes(rec.textEl, ['tl-ui-text']);
        el.appendChild(rec.textEl);
      }
    }
    if (w.type === 'bar') {
      const fill = dom.createElement('div') as UiNode;
      const fillStyles = w.fillStyle !== undefined ? [this.styleClass(w.fillStyle)] : [];
      classes(fill, ['tl-ui-bar__fill', ...fillStyles]);
      if (w.fillColor !== undefined && w.shape !== 'radial') setProp(fill, 'background-color', w.fillColor);
      el.appendChild(fill);
      rec.barFill = fill;
    }
    if (w.type === 'input') {
      el.setAttribute?.('type', 'text');
      if (w.placeholder !== undefined) el.setAttribute?.('placeholder', w.placeholder);
      el.setAttribute?.('maxlength', String(w.maxLength ?? 256));
      listen(rec, 'keydown', (e) => {
        const key = (e as { key?: string } | undefined)?.key;
        if (key === 'Enter') {
          (e as { preventDefault?: () => void }).preventDefault?.();
          this.layer.runActions(this, rec, actionsOf(w.onSubmit), 'submit', String(el.value ?? '').slice(0, w.maxLength ?? 256));
          el.blur?.();
        } else if (key === 'Escape') el.blur?.();
      });
    }
    if (w.type === 'button' || w.type === 'input' || w.focusable === true) this.wirePointer(rec);
    for (const c of w.children ?? []) rec.kids.push(this.build(c, el, scope, childrenFlow(w)));
    if (w.type === 'list') {
      rec.items = [];
      rec.itemsHost = el;
    }
    if (w.worldAnchor?.indicator !== undefined) {
      const find = (r: Rec): Rec | undefined => (r.w.id === w.worldAnchor!.indicator ? r : r.kids.map(find).find((x) => x !== undefined));
      const ind = rec.kids.map(find).find((x) => x !== undefined);
      if (ind !== undefined) {
        rec.indicator = ind;
        toggleClass(ind.el, 'tl-ui-indicator', true);
      }
    }
    return rec;
  }

  private wirePointer(rec: Rec): void {
    const el = rec.el;
    listen(rec, 'pointerenter', () => {
      if (this.leaving) return;
      toggleClass(el, 'is-hover', true);
      if (this.wantsFocus && rec.enabled) this.layer.setFocus(this, rec, true);
    });
    listen(rec, 'pointerleave', () => {
      toggleClass(el, 'is-hover', false);
      toggleClass(el, 'is-pressed', false);
    });
    listen(rec, 'pointerdown', (e) => {
      // Keep the keyboard focus on the game surface (the input owner listens there); an input takes it.
      if (rec.w.type !== 'input') (e as { preventDefault?: () => void } | undefined)?.preventDefault?.();
      if (rec.enabled) toggleClass(el, 'is-pressed', true);
    });
    listen(rec, 'pointerup', () => toggleClass(el, 'is-pressed', false));
    if (rec.w.type === 'button') {
      listen(rec, 'click', () => {
        if (this.leaving || !rec.enabled || !rec.visible) return;
        this.layer.activate(this, rec);
      });
    }
    if (rec.w.type === 'input') {
      listen(rec, 'focus', () => {
        if (this.wantsFocus) this.layer.setFocus(this, rec, true);
      });
    }
  }

  // --- values ---------------------------------------------------------------

  resolve(v: unknown, scope: Scope): unknown {
    if (!isBinding(v)) return v;
    return this.layer.resolvePath(v.bind, scope);
  }

  /** Apply the view model to every widget (only what changed touches the DOM). */
  refresh(): void {
    if (this.top !== null) this.refreshRec(this.top);
    if (this.focus !== null && (!this.focus.visible || !this.focus.enabled || !this.alive(this.focus))) this.focus = null;
    if (this.focus === null && this.wantsFocus) this.layer.initialFocus(this);
  }

  private alive(rec: Rec): boolean {
    let found = false;
    this.walk((r) => {
      if (r === rec) found = true;
    });
    return found;
  }

  private refreshRec(rec: Rec): void {
    const w = rec.w;
    const s = rec.scope;
    if (w.visible !== undefined) {
      const visible = isBinding(w.visible) ? truthy(this.resolve(w.visible, s)) : w.visible === true;
      if (visible !== rec.visible) {
        rec.visible = visible;
        setProp(rec.el, 'display', visible ? null : 'none');
      }
    }
    if (w.enabled !== undefined) {
      const enabled = isBinding(w.enabled) ? truthy(this.resolve(w.enabled, s)) : w.enabled === true;
      if (enabled !== rec.enabled) {
        rec.enabled = enabled;
        toggleClass(rec.el, 'is-disabled', !enabled);
        if (enabled) rec.el.removeAttribute?.('disabled');
        else rec.el.setAttribute?.('disabled', '');
      }
    }
    if (rec.sizeAxes !== undefined) this.renderSize(rec);
    if (rec.tokens !== undefined && rec.textEl !== undefined) this.renderText(rec);
    if (w.type === 'image') this.renderImage(rec);
    if (w.type === 'bar') this.renderBar(rec);
    if (w.type === 'input' && w.value !== undefined && this.focus !== rec) {
      const v = uiValueText(this.resolve(w.value, s));
      if (rec.el.value !== v) rec.el.value = v;
    }
    if (w.worldAnchor?.entity !== undefined) {
      const e = this.resolve(w.worldAnchor.entity, s);
      rec.anchorEntity = typeof e === 'string' && e !== '' ? e : null;
    }
    if (w.type === 'list') this.syncList(rec);
    for (const k of rec.kids) this.refreshRec(k);
    for (const k of rec.items ?? []) this.refreshRec(k);
  }

  private renderText(rec: Rec): void {
    // A content binding is rich text from the view model (braces are text); a reveal shows the first N visible characters.
    const w = rec.w;
    let contentText: string | null = null;
    if (w.type === 'text' && w.content !== undefined) {
      contentText = uiValueText(this.resolve(w.content, rec.scope));
      if (rec.contentText !== contentText) {
        rec.contentText = contentText;
        rec.tokens = parseRichText(contentText, { values: false });
      }
    }
    let reveal: number | null = null;
    if (w.type === 'text' && w.reveal !== undefined) {
      const r = this.resolve(w.reveal, rec.scope);
      reveal = typeof r === 'number' && Number.isFinite(r) ? Math.max(0, Math.floor(r)) : null;
    }
    const tokens = rec.tokens!;
    const glyphs = tokens.map((t) => (t.t === 'glyph' ? (this.layer.deps.glyph?.(t.action) ?? null) : null));
    const values = tokens.map((t, i) => (t.t === 'value' ? uiValueText(this.layer.resolvePath(t.path, rec.scope)) : t.t === 'icon' ? (this.layer.iconUrl(this, t.name) ?? '') : t.t === 'glyph' ? `${glyphs[i]?.label ?? ''}|${glyphs[i]?.url ?? ''}` : ''));
    const key = `${contentText ?? ''}\u0001${reveal ?? ''}\u0001${values.join('\u0000')}`;
    if (rec.textKey === key) return;
    rec.textKey = key;
    const host = rec.textEl!;
    for (const old of rec.textSpans ?? []) old.remove();
    rec.textSpans = [];
    const dom = this.layer.dom;
    if (reveal !== null) host.setAttribute?.('data-reveal', String(reveal));
    // Characters still to show under a reveal (null: all); hidden ones keep their place (the text does not reflow as it types).
    let left = reveal;
    const hide = (span: UiNode): void => setProp(span, 'visibility', 'hidden');
    tokens.forEach((t, i) => {
      const span = dom.createElement('span') as UiNode;
      if ((t.t === 'text' || t.t === 'value') && left !== null) {
        const chars = Array.from(t.t === 'text' ? t.text : values[i]!);
        if (left >= chars.length) {
          span.textContent = chars.join('');
          left -= chars.length;
        } else {
          span.textContent = chars.slice(0, left).join('');
          const rest = dom.createElement('span') as UiNode;
          rest.textContent = chars.slice(left).join('');
          hide(rest);
          span.appendChild(rest);
          left = 0;
        }
      } else if (t.t === 'text') span.textContent = t.text;
      else if (t.t === 'value') span.textContent = values[i]!;
      else if (t.t === 'glyph' || t.t === 'icon') {
        // An icon or a glyph counts as one character of a reveal.
        if (left !== null) {
          if (left <= 0) hide(span);
          else left -= 1;
        }
      }
      if (t.t === 'glyph') {
        // The glyph image, its label for readers (and as text when there is no binding image).
        const g = glyphs[i];
        classes(span, ['tl-ui-glyph']);
        span.setAttribute?.('data-action', t.action);
        span.setAttribute?.('data-glyph', g?.label ?? '');
        span.setAttribute?.('data-glyph-icon', g?.icon ?? '');
        span.setAttribute?.('role', 'img');
        span.setAttribute?.('aria-label', g?.label ?? t.action);
        if (g === null || g === undefined) span.textContent = '?';
        else {
          setProp(span, 'display', 'inline-block');
          setProp(span, 'height', '1.3em');
          setProp(span, 'min-width', '1.3em');
          setProp(span, 'vertical-align', 'middle');
          setProp(span, 'background', `center / contain no-repeat url("${g.url.replace(/"/g, '%22')}")`);
        }
      } else if (t.t === 'icon') {
        classes(span, ['tl-ui-icon']);
        span.setAttribute?.('data-icon', t.name);
        this.layer.styleIcon(this, span, t.name);
      }
      if (t.style.bold === true) setProp(span, 'font-weight', '700');
      if (t.style.italic === true) setProp(span, 'font-style', 'italic');
      if (t.style.color !== undefined) setProp(span, 'color', t.style.color);
      if (t.style.size !== undefined) setProp(span, 'font-size', `${t.style.size}px`);
      host.appendChild(span);
      rec.textSpans!.push(span);
    });
  }

  private renderImage(rec: Rec): void {
    const w = rec.w;
    // A texture asset, or a save slot's picture.
    const slot = w.saveSlot !== undefined ? this.resolve(w.saveSlot, rec.scope) : undefined;
    const id = w.saveSlot !== undefined ? `save-slot:${String(slot)}` : this.resolve(w.image, rec.scope);
    const url = w.saveSlot !== undefined ? (typeof slot === 'number' && Number.isInteger(slot) ? this.layer.saveThumbnailUrl(slot) : null) : typeof id === 'string' ? this.layer.imageUrl(id) : null;
    const key = `${String(id)}|${url ?? ''}`;
    if (rec.imageKey === key) return;
    rec.imageKey = key;
    const el = rec.el;
    if (url === null) {
      setProp(el, 'background-image', null);
      setProp(el, 'border-image', null);
      return;
    }
    const u = `url("${url}")`;
    if (w.slice !== undefined) {
      const [t, r, b, l] = w.slice;
      setProps(el, [['border-style', 'solid'], ['border-width', `${t}px ${r}px ${b}px ${l}px`], ['border-image', `${u} ${t} ${r} ${b} ${l} fill / ${t}px ${r}px ${b}px ${l}px stretch`]]);
    } else if (w.tint !== undefined) {
      const fit = w.fit === 'contain' ? 'contain' : w.fit === 'cover' ? 'cover' : '100% 100%';
      setProps(el, [['background-color', w.tint], ['mask-image', u], ['-webkit-mask-image', u], ['mask-size', fit], ['-webkit-mask-size', fit], ['mask-repeat', 'no-repeat'], ['-webkit-mask-repeat', 'no-repeat'], ['mask-position', 'center'], ['-webkit-mask-position', 'center']]);
    } else {
      setProps(el, [['background-image', u], ['background-size', w.fit === 'contain' ? 'contain' : w.fit === 'cover' ? 'cover' : '100% 100%'], ['background-repeat', 'no-repeat'], ['background-position', 'center']]);
    }
  }

  /** A bound size axis (a number of px from the view model; anything else sizes it to the content). */
  private renderSize(rec: Rec): void {
    const axes = rec.sizeAxes!;
    const size = rec.w.size!;
    const px = (i: 0 | 1): string | null => {
      if (!axes[i]) return null;
      const v = this.resolve(size[i], rec.scope);
      return typeof v === 'number' && Number.isFinite(v) ? `${Math.max(0, Math.min(16_384, v))}px` : null;
    };
    const w = px(0);
    const h = px(1);
    const key = `${w}|${h}`;
    if (rec.sizeKey === key) return;
    rec.sizeKey = key;
    if (axes[0]) setProp(rec.el, 'width', w);
    if (axes[1]) setProp(rec.el, 'height', h);
  }

  private renderBar(rec: Rec): void {
    const w = rec.w;
    const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const value = num(this.resolve(w.value, rec.scope), 0);
    const min = num(this.resolve(w.min, rec.scope), 0);
    const max = num(this.resolve(w.max, rec.scope), 1);
    const t = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
    const pct = Math.round(t * 10_000) / 100;
    // The start angle may read the view model.
    const a = num(this.resolve(w.startAngle, rec.scope), 0);
    const angle = Math.round(Math.max(-360, Math.min(360, a)) * 100) / 100;
    const key = `${pct}|${angle}`;
    if (rec.barKey === key) return;
    rec.barKey = key;
    const fill = rec.barFill!;
    rec.el.setAttribute?.('data-value', String(Math.round(t * 1000) / 1000));
    if (w.shape === 'radial') {
      const color = w.fillColor ?? '#ffffff';
      const ccw = w.direction === 'left';
      setProps(fill, [['background', `conic-gradient(from ${angle}deg, ${color} ${pct}%, transparent 0)`], ['border-radius', '50%'], ['transform', ccw ? 'scaleX(-1)' : 'none']]);
      return;
    }
    switch (w.direction ?? 'right') {
      case 'right':
        setProps(fill, [['left', '0px'], ['right', 'auto'], ['width', `${pct}%`], ['height', '100%']]);
        break;
      case 'left':
        setProps(fill, [['left', 'auto'], ['right', '0px'], ['width', `${pct}%`], ['height', '100%']]);
        break;
      case 'up':
        setProps(fill, [['top', 'auto'], ['bottom', '0px'], ['height', `${pct}%`], ['width', '100%']]);
        break;
      case 'down':
        setProps(fill, [['top', '0px'], ['bottom', 'auto'], ['height', `${pct}%`], ['width', '100%']]);
        break;
    }
  }

  private syncList(rec: Rec): void {
    const w = rec.w;
    const arr = w.items !== undefined ? this.layer.resolvePath(w.items.bind, rec.scope) : undefined;
    const list = Array.isArray(arr) ? arr.slice(0, LIST_MAX) : [];
    const items = rec.items!;
    // Rebuild an item when its value changed identity (the view model replaces what it writes).
    for (let i = 0; i < list.length; i += 1) {
      const cur = items[i];
      if (cur !== undefined && cur.scope.item === list[i]) continue;
      if (cur !== undefined) this.removeRec(cur);
      const built = this.build(w.template!, rec.itemsHost!, { item: list[i], index: i }, true);
      if (cur !== undefined) {
        // Keep document order: move the rebuilt item to its place.
        const next = items[i + 1];
        const host = rec.itemsHost as unknown as { insertBefore?(n: unknown, r: unknown): void };
        if (next !== undefined && typeof host.insertBefore === 'function' && built.w.worldAnchor === undefined) host.insertBefore(built.el, next.el);
      }
      items[i] = built;
    }
    while (items.length > list.length) this.removeRec(items.pop()!);
  }

  private removeRec(rec: Rec): void {
    if (this.focus !== null) {
      let inside = false;
      const check = (r: Rec): void => {
        if (r === this.focus) inside = true;
        r.kids.forEach(check);
        (r.items ?? []).forEach(check);
      };
      check(rec);
      if (inside) this.focus = null;
    }
    unlistenTree(rec);
    const drop = (r: Rec): void => {
      if (r.w.worldAnchor !== undefined) r.el.remove();
      r.kids.forEach(drop);
      (r.items ?? []).forEach(drop);
    };
    drop(rec);
    rec.el.remove();
  }

  /** Every widget record in document order. */
  walk(fn: (r: Rec) => void): void {
    const go = (r: Rec): void => {
      fn(r);
      r.kids.forEach(go);
      (r.items ?? []).forEach(go);
    };
    if (this.top !== null) go(this.top);
  }

  /** The focusable, visible, enabled widgets in document order. */
  focusables(): Rec[] {
    const out: Rec[] = [];
    const go = (r: Rec, shown: boolean): void => {
      const vis = shown && r.visible;
      if (vis && r.enabled && (r.w.focusable ?? focusableByDefault(r.w))) out.push(r);
      r.kids.forEach((k) => go(k, vis));
      (r.items ?? []).forEach((k) => go(k, vis));
    };
    if (this.top !== null) go(this.top, true);
    return out;
  }

  findById(id: string, index?: number): Rec | null {
    let found: Rec | null = null;
    this.walk((r) => {
      if (found === null && r.w.id === id && (index === undefined || r.scope.index === index)) found = r;
    });
    return found;
  }

  /** The document's view box (scale mode: a reference size fitted to the view). */
  layout(vw: number, vh: number): void {
    const sc = this.doc.scale;
    const key = `${vw}x${vh}`;
    if (this.scale.key === key) return;
    if (sc === undefined) {
      this.scale = { s: 1, ox: 0, oy: 0, key };
      return;
    }
    const [rw, rh] = sc.reference;
    const s = sc.mode === 'width' ? vw / rw : sc.mode === 'height' ? vh / rh : Math.min(vw / rw, vh / rh);
    const ox = (vw - rw * s) / 2;
    const oy = (vh - rh * s) / 2;
    this.scale = { s, ox, oy, key };
    setProps(this.content, [['width', `${rw}px`], ['height', `${rh}px`], ['transform', `translate(${ox}px, ${oy}px) scale(${s})`]]);
  }

  play(tween: string, widget?: string): { finished?: Promise<unknown> } | null {
    const t: UiTween | undefined = this.doc.tweens?.[tween];
    if (t === undefined) return null;
    const target = widget !== undefined && widget !== '' ? this.findById(widget)?.el : this.content;
    if (target === undefined || typeof target.animate !== 'function') return null;
    const { keyframes, options } = tweenKeyframes(t);
    try {
      return target.animate(keyframes, options);
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.top !== null) this.removeRec(this.top);
    this.top = null;
    this.root.remove();
    const docLike = this.layer.dom as unknown as { adoptedStyleSheets?: unknown[] };
    if (this.sheet !== null && Array.isArray(docLike.adoptedStyleSheets)) docLike.adoptedStyleSheets = docLike.adoptedStyleSheets.filter((x) => x !== this.sheet);
    this.sheet = null;
  }
}

/** The items of one list drawn (the model's bound; the rest are not drawn). */
const LIST_MAX = UI_LIMITS.listItems;
const truthy = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== 0 && v !== '';

class LayerImpl implements UiLayer {
  readonly dom: HostDom;
  private readonly root: UiNode;
  private readonly docs: ReadonlyMap<string, UiDocument>;
  private readonly themes: ReadonlyMap<string, UiTheme>;
  private model: Record<string, unknown> = {};
  private sim: DocView[] = [];
  private screen: DocView | null = null;
  private screenId: string | null = null;
  /** The HUD documents the host shows (the game shell's), under the simulation's. */
  private hud: DocView[] = [];
  private hudKey = '';
  private idSerial = 0;
  private dirty = true;
  private flowKey = '';
  /** The glyph key last seen (a change redraws texts with glyphs). */
  private glyphKeyNow = '';
  private flow: Readonly<Record<string, unknown>> | null = null;
  private activeMap: string | null | undefined = undefined;
  private readonly images = new Map<string, { url: string | null; w: number; h: number; pending: boolean }>();
  /** The save slots' pictures image widgets show (by slot: the stamp read and the data URL once it arrived). */
  private readonly slotPictures = new Map<number, { stamp: string; url: string | null }>();
  private slotPicturesKey = '';
  private readonly fonts = new Map<string, { face: unknown; loaded: boolean }>();
  /** Where the images (object URLs) and font faces are held, and this layer's holder name there. */
  private readonly resources: ResourceManager;
  private readonly holder: string;
  private disposed = false;
  readonly cssAssets: CssAssets;
  private readonly out: number[] = [0, 0, 0];
  readonly annotate: boolean;

  constructor(readonly deps: UiLayerDeps) {
    this.dom = deps.dom;
    this.resources = deps.resources ?? createResourceManager({ schedule: (run) => queueMicrotask(run) });
    layerSerial += 1;
    this.holder = `ui${layerSerial}`;
    this.annotate = deps.annotate === true;
    this.docs = new Map(deps.documents.map((d) => [d.uiDocumentId, d] as const));
    this.themes = new Map((deps.themes ?? []).map((t) => [t.uiThemeId, t] as const));
    this.root = deps.dom.createElement('div') as UiNode;
    classes(this.root, ['tl-ui-layer']);
    this.root.setAttribute?.('data-tl-ui', '');
    setProps(this.root, [['position', 'fixed'], ['inset', '0px'], ['pointer-events', 'none'], ['z-index', '6']]);
    // The shared base rules.
    const Sheet = (globalThis as { CSSStyleSheet?: new () => { replaceSync(t: string): void } }).CSSStyleSheet;
    const docLike = deps.dom as unknown as { adoptedStyleSheets?: unknown[] };
    let adopted = false;
    if (Array.isArray(docLike.adoptedStyleSheets) && Sheet !== undefined) {
      try {
        const sheet = new Sheet();
        sheet.replaceSync(UI_BASE_CSS);
        docLike.adoptedStyleSheets = [...docLike.adoptedStyleSheets, sheet];
        this.baseSheet = sheet;
        adopted = true;
      } catch {
        adopted = false;
      }
    }
    if (!adopted) {
      const st = deps.dom.createElement('style') as UiNode;
      st.textContent = UI_BASE_CSS;
      this.root.appendChild(st);
    }
    deps.container.appendChild(this.root);
    this.cssAssets = {
      image: (id) => this.imageUrl(id),
      font: (f) => this.fontStack(f),
    };
  }

  private baseSheet: unknown = null;

  nextId(): number {
    this.idSerial += 1;
    return this.idSerial;
  }

  // --- assets ---------------------------------------------------------------

  /** A save slot's picture as a data URL (null while it has none or it is still being read; an older picture shows until the newer arrives). */
  saveThumbnailUrl(slot: number): string | null {
    const t = this.deps.saveThumbnail?.(slot) ?? null;
    if (t === null) {
      this.slotPictures.delete(slot);
      return null;
    }
    const known = this.slotPictures.get(slot);
    if (known !== undefined && known.stamp === t.stamp) return known.url;
    const entry = { stamp: t.stamp, url: known?.url ?? null };
    this.slotPictures.set(slot, entry);
    void t.picture().then(
      (url) => {
        if (this.disposed || this.slotPictures.get(slot) !== entry) return;
        entry.url = url;
        this.assetsChanged();
      },
      () => undefined,
    );
    return entry.url;
  }

  imageUrl(assetId: string): string | null {
    const known = this.images.get(assetId);
    if (known !== undefined) return known.url;
    const entry = { url: null as string | null, w: 0, h: 0, pending: true };
    this.images.set(assetId, entry);
    const urls = (globalThis as { URL?: { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void } }).URL;
    if (typeof urls?.createObjectURL !== 'function' || typeof Blob !== 'function') return null;
    void this.resources.acquire<string>('image', assetId, this.holder, async () => {
      const buffer = await this.bytesOf(assetId);
      if (buffer === undefined) throw new Error(`image ${assetId} is not in this build`);
      return { value: urls.createObjectURL!(new Blob([buffer])), bytes: buffer.byteLength, free: (u) => urls.revokeObjectURL?.(u) };
    }).then(
      (url) => {
        if (this.disposed) return;
        entry.url = url;
        entry.pending = false;
        // The natural size (sprite icons are cut out of it).
        const Img = (globalThis as { Image?: new () => { src: string; naturalWidth: number; naturalHeight: number; onload: (() => void) | null } }).Image;
        if (Img !== undefined) {
          const img = new Img();
          img.onload = () => {
            entry.w = img.naturalWidth;
            entry.h = img.naturalHeight;
            this.assetsChanged();
          };
          img.src = entry.url;
        }
        this.assetsChanged();
      },
      () => undefined,
    );
    return null;
  }

  private fontStack(font: string): string {
    const generic = GENERIC_FONTS[font];
    if (generic !== undefined) return generic;
    this.loadFont(font);
    return `"${fontFamilyOf(font)}", ${GENERIC_FONTS['sans']}`;
  }

  /** An asset's bytes by its declared path (found in the catalog when the paths given do not name it); undefined: not in the build. */
  private bytesOf(assetId: string): Promise<ArrayBuffer | undefined> {
    const known = this.deps.assetPaths?.[assetId];
    const path = typeof known === 'string' ? Promise.resolve(known) : (this.deps.lookupPath?.(assetId) ?? Promise.resolve(undefined));
    return path.then((p) => (p === undefined ? undefined : this.deps.readArtifact(p)));
  }

  private loadFont(assetId: string): void {
    if (this.fonts.has(assetId)) return;
    const entry = { face: null as unknown, loaded: false };
    this.fonts.set(assetId, entry);
    const FF = (globalThis as { FontFace?: new (family: string, source: ArrayBuffer) => { load(): Promise<unknown> } }).FontFace;
    const set = (this.dom as unknown as { fonts?: { add(f: unknown): void; delete(f: unknown): void } }).fonts;
    if (FF === undefined || set === undefined) return;
    void this.resources.acquire<unknown>('font', assetId, this.holder, async () => {
      const buffer = await this.bytesOf(assetId);
      if (buffer === undefined) throw new Error(`font ${assetId} is not in this build`);
      const face = new FF(fontFamilyOf(assetId), buffer);
      await face.load();
      set.add(face);
      return { value: face, bytes: buffer.byteLength, free: (f) => set.delete(f) };
    }).then(
      (face) => {
        if (this.disposed) return;
        entry.face = face;
        entry.loaded = true;
        this.root.setAttribute?.('data-fonts', [...this.fonts].filter(([, f]) => f.loaded).map(([id]) => id).sort().join(','));
      },
      () => undefined,
    );
  }

  private assetsChanged(): void {
    for (const v of this.views()) {
      v.refreshStyles();
      v.walk((r) => {
        r.imageKey = undefined;
        r.textKey = undefined;
      });
    }
    this.dirty = true;
  }

  private iconOf(view: DocView, name: string): { asset: string; rect?: readonly number[] } | undefined {
    const own = view.doc.icons;
    if (own !== undefined && hasOwn.call(own, name)) return own[name];
    const th = view.theme?.icons;
    return th !== undefined && hasOwn.call(th, name) ? th[name] : undefined;
  }

  iconUrl(view: DocView, name: string): string | null {
    const icon = this.iconOf(view, name);
    return icon === undefined ? null : this.imageUrl(icon.asset);
  }

  styleIcon(view: DocView, span: UiNode, name: string): void {
    const icon = this.iconOf(view, name);
    if (icon === undefined) return;
    const url = this.imageUrl(icon.asset);
    if (url === null) return;
    setProp(span, 'background-image', `url("${url}")`);
    const img = this.images.get(icon.asset);
    const rect = icon.rect;
    if (rect !== undefined && img !== undefined && img.w > 0 && rect[2]! > 0) {
      const k = 1 / rect[2]!;
      setProps(span, [['width', '1em'], ['height', `${rect[3]! * k}em`], ['background-size', `${img.w * k}em ${img.h * k}em`], ['background-position', `${-rect[0]! * k}em ${-rect[1]! * k}em`]]);
    }
  }

  // --- values ---------------------------------------------------------------

  resolvePath(raw: string, scope: Scope): unknown {
    const negate = raw.startsWith('!');
    const path = negate ? raw.slice(1) : raw;
    const [head, ...rest] = path.split('.');
    let v: unknown;
    if (head === '$index') v = rest.length === 0 ? scope.index : undefined;
    else if (head === '$item') v = rest.length === 0 ? scope.item : readUiPath(scope.item, rest);
    else if (head === '$flow') v = this.flow === null ? undefined : rest.length === 0 ? this.flow : readUiPath(this.flow, rest);
    else {
      const segs = uiPathSegments(path);
      v = segs === null ? undefined : readUiPath(this.model, segs);
    }
    return negate ? !truthy(v) : v;
  }

  // --- documents --------------------------------------------------------------

  private views(): DocView[] {
    return this.screen !== null ? [...this.hud, ...this.sim, this.screen] : [...this.hud, ...this.sim];
  }

  private makeView(docId: string, source: 'sim' | 'screen' | 'hud', modal: boolean): DocView | null {
    const doc = this.docs.get(docId);
    if (doc === undefined) return null;
    const theme = doc.theme !== undefined ? this.themes.get(doc.theme) : undefined;
    const v = new DocView(this, doc, theme, source, modal);
    this.root.appendChild(v.root);
    const vp = this.viewport();
    v.layout(vp.width, vp.height);
    v.refresh();
    if (doc.showTween !== undefined) v.play(doc.showTween);
    return v;
  }

  private retire(v: DocView): void {
    if (v.leaving) return;
    v.leaving = true;
    v.root.setAttribute?.('data-leaving', 'true');
    setProp(v.root, 'pointer-events', 'none');
    const t = v.doc.hideTween !== undefined ? v.play(v.doc.hideTween) : null;
    const done = (): void => v.dispose();
    if (t?.finished !== undefined) t.finished.then(done, done);
    else done();
  }

  applyOutput(out: UiOutput): void {
    if (this.disposed) return;
    if (out.set.length > 0 || out.reset === true) {
      this.model = applyUiOutputToModel(this.model, out);
      this.dirty = true;
    }
    if (out.shown !== undefined) this.syncShown(out.shown);
    for (const c of out.commands) {
      const v = this.sim.find((x) => x.doc.uiDocumentId === c.doc) ?? this.hud.find((x) => x.doc.uiDocumentId === c.doc) ?? (this.screen?.doc.uiDocumentId === c.doc ? this.screen : undefined);
      if (v === undefined) continue;
      if (c.op === 'play') v.play(c.tween, c.widget);
      else {
        if (this.dirty) this.refreshAll();
        const r = v.findById(c.widget);
        if (r !== null) this.setFocus(v, r, true);
      }
    }
    this.updateMaps();
  }

  private syncShown(shown: readonly UiShownDocument[]): void {
    const next: DocView[] = [];
    for (const s of shown) {
      const have = this.sim.find((v) => v.doc.uiDocumentId === s.doc && v.modal === s.modal && !v.leaving);
      if (have !== undefined) next.push(have);
      else {
        const made = this.makeView(s.doc, 'sim', s.modal);
        if (made !== null) next.push(made);
      }
    }
    for (const v of this.sim) if (!next.includes(v)) this.retire(v);
    this.sim = next;
    this.restack();
  }

  private restack(): void {
    this.hud.forEach((v, i) => setProp(v.root, 'z-index', String(i + 1)));
    this.sim.forEach((v, i) => setProp(v.root, 'z-index', String(this.hud.length + i + 1)));
    if (this.screen !== null) setProp(this.screen.root, 'z-index', String(this.hud.length + this.sim.length + 100));
  }

  setHud(docIds: readonly string[]): void {
    const key = docIds.join(',');
    if (this.disposed || key === this.hudKey) return;
    this.hudKey = key;
    const next: DocView[] = [];
    for (const id of docIds) {
      const have = this.hud.find((v) => v.doc.uiDocumentId === id && !v.leaving);
      if (have !== undefined) next.push(have);
      else {
        const made = this.makeView(id, 'hud', false);
        if (made !== null) next.push(made);
      }
    }
    for (const v of this.hud) if (!next.includes(v)) this.retire(v);
    this.hud = next;
    this.restack();
  }

  showScreen(docId: string | null): void {
    if (this.disposed || docId === this.screenId) return;
    this.screenId = docId;
    if (this.screen !== null) this.retire(this.screen);
    this.screen = docId === null ? null : this.makeView(docId, 'screen', true);
    this.restack();
    this.updateMaps();
  }

  private viewport(): { width: number; height: number } {
    if (this.deps.viewport !== undefined) return this.deps.viewport();
    const g = globalThis as { innerWidth?: number; innerHeight?: number };
    return { width: g.innerWidth ?? 1280, height: g.innerHeight ?? 720 };
  }

  frame(): void {
    if (this.disposed) return;
    this.targetsCache = null;
    const flow = this.deps.flowValues?.() ?? null;
    // Glyphs follow the device used last and the bindings.
    const gk = this.deps.glyphKey?.() ?? '';
    if (gk !== this.glyphKeyNow) {
      this.glyphKeyNow = gk;
      this.dirty = true;
    }
    // A slot saved or deleted: the image widgets showing slot pictures read theirs again.
    const sk = this.deps.saveThumbnailsKey?.() ?? '';
    if (sk !== this.slotPicturesKey) {
      this.slotPicturesKey = sk;
      this.assetsChanged();
    }
    const key = flow === null ? '' : JSON.stringify(flow);
    if (key !== this.flowKey) {
      this.flowKey = key;
      this.flow = flow;
      this.dirty = true;
    }
    const vp = this.viewport();
    for (const v of this.views()) v.layout(vp.width, vp.height);
    if (this.dirty) this.refreshAll();
  }

  private refreshAll(): void {
    this.dirty = false;
    for (const v of this.views()) if (!v.leaving) v.refresh();
    this.updateMaps();
  }

  // --- focus and actions ----------------------------------------------------

  /** The document the keyboard/gamepad drives: the top one that wants focus. */
  private focusView(): DocView | null {
    if (this.screen !== null && !this.screen.leaving) return this.screen;
    for (let i = this.sim.length - 1; i >= 0; i -= 1) {
      const v = this.sim[i]!;
      if (!v.leaving && v.wantsFocus) return v;
    }
    return null;
  }

  hasFocus(): boolean {
    return this.focusView() !== null;
  }

  initialFocus(v: DocView): void {
    const list = v.focusables();
    if (list.length === 0) return;
    const wanted = v.doc.initialFocus !== undefined ? list.find((r) => r.w.id === v.doc.initialFocus) : undefined;
    this.setFocus(v, wanted ?? list[0]!, false);
  }

  setFocus(v: DocView, rec: Rec, emit: boolean): void {
    if (v.focus === rec) return;
    if (v.focus !== null) toggleClass(v.focus.el, 'is-focused', false);
    v.focus = rec;
    toggleClass(rec.el, 'is-focused', true);
    v.root.setAttribute?.('data-focus', rec.w.id ?? '');
    if (!emit) return;
    if (v.source === 'sim' && rec.w.id !== undefined) {
      this.deps.queueEvent({ kind: 'focus', doc: v.doc.uiDocumentId, widget: rec.w.id, name: '', ...(rec.scope.index !== undefined ? { index: rec.scope.index } : {}) });
    }
    this.runActions(v, rec, actionsOf(rec.w.onFocus), 'custom');
  }

  activate(v: DocView, rec: Rec): void {
    if (rec.w.type === 'input') {
      rec.el.focus?.();
      return;
    }
    this.runActions(v, rec, actionsOf(rec.w.onClick), 'click');
  }

  runActions(v: DocView, rec: Rec | null, actions: readonly UiAction[], kind: 'click' | 'submit' | 'custom', text?: string): void {
    const doc = v.doc.uiDocumentId;
    const widget = rec?.w.id ?? '';
    const index = rec?.scope.index;
    for (const a of actions) {
      switch (a.do) {
        case 'event': {
          const raw = a.value !== undefined ? v.resolve(a.value, rec?.scope ?? {}) : text;
          const value = raw === undefined || raw === null || typeof raw === 'number' || typeof raw === 'boolean' ? raw : typeof raw === 'string' ? raw.slice(0, 256) : uiValueText(raw).slice(0, 256);
          this.deps.queueEvent({ kind, doc, widget, name: a.name, ...(value !== undefined ? { value: typeof value === 'number' && !Number.isFinite(value) ? null : value } : {}), ...(index !== undefined ? { index } : {}) });
          break;
        }
        case 'engine':
          this.deps.engineAction(a);
          break;
        case 'show':
        case 'hide':
        case 'toggle':
          this.deps.queueEvent({ kind: a.do, doc: a.doc, widget, name: '' });
          break;
        case 'play':
          v.play(a.tween, a.widget);
          break;
        case 'dialogue': {
          // A dialogue input (choose: the action's value, else the list item's index).
          const idx = a.input === 'choose' ? (a.value ?? index) : undefined;
          if (a.input === 'choose' && idx === undefined) break;
          this.deps.dialogueInput?.({ kind: a.input, ...(idx !== undefined ? { index: idx } : {}) });
          break;
        }
        case 'mode':
          // A game mode switch rides on the next input frame (applied before that step's scripts).
          this.deps.queueEvent({ kind: 'mode', doc, widget, name: '', value: a.mode });
          break;
      }
    }
  }

  handleEdges(edges: UiEdges): UiEdges {
    const v = this.focusView();
    if (v === null) return edges;
    if (this.dirty) this.refreshAll();
    const out = { ...edges };
    const dir: NavDirection | null = edges.up ? 'up' : edges.down ? 'down' : edges.left ? 'left' : edges.right ? 'right' : null;
    if (dir !== null) {
      out.up = out.down = out.left = out.right = false;
      this.move(v, dir);
    }
    if (edges.submit) {
      out.submit = false;
      if (v.focus !== null && v.focus.enabled && v.focus.visible) this.activate(v, v.focus);
    }
    if (edges.cancel && v.doc.onCancel !== undefined) {
      out.cancel = false;
      this.runActions(v, null, actionsOf(v.doc.onCancel), 'custom');
    }
    return out;
  }

  private move(v: DocView, dir: NavDirection): void {
    const list = v.focusables();
    if (list.length === 0) return;
    const cur = v.focus !== null ? list.indexOf(v.focus) : -1;
    if (cur < 0) {
      this.setFocus(v, list[0]!, true);
      return;
    }
    const explicit = v.focus!.w.nav?.[dir];
    if (explicit !== undefined) {
      const target = v.findById(explicit, v.focus!.scope.index) ?? v.findById(explicit);
      if (target !== null && list.includes(target)) this.setFocus(v, target, true);
      return;
    }
    const rects = list.map((r) => {
      const b = r.el.getBoundingClientRect?.();
      return b !== undefined && (b.width > 0 || b.height > 0) ? b : null;
    });
    const here = rects[cur];
    const pick = here !== null && here !== undefined ? spatialPick(here, rects, dir, cur) : orderPick(list.length, cur, dir);
    if (pick >= 0) this.setFocus(v, list[pick]!, true);
  }

  /** The focused document's action map becomes the input's active map. */
  private updateMaps(): void {
    const v = this.focusView();
    const map = v?.doc.actionMap ?? null;
    if (map === this.activeMap) return;
    this.activeMap = map;
    this.deps.setActiveMaps?.(map === null ? null : [map]);
  }

  // --- world anchors ----------------------------------------------------------

  updateAnchors(project: UiProjector): void {
    if (this.disposed) return;
    const vp = this.viewport();
    for (const v of this.views()) {
      if (v.leaving) continue;
      v.walk((r) => {
        const a = r.w.worldAnchor;
        if (a === undefined || !r.visible) return;
        const target = a.point !== undefined ? { point: a.point, ...(a.offset !== undefined ? { offset: a.offset } : {}) } : r.anchorEntity !== null && r.anchorEntity !== undefined ? { entityId: r.anchorEntity, ...(a.offset !== undefined ? { offset: a.offset } : {}) } : null;
        const ok = target !== null && project(target, this.out);
        let state: string;
        if (!ok) state = 'offscreen';
        else {
          let x = this.out[0]!;
          let y = this.out[1]!;
          const front = this.out[2]! > 0;
          const inside = front && x >= 0 && x <= 1 && y >= 0 && y <= 1;
          if (!inside && a.clamp !== true) state = 'offscreen';
          else {
            let clamped = false;
            let angle = 0;
            if (!inside) {
              // Behind the camera the projection mirrors: point the other way.
              if (!front) {
                x = 1 - x;
                y = 1 - y;
              }
              let dx = x - 0.5;
              let dy = y - 0.5;
              if (dx === 0 && dy === 0) dy = 1;
              angle = Math.atan2(dy * vp.height, dx * vp.width);
              const m = a.margin ?? 24;
              const mx = Math.min(0.5, m / Math.max(1, vp.width));
              const my = Math.min(0.5, m / Math.max(1, vp.height));
              // Push along the ray from the centre to the edge rectangle.
              const sx = dx !== 0 ? (0.5 - mx) / Math.abs(dx) : Infinity;
              const sy = dy !== 0 ? (0.5 - my) / Math.abs(dy) : Infinity;
              const k = Math.min(sx, sy);
              dx *= k;
              dy *= k;
              x = 0.5 + dx;
              y = 0.5 + dy;
              clamped = true;
            }
            const sc = v.scale;
            const lx = (x * vp.width - sc.ox) / sc.s;
            const ly = (y * vp.height - sc.oy) / sc.s;
            setProp(r.el, 'left', `${Math.round(lx * 10) / 10}px`);
            setProp(r.el, 'top', `${Math.round(ly * 10) / 10}px`);
            if (clamped) setProp(r.el, '--tl-angle', `${Math.round(angle * 1000) / 1000}rad`);
            state = clamped ? 'clamped' : 'on';
          }
        }
        if (state !== r.anchorState) {
          r.anchorState = state;
          toggleClass(r.el, 'is-offscreen', state === 'offscreen');
          toggleClass(r.el, 'is-clamped', state === 'clamped');
          r.el.setAttribute?.('data-anchor', state);
        }
      });
    }
  }

  // --- Element rectangles, the pointer hit test, clicks ---------------

  private targetsCache: readonly UiHitTarget[] | null = null;

  /** An element's rectangle in fractions of the view (null: not laid out). */
  private rectOf(el: UiNode, vp: { width: number; height: number }): [number, number, number, number] | null {
    const b = el.getBoundingClientRect?.();
    if (b === undefined || !(b.width > 0) || !(b.height > 0)) return null;
    const q = (n: number): number => Math.round(n * 1e4) / 1e4;
    return [q(b.left / vp.width), q(b.top / vp.height), q(b.width / vp.width), q(b.height / vp.height)];
  }

  /** The widgets of a view that take the pointer (buttons and inputs, visible), in document order. */
  private pointerRecs(v: DocView): { rec: Rec; n: number }[] {
    const out: { rec: Rec; n: number }[] = [];
    let n = 0;
    const go = (r: Rec, shown: boolean): void => {
      const vis = shown && r.visible;
      if (vis && (r.w.type === 'button' || r.w.type === 'input')) out.push({ rec: r, n });
      n += 1;
      r.kids.forEach((k) => go(k, vis));
      (r.items ?? []).forEach((k) => go(k, vis));
    };
    if (v.top !== null) go(v.top, true);
    return out;
  }

  elements(max = 64): UiElementObservation[] {
    if (this.disposed) return [];
    if (this.dirty) this.refreshAll();
    const vp = this.viewport();
    const out: UiElementObservation[] = [];
    for (const v of this.views()) {
      if (v.leaving) continue;
      const go = (r: Rec, shown: boolean): void => {
        const vis = shown && r.visible;
        if (!vis || out.length >= max) return;
        const hit = r.w.type === 'button' || r.w.type === 'input';
        if (r.w.id !== undefined || hit) {
          const rect = this.rectOf(r.el, vp);
          if (rect !== null) {
            out.push({
              doc: v.doc.uiDocumentId,
              widget: r.w.id ?? '',
              type: r.w.type,
              ...(r.scope.index !== undefined ? { index: r.scope.index } : {}),
              rect,
              ...(hit ? { hit: true as const } : {}),
              ...(!r.enabled ? { disabled: true as const } : {}),
              ...(v.focus === r ? { focused: true as const } : {}),
            });
          }
        }
        r.kids.forEach((k) => go(k, vis));
        (r.items ?? []).forEach((k) => go(k, vis));
      };
      if (v.top !== null) go(v.top, true);
    }
    return out;
  }

  hitTargets(): readonly UiHitTarget[] {
    if (this.targetsCache !== null) return this.targetsCache;
    if (this.disposed) return [];
    if (this.dirty) this.refreshAll();
    const vp = this.viewport();
    const out: UiHitTarget[] = [];
    const views = this.views();
    // Topmost first: the screen, then the simulation's documents from the last shown, then the HUD.
    for (let i = views.length - 1; i >= 0; i -= 1) {
      const v = views[i]!;
      if (v.leaving) continue;
      const recs = this.pointerRecs(v);
      for (let k = recs.length - 1; k >= 0; k -= 1) {
        const rect = this.rectOf(recs[k]!.rec.el, vp);
        if (rect !== null) out.push({ key: `${v.source}:${v.doc.uiDocumentId}#${recs[k]!.n}`, rect });
      }
      // A modal document's backdrop takes every press below it.
      if (v.modal) out.push({ key: `${v.source}:${v.doc.uiDocumentId}#backdrop`, rect: [0, 0, 1, 1] });
    }
    this.targetsCache = out;
    return out;
  }

  click(key: string): boolean {
    if (this.disposed) return false;
    const hash = key.lastIndexOf('#');
    const colon = key.indexOf(':');
    if (hash < 0 || colon < 0) return false;
    const source = key.slice(0, colon);
    const docId = key.slice(colon + 1, hash);
    const v = this.views().find((x) => !x.leaving && x.source === source && x.doc.uiDocumentId === docId);
    if (v === undefined) return false;
    const which = key.slice(hash + 1);
    if (which === 'backdrop') return true;
    const n = Number(which);
    const hit = this.pointerRecs(v).find((r) => r.n === n);
    if (hit === undefined) return false;
    const rec = hit.rec;
    if (!rec.enabled || !rec.visible) return true;
    if (rec.w.type === 'input') {
      if (v.wantsFocus) this.setFocus(v, rec, true);
      rec.el.focus?.();
      return true;
    }
    // As a pointer click: the hover takes the focus in a focused document, then the button's click runs.
    if (v.wantsFocus) this.setFocus(v, rec, true);
    this.activate(v, rec);
    return true;
  }

  observe(): UiLayerObservation {
    const v = this.focusView();
    const f = v?.focus ?? null;
    return {
      shown: this.sim.filter((x) => !x.leaving).map((x) => x.doc.uiDocumentId),
      screen: this.screenId,
      ...(this.hud.length > 0 ? { hud: this.hud.filter((x) => !x.leaving).map((x) => x.doc.uiDocumentId) } : {}),
      focus: v !== null && f !== null ? { doc: v.doc.uiDocumentId, widget: f.w.id ?? '', ...(f.scope.index !== undefined ? { index: f.scope.index } : {}) } : null,
      actionMap: this.activeMap ?? null,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const v of this.views()) v.dispose();
    this.sim = [];
    this.hud = [];
    this.screen = null;
    this.root.remove();
    const docLike = this.dom as unknown as { adoptedStyleSheets?: unknown[] };
    if (this.baseSheet !== null && Array.isArray(docLike.adoptedStyleSheets)) docLike.adoptedStyleSheets = docLike.adoptedStyleSheets.filter((x) => x !== this.baseSheet);
    // The images and font faces are let go (freed once no one else holds them).
    this.images.clear();
    this.fonts.clear();
    this.resources.releaseHolder(this.holder);
    if (this.deps.resources === undefined) this.resources.dispose();
    if (this.activeMap !== null && this.activeMap !== undefined) this.deps.setActiveMaps?.(null);
  }
}

/** Names each layer's holder apart (a Play page and an editor preview may each have one). */
let layerSerial = 0;

/** Create the project UI layer (see the module comment). */
export function createUiLayer(deps: UiLayerDeps): UiLayer {
  return new LayerImpl(deps);
}
