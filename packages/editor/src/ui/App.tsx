/**
 * Editor app root (React, decision 0001 §10). Wires the session client
 * (backend transport), the imperative three.js viewport (framework-free), the
 * React panels, and the isolated play preview (separate-origin iframe + the
 * checked §13.5 bridge). React renders the panels + the canvas element; it
 * never instantiates or mutates Object3Ds (the viewport owns those).
 *
 * Browser-only.
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { readEditorConfig } from '../config';
import { SessionClient, type ClientUiState, type PlayStartResult } from '../session/client';
import { Projection, type ProjectedEntity } from '../session/projection';
import { Gesture, type Transform } from '../session/gesture';
import { Viewport } from '../viewport/viewport';
import { Bridge } from '../preview/bridge';
import { Hierarchy } from './Hierarchy';
import { Inspector } from './Inspector';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import type { GizmoMode } from '../viewport/gizmo';

interface PlayInfo {
  playSessionId: string;
  playBase: string | null;
  snapshot: unknown | null;
  snapshotId: string;
  revision: number;
}

function EditorApp(): JSX.Element {
  const cfg = useRef(readEditorConfig());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<SessionClient | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const gestureBaseTransform = useRef<Transform | null>(null);
  const bridgeRef = useRef<Bridge | null>(null);
  const playIframeRef = useRef<HTMLIFrameElement | null>(null);

  const [configError, setConfigError] = useState<string | null>(cfg.current.ok ? null : cfg.current.message);
  const [entities, setEntities] = useState<ProjectedEntity[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ui, setUi] = useState<ClientUiState>({ connection: 'idle', save: 'idle', error: null, conflict: null, revision: 0 });
  const [gizmoMode, setGizmoMode] = useState<GizmoMode>('translate');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [playInfo, setPlayInfo] = useState<PlayInfo | null>(null);

  const refreshEntities = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    setEntities([...c.projection.listEntities()]);
    setUi((s) => ({ ...s, revision: c.projection.revision }));
  }, []);

  // ---- mount: create the client + viewport, connect -----------------------
  useEffect(() => {
    if (!cfg.current.ok) return;
    const config = cfg.current.config;
    const client = new SessionClient(config, {
      onState: (s) => setUi(s),
      onSceneChanged: () => refreshEntities(),
      onPlayStarted: (r: PlayStartResult & { snapshot: unknown }) => {
        setPlaying(true);
        setPlayInfo((p) => ({
          playSessionId: r.playSessionId,
          playBase: r.playBase,
          snapshot: r.snapshot,
          snapshotId: r.snapshotId,
          revision: r.revision,
        }));
      },
      onPlayStopped: () => {
        setPlaying(false);
        setPlayInfo(null);
        bridgeRef.current = null;
      },
    });
    clientRef.current = client;

    const canvas = canvasRef.current!;
    const viewport = new Viewport(canvas, {
      onPick: (id) => {
        setSelectedId(id);
        viewport.setSelected(id, gizmoMode);
      },
      onGestureBegin: (id) => {
        const base = client.entityTransform(id);
        gestureBaseTransform.current = base ? { position: [...base.position], rotation: [...base.rotation], scale: [...base.scale] } : null;
        gestureRef.current = base ? new Gesture(id, client.projection.revision, base) : null;
      },
      onGestureFrame: () => {
        // The viewport already moved the Object3D (local preview, no traffic).
        // Refresh the inspector readout from the live mesh transform.
        const id = selectedIdRef.current;
        if (id) {
          const t = client.entityTransform(id);
          if (t) setEntities((prev) => prev.map((e) => (e.id === id ? { ...e, position: t.position, rotation: t.rotation, scale: t.scale } : e)));
        }
      },
      onGestureEnd: async (id, transform) => {
        const g = gestureRef.current;
        const base = gestureBaseTransform.current;
        if (!g || !base) return;
        g.setLocal(transform);
        const outcome = g.decideCommit();
        if (outcome.kind !== 'commit') {
          gestureRef.current = null;
          return;
        }
        const res = await client.command('setTransform', { entityId: id, transform: outcome.command.args.transform }, outcome.command.expectedRevision);
        if (res.ok) {
          gestureRef.current = null;
          return;
        }
        if (res.response.ok === false && res.response.code === 'revision_conflict') {
          // Bounded auto-rebase (≤ 1) via the gesture; if it still conflicts,
          // the conflict is surfaced in the status bar (explained, not lost).
          const retried = g.handleResult(
            { ok: false, code: 'revision_conflict', currentRevision: res.response.currentRevision ?? 0 },
            () => client.entityTransform(id) ?? base,
          );
          if (retried.kind === 'commit') {
            await client.command('setTransform', { entityId: id, transform: retried.command.args.transform }, retried.command.expectedRevision);
          }
          gestureRef.current = null;
        }
      },
    });
    viewportRef.current = viewport;
    viewport.resize();
    void client.connect();
    refreshEntities();

    const onResize = (): void => viewport.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      client.dispose();
      viewport.dispose();
      clientRef.current = null;
      viewportRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A ref mirror of selectedId for the viewport callbacks (stable closure).
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  // Selection → gizmo.
  useEffect(() => {
    viewportRef.current?.setSelected(selectedId, gizmoMode);
  }, [selectedId, gizmoMode]);

  // ---- the isolated play preview (separate-origin iframe + bridge) --------
  useEffect(() => {
    if (!playInfo || !playInfo.playBase || playInfo.snapshot === null || !playing) return;
    const config = cfg.current;
    if (!config.ok) return;
    const iframe = playIframeRef.current;
    if (!iframe) return;
    const previewOrigin = config.config.previewOrigin;
    const bridge = new Bridge({
      direction: 'editor',
      expectedOrigin: previewOrigin,
      targetOrigin: previewOrigin,
      post: (data, target) => iframe.contentWindow?.postMessage(data, target),
      isTrustedSource: (s) => s === iframe.contentWindow,
    });
    bridgeRef.current = bridge;

    let snapshotSent = false;
    bridge.on('tl.handshake.ack', () => {
      if (snapshotSent) return;
      snapshotSent = true;
      bridge.sendSnapshot(playInfo.playSessionId, playInfo.snapshot);
    });
    bridge.on('tl.ready', (m) => {
      const r = m as { snapshotId?: string; revision?: number };
      setPlayInfo((p) => (p ? { ...p, snapshotId: r.snapshotId ?? p.snapshotId, revision: r.revision ?? p.revision } : p));
    });
    bridge.on('tl.stopped', () => {
      setPlaying(false);
      setPlayInfo(null);
    });
    bridge.on('tl.screenshot.result', () => {
      /* handled by the MCP/backend relay path; the editor only relays */
    });

    const onLoad = (): void => {
      // §13.4: the editor holds the retained play.started snapshot; on the
      // iframe load it runs the handshake, then sends the snapshot.
      bridge.beginHandshake(playInfo.playSessionId, false);
    };
    const onMsg = (ev: MessageEvent): void => {
      bridge.handleMessage({ origin: ev.origin, source: ev.source, data: ev.data });
    };
    iframe.addEventListener('load', onLoad);
    window.addEventListener('message', onMsg);
    return () => {
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', onMsg);
      bridgeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, playInfo?.playSessionId, playInfo?.playBase, playInfo?.snapshot]);

  // ---- toolbar actions (all delegated to the backend) ---------------------
  const newBox = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('createEntity', { kind: 'box', parentId: null, name: `box-${Date.now() % 10000}` }, c.projection.revision);
    if (res.ok) setCanUndo(true);
  }, []);
  const del = useCallback(async () => {
    const c = clientRef.current;
    if (!c || !selectedIdRef.current) return;
    const res = await c.command('deleteEntity', { entityId: selectedIdRef.current }, c.projection.revision);
    if (res.ok) {
      setSelectedId(null);
      setCanUndo(true);
    }
  }, []);
  const undo = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('undo', {}, c.projection.revision);
    if (res.ok) {
      setCanUndo(false);
      setCanRedo(true);
    }
  }, []);
  const redo = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const res = await c.command('redo', {}, c.projection.revision);
    if (res.ok) {
      setCanRedo(false);
      setCanUndo(true);
    }
  }, []);
  const play = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const r = await c.playStart(false);
    // The snapshot arrives via the retained play.started WS event; the iframe
    // is created once both playBase (HTTP) and snapshot (WS) are present.
    setPlayInfo((p) => ({ playSessionId: r.playSessionId, playBase: r.playBase, snapshot: p?.snapshot ?? null, snapshotId: r.snapshotId, revision: r.revision }));
  }, []);
  const stop = useCallback(async () => {
    const c = clientRef.current;
    const b = bridgeRef.current;
    if (!c || !playInfo) return;
    b?.requestStop(playInfo.playSessionId);
    await c.playStop(playInfo.playSessionId);
  }, [playInfo]);

  const resync = useCallback(() => {
    const c = clientRef.current;
    if (!c) return;
    void c.fullResync().then(() => refreshEntities());
  }, [refreshEntities]);

  if (configError) {
    return (
      <div className="tl-config-error">
        <h1>Thirdlight editor</h1>
        <p>Could not start:</p>
        <pre>{configError}</pre>
      </div>
    );
  }

  const selected = entities.find((e) => e.id === selectedId) ?? null;
  const previewSrc = playInfo?.playBase ? `${playInfo.playBase}/?play=${playInfo.playSessionId}` : null;

  return (
    <div className="tl-app">
      <Toolbar
        canUndo={canUndo}
        canRedo={canRedo}
        selectedId={selectedId}
        playing={playing}
        onNewBox={() => void newBox()}
        onDelete={() => void del()}
        onUndo={() => void undo()}
        onRedo={() => void redo()}
        onPlay={() => void play()}
        onStop={() => void stop()}
      />
      <div className="tl-app__body">
        <Hierarchy entities={entities} selectedId={selectedId} onSelect={setSelectedId} />
        <div className="tl-app__stage">
          <canvas ref={canvasRef} className="tl-viewport" />
          {playing && previewSrc && (
            <div className="tl-app__preview">
              <div className="tl-app__preview-label">
                play {playInfo?.snapshotId ?? ''} @ r{playInfo?.revision ?? 0}
              </div>
              <iframe
                ref={playIframeRef}
                className="tl-app__preview-frame"
                src={previewSrc}
                title="Thirdlight play preview"
              />
            </div>
          )}
        </div>
        <Inspector entity={selected} gizmoMode={gizmoMode} onGizmoMode={setGizmoMode} />
      </div>
      <StatusBar state={ui} onResync={resync} />
    </div>
  );
}

export function mountEditor(): void {
  const el = document.getElementById('tl-root');
  if (!el) throw new Error('editor root element #tl-root not found');
  createRoot(el).render(<EditorApp />);
}