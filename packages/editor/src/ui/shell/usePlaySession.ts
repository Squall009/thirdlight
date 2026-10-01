/**
 * The editor's Play: the play session (started over HTTP, its snapshot over
 * WS), the isolated preview (a separate-origin iframe and the checked message
 * bridge), the backend's relays to the running game (screenshots,
 * diagnostics, input, control, observation) and the editor's own requests to
 * it (the Play debug view, the visual-script debugger, the Play label's
 * renderer and game mode, clearing the Play save).
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { BATCHING_URL_PARAM, batchingFromUrl, pageSearch, rendererPreferenceFromUrl, RENDERER_URL_PARAM } from '@thirdlight/three-adapter';
import type { readEditorConfig } from '../../config';
import type { SessionClient } from '../../session/client';
import { Bridge } from '../../preview/bridge';
import type { DebugRequest, DebugResult } from '../../preview/play-debug';
import type { GameplayBackendError } from '../GameplayPanel';
import { localRelayId } from './commands';

export interface PlayInfo {
  playSessionId: string;
  playBase: string | null;
  snapshot: unknown | null;
  snapshotId: string;
  revision: number;
  /** The immutable locator capability + build identity. */
  contentId: string | null;
  buildId: string | null;
  contentPath: string | null;
}

export function usePlaySession(
  cfg: MutableRefObject<ReturnType<typeof readEditorConfig>>,
  clientRef: MutableRefObject<SessionClient | null>,
  modesCount: number,
  setGameplayError: Dispatch<SetStateAction<GameplayBackendError | null>>,
  setNotice: Dispatch<SetStateAction<string | null>>,
) {
  /** The page's ?renderer= flag (it overrides the project setting everywhere, Play included). */
  const urlRenderer = useRef(rendererPreferenceFromUrl(pageSearch()));
  /** The page's ?threads= flag (where Play runs its simulation), passed on to the play page. */
  const urlThreads = useRef(/[?&]threads=([A-Za-z0-9]{1,16})(?:[&#]|$)/.exec(pageSearch())?.[1] ?? null);
  const [playRenderer, setPlayRenderer] = useState<Record<string, unknown> | null>(null);
  const bridgeRef = useRef<Bridge | null>(null);
  const playIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playInfo, setPlayInfo] = useState<PlayInfo | null>(null);
  /** Forwards a backend relay request to the running preview (latest play state). */
  const forwardRelayRef = useRef<(req: Record<string, unknown>) => void>(() => undefined);
  useEffect(() => {
    forwardRelayRef.current = (req) => {
      const b = bridgeRef.current;
      const client = clientRef.current;
      if (!client) return;
      const type = String(req.type);
      if (b === null || playInfo === null) {
        const error = { code: 'not_ready', message: 'no play preview is running in the editor' };
        if (type === 'input.request') client.sendRelayAck({ type: 'input.result', requestId: req.requestId, ok: false, error });
        else {
          const ackType = { 'screenshot.request': 'screenshot.ack', 'play.diagnostics.request': 'play.diagnostics.ack', 'game.control.request': 'game.control.ack', 'game.observe.request': 'game.observe.ack' }[type];
          if (ackType !== undefined) client.sendRelayAck({ type: ackType, relayId: req.relayId, ok: false, error });
        }
        return;
      }
      const psid = playInfo.playSessionId;
      if (type === 'screenshot.request') b.requestScreenshot(psid, String(req.relayId), typeof req.maxWidth === 'number' ? req.maxWidth : undefined);
      else if (type === 'play.diagnostics.request') b.requestDiagnostics(psid, String(req.relayId));
      else if (type === 'input.request') b.requestInput(psid, String(req.requestId), req.frames as never, req.restart === true, req.hold === true);
      else if (type === 'game.control.request') b.requestGameControl(psid, String(req.relayId), String(req.command), typeof req.sceneId === 'string' ? req.sceneId : undefined, typeof req.name === 'string' ? { name: req.name, args: (req.args ?? {}) as Record<string, unknown> } : undefined, typeof req.answerWithinMs === 'number' ? req.answerWithinMs : undefined);
      else if (type === 'game.observe.request') b.requestGameObserve(psid, String(req.relayId), typeof req.entityId === 'string' ? req.entityId : undefined);
    };
  }, [clientRef, playInfo]);

  /**
   * One observation of the running Play with `entityId`'s script
   * property values (the Play debug view) — over the preview bridge, answered
   * by the preview from the running game; null when nothing answers in 2 s.
   */
  const observeEntity = useCallback(
    (entityId: string): Promise<Record<string, unknown> | null> =>
      new Promise((resolve) => {
        const b = bridgeRef.current;
        if (b === null || playInfo === null) {
          resolve(null);
          return;
        }
        const relayId = localRelayId();
        debugWaitersRef.current.set(relayId, resolve);
        b.requestGameObserve(playInfo.playSessionId, relayId, entityId);
        window.setTimeout(() => {
          if (debugWaitersRef.current.delete(relayId)) resolve(null);
        }, 2000);
      }),
    [playInfo],
  );

  /**
   * One poll of the visual-script debugger in the running Play —
   * over the preview bridge, answered by the preview from the running game
   * (the editor runs no game code); null when nothing answers in 2 s.
   */
  const debugPlay = useCallback(
    (req: DebugRequest): Promise<DebugResult | null> =>
      new Promise((resolve) => {
        const b = bridgeRef.current;
        if (b === null || playInfo === null) {
          resolve(null);
          return;
        }
        const relayId = localRelayId();
        debugWaitersRef.current.set(relayId, (r) => resolve(r as unknown as DebugResult | null));
        b.requestDebug(playInfo.playSessionId, relayId, req);
        window.setTimeout(() => {
          if (debugWaitersRef.current.delete(relayId)) resolve(null);
        }, 2000);
      }),
    [playInfo],
  );

  // The play's renderer (backend, state, reason) for the Play label, from its
  // diagnostics (every play has them; the observation needs a game).
  const playDiagnostics = useCallback(
    (): Promise<Record<string, unknown> | null> =>
      new Promise((resolve) => {
        const b = bridgeRef.current;
        if (b === null || playInfo === null) {
          resolve(null);
          return;
        }
        const relayId = localRelayId();
        debugWaitersRef.current.set(relayId, resolve);
        b.requestDiagnostics(playInfo.playSessionId, relayId);
        window.setTimeout(() => {
          if (debugWaitersRef.current.delete(relayId)) resolve(null);
        }, 2000);
      }),
    [playInfo],
  );
  useEffect(() => {
    if (!playing || playInfo === null) {
      setPlayRenderer(null);
      return;
    }
    let alive = true;
    const tick = async (): Promise<void> => {
      const d = await playDiagnostics();
      const r = (d?.['renderer'] as { renderer?: unknown } | null | undefined)?.renderer;
      if (alive && typeof r === 'object' && r !== null && !Array.isArray(r)) setPlayRenderer(r as Record<string, unknown>);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [playing, playInfo, playDiagnostics]);
  /** The running Play's current game mode (the toolbar shows it; null: none or not playing). */
  const [playMode, setPlayMode] = useState<{ current: string; name: string } | null>(null);
  // The running Play's game mode for the toolbar (from its diagnostics; a project with modes).
  useEffect(() => {
    if (!playing || playInfo === null || modesCount === 0) {
      setPlayMode(null);
      return;
    }
    let alive = true;
    const tick = async (): Promise<void> => {
      const d = await playDiagnostics();
      const m = d?.['mode'] as { current?: unknown; name?: unknown } | undefined;
      if (alive && m !== undefined && typeof m.current === 'string') setPlayMode((p) => (p !== null && p.current === m.current ? p : { current: m.current as string, name: typeof m.name === 'string' ? m.name : '' }));
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 400);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [playing, playInfo, playDiagnostics, modesCount]);
  // The note of the editor's own Play control (clearing the Play save).
  const [playSaveNote, setPlaySaveNote] = useState<string | null>(null);
  const localRelaysRef = useRef(new Set<string>());
  /** The editor's own observation requests (the Play debug view), by relay id. */
  const debugWaitersRef = useRef(new Map<string, (r: Record<string, unknown> | null) => void>());
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
      if (playInfo.contentId !== null && playInfo.buildId !== null) {
        bridge.sendPlayContentExpect(playInfo.playSessionId, playInfo.contentId, playInfo.buildId);
      }
      bridge.sendSnapshot(playInfo.playSessionId, playInfo.snapshot);
    });
    bridge.on('tl.ready', (m) => {
      const r = m as { snapshotId?: string; revision?: number };
      setPlayInfo((p) => (p ? { ...p, snapshotId: r.snapshotId ?? p.snapshotId, revision: r.revision ?? p.revision } : p));
      // The editor presented the preview and
      // received its `tl.ready` → send the WS `play.preview.ready` exactly
      // once; the backend marks the play `presented`
      // (lifting the 15 s present-timeout).
      clientRef.current?.sendPlayPreviewReady(playInfo.playSessionId);
    });
    // Load progress keeps the backend's present timeout from firing while the preview still moves.
    bridge.on('tl.load.progress', () => {
      clientRef.current?.sendPlayPreviewProgress(playInfo.playSessionId);
    });
    bridge.on('tl.stopped', () => {
      setPlaying(false);
      setPlayInfo(null);
    });
    // The preview could not
    // start → relay it over WS (`play.preview.failed`);
    // the backend stops the play `preview_failed` (truthful + immediate, not
    // the 15 s present-timeout). The editor also surfaces the code locally.
    bridge.on('tl.error', (m) => {
      const r = m as { code?: string; message?: string; phase?: string };
      const failure = { code: r?.code ?? 'play_content_not_ready', message: r?.message ?? `preview failed${r?.phase ? ` (${r.phase})` : ''}` };
      setGameplayError(failure);
      setNotice(`Play failed: ${failure.message}`);
      void clientRef.current?.sendPlayPreviewFailed(playInfo.playSessionId, r?.code ?? 'play_content_not_ready', r?.message);
    });
    // Relay results: the preview's exact answer goes back to the backend.
    const ack = (frame: Record<string, unknown>): void => clientRef.current?.sendRelayAck(frame);
    const outcome = (r: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
      const out: Record<string, unknown> = { ok: r.ok };
      if (r.ok === true) for (const k of keys) if (r[k] !== undefined) out[k] = r[k];
      if (r.ok !== true) out.error = r.error;
      return out;
    };
    bridge.on('tl.screenshot.result', (m) => {
      const r = m as Record<string, unknown>;
      ack({ type: 'screenshot.ack', relayId: r.relayId, ...outcome(r, ['dataUrl', 'width', 'height']) });
    });
    bridge.on('tl.diagnostics.result', (m) => {
      const r = m as Record<string, unknown>;
      // The Play label's own diagnostics requests are not the backend's relays.
      const waiter = debugWaitersRef.current.get(String(r.relayId));
      if (waiter !== undefined) {
        debugWaitersRef.current.delete(String(r.relayId));
        waiter(r.ok === true && typeof r.diagnostics === 'object' && r.diagnostics !== null ? (r.diagnostics as Record<string, unknown>) : null);
        return;
      }
      ack({ type: 'play.diagnostics.ack', relayId: r.relayId, ...outcome(r, ['diagnostics']) });
    });
    bridge.on('tl.input.result', (m) => {
      const r = m as Record<string, unknown>;
      ack({ type: 'input.result', requestId: r.requestId, ...outcome(r, ['appliedFromStep', 'appliedToStep']) });
    });
    bridge.on('tl.game.control.result', (m) => {
      const r = m as Record<string, unknown>;
      // The editor's own requests (clear the Play save) are not the backend's relays.
      if (localRelaysRef.current.delete(String(r.relayId))) {
        setPlaySaveNote(r.ok === true ? 'The Play save was cleared (restart Play to start without it).' : 'Clearing the Play save failed.');
        return;
      }
      ack({ type: 'game.control.ack', relayId: r.relayId, ...outcome(r, ['result']) });
    });
    bridge.on('tl.game.observe.result', (m) => {
      const r = m as Record<string, unknown>;
      // The Play debug view's own observations are not the backend's relays.
      const waiter = debugWaitersRef.current.get(String(r.relayId));
      if (waiter !== undefined) {
        debugWaitersRef.current.delete(String(r.relayId));
        waiter(r.ok === true && typeof r.result === 'object' && r.result !== null ? (r.result as Record<string, unknown>) : null);
        return;
      }
      ack({ type: 'game.observe.ack', relayId: r.relayId, ...outcome(r, ['result']) });
    });
    // The visual-script debugger's polls (the editor's own; never a backend relay).
    bridge.on('tl.debug.result', (m) => {
      const r = m as Record<string, unknown>;
      const waiter = debugWaitersRef.current.get(String(r.relayId));
      if (waiter === undefined) return;
      debugWaitersRef.current.delete(String(r.relayId));
      waiter(r.ok === true && typeof r.result === 'object' && r.result !== null ? (r.result as Record<string, unknown>) : null);
    });

    const onLoad = (): void => {
      // The editor holds the retained play.started snapshot; on the
      // iframe load it runs the handshake, then sends the snapshot. The v2
      // handshake also carries the locator capability + build identity.
      bridge.beginHandshake(playInfo.playSessionId, false, playInfo.contentId ?? '', playInfo.buildId ?? '');
    };
    const onMsg = (ev: MessageEvent): void => {
      bridge.handleMessage({ origin: ev.origin, source: ev.source, data: ev.data });
    };
    iframe.addEventListener('load', onLoad);
    window.addEventListener('message', onMsg);
    // The preview may finish loading before this listener exists (the load
    // event is then missed): keep offering the handshake until it is acked.
    const retry = window.setInterval(() => {
      if (snapshotSent) window.clearInterval(retry);
      else onLoad();
    }, 300);
    return () => {
      window.clearInterval(retry);
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', onMsg);
      bridgeRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the play bridge restarts only when the play session's identity changes
  }, [playing, playInfo?.playSessionId, playInfo?.playBase, playInfo?.snapshot, playInfo?.contentId, playInfo?.buildId]);
  const play = useCallback(async (start?: Parameters<SessionClient['playStart']>[1]) => {
    const c = clientRef.current;
    if (!c) return;
    // A refused start (missing files, a script that does not compile) says why; the Problems log keeps it.
    const r = await c.playStart(false, start).catch((e: unknown) => void setNotice(`Play refused: ${c.describeError(e).message}`));
    if (r === undefined) return;
    // The snapshot arrives via the retained play.started WS event; the iframe
    // is created once both playBase (HTTP) and snapshot (WS) are present.
    setPlayInfo((p) => ({
      playSessionId: r.playSessionId,
      playBase: r.playBase,
      snapshot: p?.snapshot ?? null,
      snapshotId: r.snapshotId,
      revision: r.revision,
      contentId: r.playContent?.contentId ?? null,
      buildId: r.playContent?.buildId ?? null,
      contentPath: r.playContent?.path ?? null,
    }));
  }, [clientRef, setNotice]);
  const stop = useCallback(async () => {
    const c = clientRef.current;
    const b = bridgeRef.current;
    if (!c || !playInfo) return;
    b?.requestStop(playInfo.playSessionId);
    await c.playStop(playInfo.playSessionId);
  }, [clientRef, playInfo]);
  // The play loads from its own content locator on the preview origin.
  // The editor page's ?renderer= flag is passed on to the play page (and ?batching=off; and ?threads=).
  const previewSrc =
    playInfo?.playBase && playInfo.contentId !== null && playInfo.contentPath !== null
      ? `${playInfo.playBase.replace(/\/$/, '')}${playInfo.contentPath}?play=${playInfo.playSessionId}&content=${playInfo.contentId}${urlRenderer.current !== null ? `&${RENDERER_URL_PARAM}=${urlRenderer.current}` : ''}${batchingFromUrl(pageSearch()) ? '' : `&${BATCHING_URL_PARAM}=off`}${urlThreads.current !== null ? `&threads=${urlThreads.current}` : ''}`
      : null;
  /** Clears the running Play's save (the Saves panel), or null when nothing is running. */
  const clearPlaySave =
    playInfo !== null && bridgeRef.current !== null
      ? () => {
          const relayId = localRelayId();
          localRelaysRef.current.add(relayId);
          bridgeRef.current?.requestGameControl(playInfo.playSessionId, relayId, 'clearSave');
        }
      : null;

  return {
    playing, setPlaying, playInfo, setPlayInfo, bridgeRef, playIframeRef, forwardRelayRef, playRenderer, playMode, playSaveNote,
    observeEntity, debugPlay, play, stop, previewSrc, clearPlaySave,
  };
}

export type PlaySession = ReturnType<typeof usePlaySession>;
