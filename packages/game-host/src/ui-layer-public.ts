/**
 * Phase 23.9b: the game host's project UI layer as its own public subpath
 * (`@thirdlight/game-host/ui-layer`), so the editor's UI document preview
 * draws documents with the very code Play and exports use — not a copy.
 * Only the layer and its types; the host composition stays behind `.`.
 */
export { createUiLayer, type UiLayer, type UiLayerDeps, type UiLayerObservation, type UiProjector } from './ui-layer';
export type { HostDom, HostDomNode } from './hud';
export type { FlowUiEdges } from './flow';
