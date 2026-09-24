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

import type { DocRef } from '../../session/workspace-tabs';
import { AnimatorPanel, type AnimatorPanelProps } from '../AnimatorPanel';
import type { BehaviorPanelProps } from '../BehaviorPanel';
import { ScriptDocument, type ScriptDocumentProps } from '../script/ScriptDocument';

/** What document views get from the app: the data and actions of the panels they reuse. */
export interface WorkspaceHost {
  /** The Animator's props (the bottom-dock panel uses the same). */
  animator: AnimatorPanelProps;
  /** The Behaviors panel's props (the bottom-dock panel uses the same). */
  behavior: BehaviorPanelProps;
  /** Phase 16.3: the script editor's data and actions (all behaviors share them). */
  script: Omit<ScriptDocumentProps, 'behaviorId' | 'behavior'>;
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
  render: (id, host) => (
    <AnimatorPanel
      {...host.animator}
      controllerId={id}
      onDelete={(controllerId) => {
        host.animator.onDelete(controllerId);
        host.close({ kind: 'animator', id: controllerId });
      }}
    />
  ),
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

/** Every document kind the centre workspace can open, in no particular order. */
export const DOCUMENT_KINDS: readonly DocumentKind[] = [animatorKind, scriptKind];

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
