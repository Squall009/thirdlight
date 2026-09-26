/**
 * Phase 16.0: the document-kind registry of the centre workspace.
 *
 * A document kind says how one kind of document appears as a centre tab:
 * its label ("Animator"), its icon, the tab title for a document id and the
 * view that edits it. The tab strip, the layout storage, Ctrl+Tab, closing
 * and reordering are generic; a later phase (materials, effects, visual
 * scripts) adds an entry to `DOCUMENT_KINDS` (and, when its view needs data
 * the app holds, a field to `WorkspaceHost`) — the workspace itself does not
 * change.
 *
 * Browser-only (React).
 */
import type { ReactNode } from 'react';

import type { GraphDocument } from '@thirdlight/project-model';

import { GraphEditor } from '../../graph/GraphEditor';
import type { GraphContext, GraphKindDef, GraphOp } from '../../graph/model';
import { MaterialDocument, type MaterialDocumentProps } from '../material/MaterialDocument';
import { EffectDocument, type EffectDocumentProps } from '../effect/EffectDocument';
import type { DocRef } from '../../session/workspace-tabs';
import type { AnimatorPanelProps } from '../AnimatorPanel';
import { AnimatorDocument, type AnimatorDocumentProps } from '../animator/AnimatorDocument';
import type { BehaviorPanelProps } from '../BehaviorPanel';
import { ScriptDocument, type ScriptDocumentProps } from '../script/ScriptDocument';
import { VisualScriptDocument, type VisualScriptDocumentProps } from '../script/VisualScriptDocument';
import { LibraryDocument, type LibraryDocumentProps } from '../script/LibraryDocument';
import type { ScriptLibrary } from '@thirdlight/project-model';

/** What document views get from the app: the data and actions of the panels they reuse. */
export interface WorkspaceHost {
  /** The Animator's props (the bottom-dock panel uses the same). */
  animator: AnimatorPanelProps;
  /** Phase 16.2: the props of one controller's tab (graph, layers, preview pane). */
  animatorDocument: (controllerId: string) => AnimatorDocumentProps;
  /** The Behaviors panel's props (the bottom-dock panel uses the same). */
  behavior: BehaviorPanelProps;
  /** Phase 16.3: the script editor's data and actions (all behaviors share them). */
  script: Omit<ScriptDocumentProps, 'behaviorId' | 'behavior'>;
  /** Phase 23.7: the shared script libraries and the library editor's actions. */
  library: Omit<LibraryDocumentProps, 'libraryId' | 'library'> & { libraries: readonly ScriptLibrary[] };
  /** Phase 16.1: standalone graph documents, their kinds and the graph edit path. */
  graph: {
    graphs: readonly GraphDocument[];
    kinds: Readonly<Record<string, GraphKindDef>>;
    /** Sends `graphEdit` ops for a standalone graph (queued; resolves with a refusal or null). */
    onEdit: (graphId: string, ops: GraphOp[]) => Promise<string | null>;
    /** The graph editor's selection (the Graph inspector in the right dock shows it). */
    onSelection: (ids: readonly string[]) => void;
    /** A node to frame and focus (e.g. from the Problems tab). */
    focus: { id: string; nonce: number } | null;
    /** Phase 18.1: sub-graph calls in a standalone graph (material functions calling functions) read their ports here. */
    portContext: GraphContext;
  };
  /** Phase 19.0: visual scripts (behaviors with a graph) — everything but the behavior itself. */
  visualScript: Omit<VisualScriptDocumentProps, 'behaviorId' | 'behavior'>;
  /** Phase 18.0: the props of one graph material's tab (all materials share them). */
  material: Omit<MaterialDocumentProps, 'materialId'>;
  /** Phase 20.0: the props of one effect's tab (all effects share them). */
  effect: Omit<EffectDocumentProps, 'effectId'>;
  /** Close a document's tab (e.g. after the document was deleted from its tab). */
  close: (doc: DocRef) => void;
}

export interface DocumentKind {
  /** Stable identifier stored in the layout storage (`[a-z][a-z0-9-]*`). */
  kind: string;
  /** The tab title's prefix ("Animator: Locomotion"). */
  label: string;
  /** A small image shown in the tab. */
  icon: string;
  /** The document's display name (falls back to its id when it is gone). */
  name: (id: string, host: WorkspaceHost) => string;
  /** The view that edits the document; it fills the centre area. */
  render: (id: string, host: WorkspaceHost) => ReactNode;
}

const animatorKind: DocumentKind = {
  kind: 'animator',
  label: 'Animator',
  icon: './icons/model.png',
  name: (id, host) => host.animator.controllers.find((c) => c.controllerId === id)?.name ?? id,
  // Phase 16.2: the controller's state machine on the graph framework (AnimatorDocument).
  render: (id, host) => {
    const props = host.animatorDocument(id);
    return (
      <AnimatorDocument
        key={id}
        {...props}
        onDelete={(controllerId) => {
          props.onDelete(controllerId);
          host.close({ kind: 'animator', id: controllerId });
        }}
      />
    );
  },
};

const scriptKind: DocumentKind = {
  kind: 'script',
  label: 'Script',
  icon: './icons/script.png',
  name: (id, host) => host.behavior.behaviors.find((b) => b.behaviorId === id)?.displayName ?? id,
  // Phase 16.3: the code editor (files, compile diagnostics, publish) with
  // the declaration editor docked beside it. Keyed by the behavior so a
  // different behavior never inherits another's view state.
  render: (id, host) => (
    <ScriptDocument key={id} {...host.script} behaviorId={id} behavior={host.behavior.behaviors.find((b) => b.behaviorId === id) ?? null} />
  ),
};

/** A small node-graph glyph (three linked boxes) for graph tabs. */
const GRAPH_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M5 4h4M5 4l5 8" stroke="#8fb4ff" stroke-width="1.5" fill="none"/><rect x="1" y="2" width="5" height="4" rx="1" fill="#8fb4ff"/><rect x="9" y="2" width="6" height="4" rx="1" fill="#f2b544"/><rect x="9" y="10" width="6" height="4" rx="1" fill="#7ed491"/></svg>',
  );

const graphKind: DocumentKind = {
  kind: 'graph',
  label: 'Graph',
  icon: GRAPH_ICON,
  name: (id, host) => host.graph.graphs.find((g) => g.graphId === id)?.name ?? id,
  // Phase 16.1: a standalone graph document in the generic graph editor.
  // Keyed by the graph so view state (pan, zoom, selection) is per graph.
  render: (id, host) => {
    const g = host.graph.graphs.find((x) => x.graphId === id);
    if (g === undefined) return <p className="tl-hint">The graph "{id}" is not in this project (it may still be loading).</p>;
    const k = host.graph.kinds[g.kind];
    if (k === undefined) return <p className="tl-hint">This editor does not know the graph kind "{g.kind}".</p>;
    return (
      <GraphEditor
        key={id}
        kind={k}
        owner={{ kind: 'graph', id }}
        graph={g.graph}
        onEdit={(ops) => host.graph.onEdit(id, ops)}
        onSelection={host.graph.onSelection}
        focus={host.graph.focus}
        portContext={host.graph.portContext}
      />
    );
  },
};

/** A small sphere glyph for material tabs. */
const MATERIAL_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><defs><radialGradient id="g" cx="0.35" cy="0.35" r="0.7"><stop offset="0" stop-color="#ffe6a8"/><stop offset="1" stop-color="#b8742a"/></radialGradient></defs><circle cx="8" cy="8" r="6.5" fill="url(#g)"/></svg>');

const materialKind: DocumentKind = {
  kind: 'material',
  label: 'Material',
  icon: MATERIAL_ICON,
  name: (id, host) => host.material.materials.find((m) => m.materialId === id)?.name ?? id,
  // Phase 18.0: a graph material's node graph (MaterialDocument). Keyed by the material.
  render: (id, host) => <MaterialDocument key={id} {...host.material} materialId={id} />,
};

/**
 * Phase 19.0: a visual script — a behavior whose source is a graph — in the
 * generic graph editor with the `behavior` kind ("Graph: <behavior>").
 */
const visualScriptKind: DocumentKind = {
  kind: 'visual-script',
  label: 'Graph',
  icon: GRAPH_ICON,
  name: (id, host) => host.behavior.behaviors.find((b) => b.behaviorId === id)?.displayName ?? id,
  render: (id, host) => <VisualScriptDocument key={id} {...host.visualScript} behaviorId={id} behavior={host.behavior.behaviors.find((b) => b.behaviorId === id) ?? null} />,
};

/** A small spark glyph for effect tabs. */
const EFFECT_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M8 1l1.6 4.4L14 7l-4.4 1.6L8 13l-1.6-4.4L2 7l4.4-1.6z" fill="#f2b544"/><circle cx="13" cy="13" r="1.6" fill="#ff7f9e"/><circle cx="3" cy="13.5" r="1.1" fill="#8fb4ff"/></svg>');

/** Phase 20.0: an effect's particle systems, each a graph of kind `effect` ("Effect: <name>"). */
const effectKind: DocumentKind = {
  kind: 'effect',
  label: 'Effect',
  icon: EFFECT_ICON,
  name: (id, host) => host.effect.effects.find((e) => e.effectId === id)?.name ?? id,
  render: (id, host) => <EffectDocument key={id} {...host.effect} effectId={id} />,
};

/** Phase 23.7: a shared script library's files in the code editor ("Library: <name>"). */
const libraryKind: DocumentKind = {
  kind: 'script-library',
  label: 'Library',
  icon: './icons/script.png',
  name: (id, host) => host.library.libraries.find((l) => l.libraryId === id)?.name ?? id,
  render: (id, host) => {
    const { libraries, ...rest } = host.library;
    return <LibraryDocument key={id} {...rest} libraryId={id} library={libraries.find((l) => l.libraryId === id) ?? null} />;
  },
};

/** Every document kind the centre workspace can open, in no particular order. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = [animatorKind, scriptKind, graphKind, materialKind, visualScriptKind, effectKind, libraryKind];

const BY_KIND = new Map(DOCUMENT_KINDS.map((k) => [k.kind, k]));
export const KNOWN_DOCUMENT_KINDS: ReadonlySet<string> = new Set(BY_KIND.keys());

export function documentKind(kind: string): DocumentKind | undefined {
  return BY_KIND.get(kind);
}

/** "Animator: Locomotion" — the tab's title and accessible name. */
export function documentTitle(doc: DocRef, host: WorkspaceHost): string {
  const k = documentKind(doc.kind);
  return k === undefined ? doc.id : `${k.label}: ${k.name(doc.id, host)}`;
}
