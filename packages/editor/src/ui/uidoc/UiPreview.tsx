/**
 * The UI document preview — the document drawn by the game
 * host's own project UI layer (`@thirdlight/game-host/ui-layer`, the code
 * Play and exports run), inside a box of the chosen resolution scaled to fit
 * the tab, fed with the mock view-model values. On top: the selection box
 * with its resize grips, snap guides and the safe-area frame; pointer input
 * goes to that overlay (the widgets never receive clicks here).
 *
 * The layer is rebuilt when the document, its themes or the resolution
 * change (a layer builds each shown document once); mock values are applied
 * as a view-model reset. World-anchored widgets sit at the view's centre
 * (there is no camera here). Show/hide tweens are left out so an edit does
 * not replay them; the Tweens section plays one on demand.
 *
 * Browser-only (React + DOM).
 */
import { useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { UiDocument, UiTheme } from '@thirdlight/project-model';

import { type Rect, type ResizeHandle, RESIZE_HANDLES } from '../../session/ui-edit';
import { useFitZoom, useUiLayer, type PreviewAssets } from './ui-layer-view';

export type { PreviewAssets } from './ui-layer-view';

/** What the editor measures of a widget in the preview (document px, parent-local). */
export interface Measured {
  readonly rect: Rect;
  readonly parent: { w: number; h: number };
  readonly siblings: Rect[];
  /** Screen px per document px. */
  readonly k: number;
  /** The parent's inner box origin in preview (resolution) px, and preview px per document px (snap guides are drawn with them). */
  readonly origin: { x: number; y: number };
  readonly kp: number;
}

export interface PreviewHandle {
  /** Measure the widget drawn for this path key (the first item of a list template). */
  measure(key: string): Measured | null;
  /** The deepest widget under a screen point (its path key), or null. */
  hit(clientX: number, clientY: number): string | null;
  /** The widget drawn for this path key covers the screen point. */
  contains(key: string, clientX: number, clientY: number): boolean;
  /** Play one of the document's tweens now (presentation only). */
  play(tween: string, widget?: string): void;
}

interface Props {
  doc: UiDocument;
  themes: readonly UiTheme[];
  mock: Record<string, unknown>;
  size: { w: number; h: number };
  assets: PreviewAssets;
  /** The selected widget's path key (null: none). */
  selected: string | null;
  /** Show the resize grips on the selection. */
  resizable: boolean;
  safeAreaPercent: number | null;
  guides: { x: number | null; y: number | null; key: string | null };
  handleRef: (h: PreviewHandle | null) => void;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>, grip: ResizeHandle | null) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  children?: ReactNode;
}

/** Below this on-screen size (px) a selection shows only its corner grips (a grip is 12 px). */
const MIN_EDGE_GRIPS_PX = 40;
const cssEscape = (s: string): string => s.replace(/["\\]/g, '');

export function UiPreview(p: Props): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Rect | null>(null);
  const { w, h } = p.size;

  const zoom = useFitZoom(stageRef, w, h, 8);
  const layerRef = useUiLayer(hostRef, { doc: p.doc, themes: p.themes, mock: p.mock, size: p.size, assets: p.assets });

  // Each frame: the selection box (the layer draws itself, useUiLayer).
  const selectedRef = useRef(p.selected);
  selectedRef.current = p.selected;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    let raf = 0;
    let last = '';
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const key = selectedRef.current;
      const screen = screenRef.current;
      const host = hostRef.current;
      let next: Rect | null = null;
      if (key !== null && screen !== null && host !== null) {
        const el = host.querySelector(`[data-tl-path="${cssEscape(key)}"]`);
        if (el !== null) {
          const s = screen.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          const z = zoomRef.current;
          next = { x: (r.left - s.left) / z, y: (r.top - s.top) / z, w: r.width / z, h: r.height / z };
        }
      }
      const k = next === null ? '' : `${next.x.toFixed(1)},${next.y.toFixed(1)},${next.w.toFixed(1)},${next.h.toFixed(1)}`;
      if (k !== last) {
        last = k;
        setBox(next);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // The measuring handle the editor drags with.
  useEffect(() => {
    const handle: PreviewHandle = {
      measure(key) {
        const host = hostRef.current;
        const el = host?.querySelector(`[data-tl-path="${cssEscape(key)}"]`) as HTMLElement | null | undefined;
        const parentEl = el?.parentElement;
        if (el === null || el === undefined || parentEl === null || parentEl === undefined) return null;
        const pr = parentEl.getBoundingClientRect();
        const k = parentEl.offsetWidth > 0 ? pr.width / parentEl.offsetWidth : zoomRef.current;
        if (!(k > 0)) return null;
        const ox = pr.left + parentEl.clientLeft * k;
        const oy = pr.top + parentEl.clientTop * k;
        const local = (r: DOMRect): Rect => ({ x: (r.left - ox) / k, y: (r.top - oy) / k, w: r.width / k, h: r.height / k });
        const siblings: Rect[] = [];
        for (const c of Array.from(parentEl.children)) if (c !== el && c.hasAttribute('data-tl-path')) siblings.push(local(c.getBoundingClientRect()));
        const sr = screenRef.current?.getBoundingClientRect();
        const z = zoomRef.current;
        const origin = sr === undefined ? { x: 0, y: 0 } : { x: (ox - sr.left) / z, y: (oy - sr.top) / z };
        return { rect: local(el.getBoundingClientRect()), parent: { w: parentEl.clientWidth, h: parentEl.clientHeight }, siblings, k, origin, kp: k / z };
      },
      hit(x, y) {
        const host = hostRef.current;
        if (host === null) return null;
        let best: { key: string; depth: number; order: number } | null = null;
        const all = Array.from(host.querySelectorAll('[data-tl-path]'));
        all.forEach((el, order) => {
          const r = el.getBoundingClientRect();
          if (r.width <= 0 && r.height <= 0) return;
          if (x < r.left || x > r.right || y < r.top || y > r.bottom) return;
          if (getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') return;
          const key = el.getAttribute('data-tl-path')!;
          const depth = key.split('.').length;
          if (best === null || depth > best.depth || (depth === best.depth && order > best.order)) best = { key, depth, order };
        });
        return (best as { key: string } | null)?.key ?? null;
      },
      contains(key, x, y) {
        const el = hostRef.current?.querySelector(`[data-tl-path="${cssEscape(key)}"]`);
        if (el === null || el === undefined) return false;
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      },
      play(tween, widget) {
        layerRef.current?.applyOutput({ set: [], commands: [{ op: 'play', doc: p.doc.uiDocumentId, tween, widget: widget ?? '' }] });
      },
    };
    p.handleRef(handle);
    return () => p.handleRef(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handle is published once per document; it reaches the layer through a ref
  }, [p.doc.uiDocumentId]);

  const safe = p.safeAreaPercent;
  return (
    <div className="tl-uidoc__stage" ref={stageRef}>
      <div className="tl-uidoc__screen" ref={screenRef} style={{ width: w, height: h, transform: `scale(${zoom})` }} data-preview-size={`${w}x${h}`} data-zoom={zoom.toFixed(4)}>
        <div className="tl-uidoc__host" ref={hostRef} aria-label="UI preview" />
        <div
          className="tl-uidoc__overlay"
          tabIndex={0}
          aria-label="UI preview canvas"
          onPointerDown={(e) => p.onPointerDown(e, null)}
          onPointerMove={p.onPointerMove}
          onPointerUp={p.onPointerUp}
          onPointerCancel={p.onPointerUp}
          onKeyDown={p.onKeyDown}
        >
          {safe !== null && <div className="tl-uidoc__safe" aria-label="safe area" style={{ left: `${safe}%`, top: `${safe}%`, right: `${safe}%`, bottom: `${safe}%` }} />}
          {p.guides.x !== null && <div className="tl-uidoc__guide tl-uidoc__guide--x" style={{ left: p.guides.x }} />}
          {p.guides.y !== null && <div className="tl-uidoc__guide tl-uidoc__guide--y" style={{ top: p.guides.y }} />}
          {box !== null && (
            <div className="tl-uidoc__sel" aria-label="selection" style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
              {p.resizable &&
                // A small box keeps only its corner grips (the edge-middle ones would cover it and leave nothing to grab for a move).
                RESIZE_HANDLES.filter((g) => g.length === 2 || (box.w * zoom >= MIN_EDGE_GRIPS_PX && box.h * zoom >= MIN_EDGE_GRIPS_PX)).map((g) => (
                  <div
                    key={g}
                    className={`tl-uidoc__grip tl-uidoc__grip--${g}`}
                    data-grip={g}
                    aria-label={`resize ${g}`}
                    style={{ transform: `scale(${1 / zoom})` }}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      p.onPointerDown(e, g);
                    }}
                  />
                ))}
            </div>
          )}
        </div>
      </div>
      {p.children}
    </div>
  );
}
