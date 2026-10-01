/**
 * The "Dialogue: <name>" tab of the editor window — one conversation's node
 * graph (graph kind `dialogue` on the graph framework).
 *
 * - The graph: every gesture is one `graphEdit` on owner kind `dialogue`
 *   (owner id = the dialogueId); the selected node shows in the right dock's
 *   Inspector (speaker, expression, text, voice clip, auto-advance, a
 *   condition, effects…). Start is fixed; wires say what comes next.
 * - The previewer (the editor window's preview pane): plays the
 *   conversation outside Play over its scene with the game's own dialogue UI
 *   and audio — from the start, an entry or the selected node, with starting
 *   variables.
 *
 * Browser-only (React).
 */
import { useMemo, type JSX } from 'react';
import type { DialogueDocument as DialogueDoc, DialogueSettings, DialogueSpeaker, GraphValue, UiDocument, UiTheme } from '@thirdlight/project-model';

import { GraphEditor } from '../../graph/GraphEditor';
import type { GraphKindDef, GraphOp } from '../../graph/model';
import { usePreview } from '../preview/preview-request';
import type { PreviewAssetRef } from './preview-host';

export interface DialogueDocumentProps {
  dialogueId: string;
  dialogues: readonly DialogueDoc[];
  speakers: readonly DialogueSpeaker[];
  settings: DialogueSettings | null;
  uiDocuments: readonly UiDocument[];
  uiThemes: readonly UiTheme[];
  kinds: Readonly<Record<string, GraphKindDef>>;
  /** The facts of the assets a conversation names (kind, version, a clip's length), read by id. */
  assets: (assetIds: readonly string[]) => Promise<readonly PreviewAssetRef[]>;
  readAsset: (assetId: string, version: number) => Promise<Uint8Array>;
  /** This conversation and the ones it may jump to, read (the editor holds the ones it opened). */
  conversations: (dialogueId: string) => Promise<readonly DialogueDoc[]>;
  /** Sends `graphEdit` ops (queued; resolves with a refusal or null). */
  onEdit: (dialogueId: string, ops: GraphOp[]) => Promise<string | null>;
  /** One `setDialogue` (a rename). */
  onRename: (dialogueId: string, name: string) => void;
  onSelection: (ids: readonly string[]) => void;
  selection: readonly string[];
  focus: { id: string; nonce: number } | null;
  error: string | null;
}

export function DialogueDocument(p: DialogueDocumentProps): JSX.Element {
  const d = p.dialogues.find((x) => x.dialogueId === p.dialogueId) ?? null;
  const kind = p.kinds['dialogue'];
  // The previewer in the editor window's preview pane: this conversation over its scene.
  const { speakers, settings, uiDocuments, uiThemes, assets, readAsset, conversations, selection } = p;
  usePreview(
    useMemo(() => (d !== null ? { kind: 'dialogue' as const, dialogue: d, selection, source: { speakers, settings, uiDocuments, uiThemes, assets, readAsset, conversations } } : null), [d, selection, speakers, settings, uiDocuments, uiThemes, assets, readAsset, conversations]),
  );
  // Read by id when its tab opens (a conversation that is gone closes its tab).
  if (d === null) return <p className="tl-hint">Reading the conversation…</p>;
  if (kind === undefined) return <p className="tl-hint">Loading the dialogue node catalogue…</p>;
  const speakerIds = p.speakers.map((s) => s.speakerId);
  const newNodeData = (type: string): Record<string, GraphValue> | undefined => (type === 'line' && speakerIds.length > 0 ? { speaker: speakerIds[0]! } : undefined);
  const lines = d.graph.nodes.filter((n) => n.type === 'line').length;
  return (
    <div className="tl-animator-doc tl-dialogue-doc" aria-label="dialogue graph">
      <div className="tl-animator__bar">
        <input className="tl-input" aria-label="dialogue name" defaultValue={d.name} key={`${d.dialogueId}:${d.name}`} maxLength={64} onBlur={(e) => e.target.value.trim() !== '' && e.target.value.trim() !== d.name && p.onRename(d.dialogueId, e.target.value.trim())} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
        <span className="tl-hint">
          Dialogue · {lines} line{lines === 1 ? '' : 's'} · id {d.dialogueId}
        </span>
      </div>
      <p className="tl-hint tl-material-doc__note" role="note">
        Wire Start → Lines → Choices (options top to bottom) → … Line text is rich text: [b] [i] [color=#hex], {'{var}'} values, [pause=0.5]. Conditions and effects use the dialogue variables (Inspector).
      </p>
      {p.error !== null && (
        <p className="tl-error" role="alert">
          {p.error}
        </p>
      )}
      <div className="tl-animator-doc__main">
        <div className="tl-animator-doc__graph">
          <GraphEditor key={d.dialogueId} kind={kind} owner={{ kind: 'dialogue', id: d.dialogueId }} graph={d.graph} onEdit={(ops) => p.onEdit(d.dialogueId, ops)} onSelection={p.onSelection} focus={p.focus} newNodeData={newNodeData} />
        </div>
      </div>
    </div>
  );
}
