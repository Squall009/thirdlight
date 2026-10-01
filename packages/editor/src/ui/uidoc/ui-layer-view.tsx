/**
 * A UI document drawn by the game host's own project UI layer
 * (`@thirdlight/game-host/ui-layer`, the code Play and exports run) at a
 * resolution, fed with mock view-model values — the one path both the UI
 * editor's editing surface and the editor window's preview pane draw a UI
 * document with.
 *
 * The layer is rebuilt when the document, its themes or the resolution
 * change (a layer builds each shown document once); mock values are applied
 * as a view-model reset. World-anchored widgets sit at the view's centre
 * (there is no camera here). Show/hide tweens are left out so an edit does
 * not replay them.
 *
 * Browser-only (React + DOM).
 */
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react';
import { createUiLayer, type HostDom, type HostDomNode, type UiLayer } from '@thirdlight/game-host/ui-layer';
import type { UiDocument, UiTheme } from '@thirdlight/project-model';

import { mockWrites } from '../../session/ui-edit';

export interface PreviewAssets {
  /** assetId → an artifact path the reader understands. */
  readonly paths: Readonly<Record<string, string>>;
  readonly read: (path: string) => Promise<ArrayBuffer>;
}

export interface UiLayerInput {
  doc: UiDocument;
  themes: readonly UiTheme[];
  mock: Record<string, unknown>;
  size: { w: number; h: number };
  assets: PreviewAssets;
}

const noop = (): void => undefined;

/** The document as a preview draws it: no show/hide tweens (an edit would replay them). */
function previewDoc(doc: UiDocument): UiDocument {
  const { showTween: _s, hideTween: _h, ...rest } = doc;
  return rest as UiDocument;
}

/** The zoom that fits a `w` × `h` box into `stageRef`'s element, `margin` px from each edge. */
export function useFitZoom(stageRef: RefObject<HTMLElement | null>, w: number, h: number, margin: number): number {
  const [zoom, setZoom] = useState(0.5);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const fit = (): void => {
      const cw = stage.clientWidth - 2 * margin;
      const ch = stage.clientHeight - 2 * margin;
      if (cw > 0 && ch > 0) setZoom(Math.max(0.05, Math.min(cw / w, ch / h)));
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(stage);
    return () => ro?.disconnect();
  }, [stageRef, w, h, margin]);
  return zoom;
}

/** The UI layer drawing `input.doc` into `hostRef`'s element, alive while the caller is mounted. */
export function useUiLayer(hostRef: RefObject<HTMLElement | null>, input: UiLayerInput): RefObject<UiLayer | null> {
  const layerRef = useRef<UiLayer | null>(null);
  const flowRef = useRef<Record<string, unknown> | null>(null);
  const latest = useRef(input);
  latest.current = input;
  const { w, h } = input.size;

  // The layer: rebuilt when what it draws changes.
  const docKey = JSON.stringify([input.doc, input.themes, w, h, input.assets.paths]);
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const p = latest.current;
    const doc = previewDoc(p.doc);
    const layer = createUiLayer({
      dom: document as unknown as HostDom,
      container: host as unknown as HostDomNode,
      documents: [doc],
      themes: p.themes,
      assetPaths: p.assets.paths,
      readArtifact: p.assets.read,
      queueEvent: noop,
      engineAction: noop,
      flowValues: () => flowRef.current,
      viewport: () => ({ width: w, height: h }),
      annotate: true,
    });
    layerRef.current = layer;
    const m = mockWrites(p.mock);
    flowRef.current = m.flow;
    layer.applyOutput({ reset: true, set: m.set, shown: [{ doc: doc.uiDocumentId, layer: 0, modal: false }], commands: [] });
    layer.frame();
    return () => {
      layer.dispose();
      if (layerRef.current === layer) layerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the layer is rebuilt only when the document's content key changes
  }, [docKey]);

  // Mock values: a view-model reset (the layer keeps its widgets).
  const mockKey = JSON.stringify(input.mock);
  useEffect(() => {
    const layer = layerRef.current;
    if (layer === null) return;
    const m = mockWrites(latest.current.mock);
    flowRef.current = m.flow;
    layer.applyOutput({ reset: true, set: m.set, commands: [] });
    layer.frame();
  }, [mockKey]);

  // Each frame: late assets (images, fonts), world anchors at the centre.
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      const layer = layerRef.current;
      if (layer === null) return;
      layer.frame();
      layer.updateAnchors((_t, out) => {
        out[0] = 0.5;
        out[1] = 0.5;
        out[2] = 1;
        return true;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return layerRef;
}

/**
 * The document alone at its resolution, scaled to fit and centred in its
 * box, over whatever is behind it (the preview pane puts the scene there).
 */
export function UiDocumentView(input: UiLayerInput & { label: string }): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { w, h } = input.size;
  const zoom = useFitZoom(stageRef, w, h, 0);
  useUiLayer(hostRef, input);
  return (
    <div className="tl-uiview" ref={stageRef}>
      <div className="tl-uiview__screen" style={{ width: w, height: h, transform: `translate(-50%, -50%) scale(${zoom})` }} data-preview-size={`${w}x${h}`} data-zoom={zoom.toFixed(4)}>
        <div className="tl-uidoc__host" ref={hostRef} aria-label={input.label} />
      </div>
    </div>
  );
}
