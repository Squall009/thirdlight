/**
 * The preview pane's subjects shown on their scene: a timeline at its
 * playhead, a conversation played by the game's dialogue UI, a UI document at
 * a resolution. The scene is the Scene view itself — its canvas moves into
 * the pane while one of these is in front and goes back when it leaves — so
 * the scene is never drawn by a second renderer or copied; what the item adds
 * lies over it (the dialogue UI, the UI document) or is applied to it by its
 * editor (a timeline's playhead). The pane's scene is for looking: pointer
 * input does not reach the Scene view through it.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import { mountDialoguePreview, type DialoguePreviewHost } from '../dialogue/preview-host';
import { UiDocumentView } from '../uidoc/ui-layer-view';
import type { PreviewControlsProps, PreviewDeps } from './use-subject';

/** How often the dialogue previewer's observation line is refreshed (ms). */
const OBSERVE_INTERVAL_MS = 200;

/** The Scene view's canvas in the pane, with what lies over it. */
function SceneSurface({ deps, children }: { deps: PreviewDeps; children?: ReactNode }): JSX.Element {
  const canvasHost = useRef<HTMLDivElement | null>(null);
  const latest = useRef(deps);
  latest.current = deps;
  useEffect(() => {
    const el = canvasHost.current;
    if (el === null) return undefined;
    const release = latest.current.sceneView.borrow(el);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => latest.current.sceneView.resize()) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      release();
    };
  }, []);
  return (
    <div className="tl-preview__scene" aria-label="preview scene">
      {/* Empty for React: the Scene view's canvas is put here (and taken back) by the editor. */}
      <div className="tl-preview__scene-canvas" ref={canvasHost} />
      {children}
    </div>
  );
}

export function TimelinePreview({ deps }: PreviewControlsProps<'timeline'>): JSX.Element {
  return (
    <>
      <SceneSurface deps={deps} />
      <p className="tl-hint">The scene at the playhead: scrub or play the timeline. Sound, effects, signals and dialogue play in Play only.</p>
    </>
  );
}

export function UiDocumentPreview({ request, deps }: PreviewControlsProps<'ui'>): JSX.Element {
  return (
    <>
      <SceneSurface deps={deps}>
        <UiDocumentView label="UI document preview" doc={request.doc} themes={request.themes} mock={request.mock} size={request.size} assets={request.assets} />
      </SceneSurface>
      <p className="tl-hint">
        {request.size.w}×{request.size.h} over the scene, with the mock values (the resolution is chosen in the editor).
      </p>
    </>
  );
}

/**
 * The dialogue previewer: plays the conversation outside Play with the game's
 * own dialogue UI and audio (portraits, typewriter, voice on the voice bus
 * with music/SFX ducked, auto-advance, choices, backlog) over the scene —
 * from the start, an entry or the selected node, with starting variables.
 */
export function DialoguePreview({ request, deps }: PreviewControlsProps<'dialogue'>): JSX.Element {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<DialoguePreviewHost | null>(null);
  const [status, setStatus] = useState<string>('Not playing');
  const [from, setFrom] = useState<string>('start');
  const [vars, setVars] = useState('');
  const [sound, setSound] = useState(true);
  const [obs, setObs] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const d = request.dialogue;
  const src = request.source;
  const entries = d.graph.nodes.filter((n) => n.type === 'entry').map((n) => String(n.data?.['name'] ?? 'entry'));
  const selectedNode = request.selection.length === 1 ? d.graph.nodes.find((n) => n.id === request.selection[0]) : undefined;

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
      // How many sound files the preview has read (the voices ahead, not the project's; tests read it).
      stageRef.current?.setAttribute('data-sounds-read', String(o.soundsRead));
      if (!o.running) setStatus('Ended');
    }, OBSERVE_INTERVAL_MS);
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
      const dialogues = await src.conversations(d.dialogueId);
      const host = await mountDialoguePreview({ container: stage, dialogues, speakers: src.speakers, settings: src.settings, documents: src.uiDocuments, themes: src.uiThemes, assets: src.assets, readAsset: src.readAsset, sound });
      hostRef.current = host;
      const opts = from === 'start' ? {} : from === 'selected' && selectedNode !== undefined ? { node: selectedNode.id } : from.startsWith('entry:') ? { entry: from.slice(6) } : {};
      // The first lines' voices are read before it starts; the rest as it goes (as in Play).
      await host.prepare(d.dialogueId, opts);
      const ok = host.start(d.dialogueId, { ...opts, ...(variables !== undefined ? { variables } : {}) });
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
      <SceneSurface deps={deps}>
        <div
          ref={stageRef}
          className="tl-dialogue-preview__stage"
          tabIndex={0}
          aria-label="dialogue preview stage"
          onKeyDown={(e) => {
            if (hostRef.current?.key(e.key) === true) e.preventDefault();
          }}
        />
      </SceneSurface>
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
      <p className="tl-hint" role="status" aria-label="dialogue preview status" data-status={status}>
        {status}
        {line !== null && line['running'] === true ? ` · ${String(line['kind'])} ${String(line['node'])}${typeof line['revealed'] === 'number' ? ` · ${String(line['revealed'])}/${String(line['total'])}` : ''}${line['voice'] === true ? ' · voice' : ''} · backlog ${String(line['backlog'])}` : ''}
      </p>
    </div>
  );
}
