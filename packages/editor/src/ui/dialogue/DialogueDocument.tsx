/**
 * Phase 23.16: the "Dialogue: <name>" centre tab — one conversation's node
 * graph (graph kind `dialogue` on the phase 16 framework) and a previewer.
 *
 * - The graph: every gesture is one `graphEdit` on owner kind `dialogue`
 *   (owner id = the dialogueId); the selected node shows in the right dock's
 *   Inspector (speaker, expression, text, voice clip, auto-advance, a
 *   condition, effects…). Start is fixed; wires say what comes next.
 * - The previewer (right column): plays the conversation outside Play with
 *   the game's own dialogue UI and audio (portraits, typewriter, voice on
 *   the voice bus with music/SFX ducked, auto-advance, choices, backlog) —
 *   from the start, an entry or the selected node, with starting variables.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { DialogueDocument as DialogueDoc, DialogueSettings, DialogueSpeaker, GraphValue, UiDocument, UiTheme } from '@thirdlight/project-model';

import { GraphEditor } from '../../graph/GraphEditor';
import type { GraphKindDef, GraphOp } from '../../graph/model';
import { mountDialoguePreview, type DialoguePreviewHost, type PreviewAssetRef } from './preview-host';

export interface DialogueDocumentProps {
  dialogueId: string;
  dialogues: readonly DialogueDoc[];
  speakers: readonly DialogueSpeaker[];
  settings: DialogueSettings | null;
  uiDocuments: readonly UiDocument[];
  uiThemes: readonly UiTheme[];
  kinds: Readonly<Record<string, GraphKindDef>>;
  assets: readonly PreviewAssetRef[];
  readAsset: (assetId: string, version: number) => Promise<Uint8Array>;
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
  if (d === null) return <p className="tl-hint">This conversation no longer exists (deleted or undone). Close the tab, or undo the deletion.</p>;
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
        <div className="tl-animator-doc__preview tl-animator-doc__preview--right tl-dialogue-doc__preview">
          <DialoguePreviewPane {...p} dialogue={d} />
        </div>
      </div>
    </div>
  );
}

/** The previewer: the game's dialogue UI and audio in a box, driven by the runtime's runner. */
function DialoguePreviewPane(p: DialogueDocumentProps & { dialogue: DialogueDoc }): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<DialoguePreviewHost | null>(null);
  const [status, setStatus] = useState<string>('Not playing');
  const [from, setFrom] = useState<string>('start');
  const [vars, setVars] = useState('');
  const [sound, setSound] = useState(true);
  const [obs, setObs] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const entries = p.dialogue.graph.nodes.filter((n) => n.type === 'entry').map((n) => String(n.data?.['name'] ?? 'entry'));
  const selectedNode = p.selection.length === 1 ? p.dialogue.graph.nodes.find((n) => n.id === p.selection[0]) : undefined;

  useEffect(
    () => () => {
      hostRef.current?.dispose();
      hostRef.current = null;
    },
    [],
  );
  // The observation line (reveal, voice, backlog) while it plays.
  useEffect(() => {
    const t = setInterval(() => {
      const h = hostRef.current;
      if (h === null) return;
      const o = h.observe();
      setObs(o.dialogue);
      if (!o.running) setStatus('Ended');
    }, 200);
    return () => clearInterval(t);
  }, []);

  const play = async (): Promise<void> => {
    const stage = stageRef.current;
    if (stage === null || busy) return;
    let variables: Record<string, number | string | boolean | null> | undefined;
    if (vars.trim() !== '') {
      try {
        const v = JSON.parse(vars) as unknown;
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('variables are a JSON object');
        variables = v as Record<string, number | string | boolean | null>;
      } catch (e) {
        setStatus(`Variables: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
    }
    setBusy(true);
    hostRef.current?.dispose();
    hostRef.current = null;
    stage.textContent = '';
    try {
      const host = await mountDialoguePreview({ container: stage, dialogues: p.dialogues, speakers: p.speakers, settings: p.settings, documents: p.uiDocuments, themes: p.uiThemes, assets: p.assets, readAsset: p.readAsset, sound });
      hostRef.current = host;
      const opts = from === 'start' ? {} : from === 'selected' && selectedNode !== undefined ? { node: selectedNode.id } : from.startsWith('entry:') ? { entry: from.slice(6) } : {};
      const ok = host.start(p.dialogue.dialogueId, { ...opts, ...(variables !== undefined ? { variables } : {}) });
      setStatus(ok ? 'Playing' : 'Could not start (an empty conversation, or the node is gone)');
      stage.focus();
    } catch (e) {
      setStatus(`Preview failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const stop = (): void => {
    hostRef.current?.stop();
    setStatus('Stopped');
  };

  const line = obs !== null && typeof obs === 'object' ? obs : null;
  return (
    <div className="tl-dialogue-preview" aria-label="dialogue preview">
      <div className="tl-subhead">Preview</div>
      <div className="tl-dialogue-preview__bar">
        <select className="tl-input" aria-label="preview from" value={from} onChange={(e) => setFrom(e.target.value)}>
          <option value="start">From Start</option>
          {entries.map((e) => (
            <option key={e} value={`entry:${e}`}>
              From entry “{e}”
            </option>
          ))}
          <option value="selected" disabled={selectedNode === undefined}>
            From the selected node
          </option>
        </select>
        <label className="tl-check">
          <input type="checkbox" aria-label="preview sound" checked={sound} onChange={(e) => setSound(e.target.checked)} /> Sound
        </label>
        <button type="button" className="tl-btn tl-btn--small" aria-label="play dialogue preview" onClick={() => void play()} disabled={busy}>
          ▶ Play
        </button>
        <button type="button" className="tl-btn tl-btn--small" aria-label="stop dialogue preview" onClick={stop}>
          ■ Stop
        </button>
      </div>
      <input className="tl-input" aria-label="preview variables" placeholder='Starting variables, e.g. {"met": true}' value={vars} onChange={(e) => setVars(e.target.value)} />
      <div
        ref={stageRef}
        className="tl-dialogue-preview__stage"
        tabIndex={0}
        aria-label="dialogue preview stage"
        style={{ position: 'relative', width: '100%', aspectRatio: '16 / 9', overflow: 'hidden', background: '#1b1f2a', outline: 'none' }}
        onKeyDown={(e) => {
          if (hostRef.current?.key(e.key) === true) e.preventDefault();
        }}
      />
      <p className="tl-hint" role="status" aria-label="dialogue preview status" data-status={status}>
        {status}
        {line !== null && line['running'] === true ? ` · ${String(line['kind'])} ${String(line['node'])}${typeof line['revealed'] === 'number' ? ` · ${String(line['revealed'])}/${String(line['total'])}` : ''}${line['voice'] === true ? ' · voice' : ''} · backlog ${String(line['backlog'])}` : ''}
      </p>
    </div>
  );
}
