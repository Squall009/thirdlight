/**
 * The document-kind registry of the editor window.
 *
 * A document kind says how one kind of document appears as a tab of the editor window:
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
import type { DocRef } from '../../session/editor-window';
import type { PreviewDeps } from '../preview/use-subject';
import type { AnimatorControllersProps } from '../animator/parts';
import { AnimatorDocument, type AnimatorDocumentProps } from '../animator/AnimatorDocument';
import type { BehaviorPanelProps } from '../BehaviorPanel';
import { ScriptDocument, type ScriptDocumentProps } from '../script/ScriptDocument';
import { VisualScriptDocument, type VisualScriptDocumentProps } from '../script/VisualScriptDocument';
import { LibraryDocument, type LibraryDocumentProps } from '../script/LibraryDocument';
import { DialogueDocument, type DialogueDocumentProps } from '../dialogue/DialogueDocument';
import { TimelineDocument, type TimelineDocumentProps } from '../timeline/TimelineDocument';
import type { ScriptLibrary } from '@thirdlight/project-model';
import type { UiDocument, UiTheme } from '@thirdlight/project-model';
import { UiDocumentEditor, type UiDocumentEditorProps } from '../uidoc/UiDocumentEditor';
import { UiThemeDocument, type UiThemeDocumentProps } from '../uidoc/UiThemeDocument';

/** What document views get from the app: the data and actions of the panels they reuse. */
export interface WorkspaceHost {
  /** The Animator's props (the bottom-dock panel uses the same). */
  animator: AnimatorControllersProps;
  /** The props of one controller's tab (graph, layers, parameters). */
  animatorDocument: (controllerId: string) => AnimatorDocumentProps;
  /** The Behaviors panel's props (the bottom-dock panel uses the same). */
  behavior: BehaviorPanelProps;
  /** The script editor's data and actions (all behaviors share them). */
  script: Omit<ScriptDocumentProps, 'behaviorId' | 'behavior'>;
  /** The shared script libraries and the library editor's actions. */
  library: Omit<LibraryDocumentProps, 'libraryId' | 'library'> & { libraries: readonly ScriptLibrary[] };
  /** Standalone graph documents, their kinds and the graph edit path. */
  graph: {
    graphs: readonly GraphDocument[];
    kinds: Readonly<Record<string, GraphKindDef>>;
    /** Sends `graphEdit` ops for a standalone graph (queued; resolves with a refusal or null). */
    onEdit: (graphId: string, ops: GraphOp[]) => Promise<string | null>;
    /** The graph editor's selection (the Graph inspector in the right dock shows it). */
    onSelection: (ids: readonly string[]) => void;
    /** A node to frame and focus (e.g. from the Problems tab). */
    focus: { id: string; nonce: number } | null;
    /** Sub-graph calls in a standalone graph (material functions calling functions) read their ports here. */
    portContext: GraphContext;
  };
  /** Visual scripts (behaviors with a graph) — everything but the behavior itself. */
  visualScript: Omit<VisualScriptDocumentProps, 'behaviorId' | 'behavior'>;
  /** The props of one graph material's tab (all materials share them). */
  material: Omit<MaterialDocumentProps, 'materialId'>;
  /** The props of one effect's tab (all effects share them). */
  effect: Omit<EffectDocumentProps, 'effectId'>;
  /** The props of one conversation's tab (all conversations share them). */
  dialogue: Omit<DialogueDocumentProps, 'dialogueId'>;
  /** The props of one timeline's tab (all timelines share them). */
  timeline: Omit<TimelineDocumentProps, 'timelineId'>;
  /** The project UI documents and themes, and the props of one document's / theme's tab. */
  ui: {
    documents: readonly UiDocument[];
    themes: readonly UiTheme[];
    document: (uiDocumentId: string) => UiDocumentEditorProps;
    theme: (uiThemeId: string) => UiThemeDocumentProps;
  };
  /** What the editor window's preview pane builds its subjects from. */
  preview: PreviewDeps;
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
  // The controller's state machine on the graph framework (AnimatorDocument).
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
  // The code editor (files, compile diagnostics, publish) with
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
  // A standalone graph document in the generic graph editor.
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
  // A graph material's node graph (MaterialDocument). Keyed by the material.
  render: (id, host) => <MaterialDocument key={id} {...host.material} materialId={id} />,
};

/**
 * A visual script — a behavior whose source is a graph — in the
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

/** An effect's particle systems, each a graph of kind `effect` ("Effect: <name>"). */
const effectKind: DocumentKind = {
  kind: 'effect',
  label: 'Effect',
  icon: EFFECT_ICON,
  name: (id, host) => host.effect.effects.find((e) => e.effectId === id)?.name ?? id,
  render: (id, host) => <EffectDocument key={id} {...host.effect} effectId={id} />,
};

/** A shared script library's files in the code editor ("Library: <name>"). */
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

/** A small speech-bubble glyph for dialogue tabs. */
const DIALOGUE_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 3h12v7H7l-3 3v-3H2z" fill="#8fb4ff"/><rect x="4" y="5" width="8" height="1.2" fill="#1b1f2a"/><rect x="4" y="7.2" width="5" height="1.2" fill="#1b1f2a"/></svg>');

/** A conversation's node graph and its previewer ("Dialogue: <name>"). */
const dialogueKind: DocumentKind = {
  kind: 'dialogue',
  label: 'Dialogue',
  icon: DIALOGUE_ICON,
  name: (id, host) => host.dialogue.dialogues.find((d) => d.dialogueId === id)?.name ?? id,
  render: (id, host) => <DialogueDocument key={id} {...host.dialogue} dialogueId={id} />,
};
/** A small ruler-and-keys glyph for timeline tabs. */
const TIMELINE_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="3" width="14" height="2" fill="#8fb4ff"/><rect x="1" y="7" width="14" height="2" fill="#5e81ac"/><rect x="1" y="11" width="14" height="2" fill="#5e81ac"/><path d="M5 6.5l1.5 1.5L5 9.5 3.5 8z" fill="#f2b544"/><path d="M11 10.5l1.5 1.5-1.5 1.5L9.5 12z" fill="#f2b544"/><rect x="7.5" y="1" width="1" height="14" fill="#ff7f9e"/></svg>');

/** A timeline's tracks on a time ruler ("Timeline: <name>"). */
const timelineKind: DocumentKind = {
  kind: 'timeline',
  label: 'Timeline',
  icon: TIMELINE_ICON,
  name: (id, host) => host.timeline.timelines.find((t) => t.timelineId === id)?.name ?? id,
  render: (id, host) => <TimelineDocument key={id} {...host.timeline} timelineId={id} />,
};

/** A small screen-with-widgets glyph for UI tabs. */
const UI_ICON =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="2" width="14" height="12" rx="1.5" fill="none" stroke="#8fb4ff" stroke-width="1.4"/><rect x="3" y="4" width="6" height="2" fill="#7ed491"/><rect x="3" y="8" width="10" height="2" rx="1" fill="#f2b544"/></svg>');

/** A UI document's visual editor ("UI: <name>"). */
const uiDocumentKind: DocumentKind = {
  kind: 'ui-document',
  label: 'UI',
  icon: UI_ICON,
  name: (id, host) => host.ui.documents.find((d) => d.uiDocumentId === id)?.name ?? id,
  render: (id, host) => <UiDocumentEditor key={id} {...host.ui.document(id)} />,
};

/** A UI theme's styles and icons ("UI theme: <name>"). */
const uiThemeKind: DocumentKind = {
  kind: 'ui-theme',
  label: 'UI theme',
  icon: UI_ICON,
  name: (id, host) => host.ui.themes.find((t) => t.uiThemeId === id)?.name ?? id,
  render: (id, host) => <UiThemeDocument key={id} {...host.ui.theme(id)} />,
};

/** Every document kind the editor window can open, in no particular order. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = [animatorKind, scriptKind, graphKind, materialKind, visualScriptKind, effectKind, libraryKind, uiDocumentKind, uiThemeKind, timelineKind, dialogueKind];

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
