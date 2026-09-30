/**
 * The Assets tab's preview of one asset: an isolated stage on the side
 * panel's canvas where the selected model's current version is realized and
 * its clips played, paused and scrubbed. The host owns the frame loop while a
 * clip plays (the controller installs none).
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import type { SessionClient } from '../../session/client';
import type { AssetPreviewSession, ModelInstances } from '../../viewport/model-instances';
import { PreviewStage } from '../../viewport/preview-stage';
import type { AssetPreviewView } from '../AssetBrowser';

export interface AssetPreview {
  readonly view: AssetPreviewView | null;
  /** Mounts/unmounts the preview canvas (the side panel mounts a new one each time). */
  readonly canvasRef: (canvas: HTMLCanvasElement | null) => void;
  load(assetId: string): Promise<void>;
  play(): void;
  pause(): void;
  scrub(seconds: number): void;
  /** Forget the session (the Scene view that realized it is going). */
  forget(): void;
}

export function useAssetPreview(deps: {
  clientRef: RefObject<SessionClient | null>;
  modelInstancesRef: RefObject<ModelInstances | null>;
  selectedAssetId: string | null;
  onFailure: (error: { code: string; message: string }) => void;
}): AssetPreview {
  const { clientRef, modelInstancesRef } = deps;
  const [view, setView] = useState<AssetPreviewView | null>(null);
  const sessionRef = useRef<AssetPreviewSession | null>(null);
  const stageRef = useRef<PreviewStage | null>(null);
  const failRef = useRef(deps.onFailure);
  failRef.current = deps.onFailure;

  const canvasRef = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      // The asset browser mounts a new canvas each time: the old one's context goes with it.
      stageRef.current?.dispose(true);
      stageRef.current = null;
      if (canvas === null) {
        modelInstancesRef.current?.clearPreview();
        sessionRef.current = null;
        setView(null);
        return;
      }
      stageRef.current = new PreviewStage(canvas);
    },
    [modelInstancesRef],
  );

  // Another asset chosen: the preview of the last one goes.
  useEffect(() => {
    setView(null);
  }, [deps.selectedAssetId]);

  const load = useCallback(
    async (assetId: string) => {
      const c = clientRef.current;
      const m = modelInstancesRef.current;
      if (!c || !m) return;
      const v = c.content.resolveVersion(assetId);
      if (!v || !/^[0-9a-f]{64}$/.test(v.sourceDigest)) {
        failRef.current({ code: 'asset_not_found', message: `no immutable version facts for ${assetId}` });
        return;
      }
      const stage = stageRef.current;
      const res = await m.previewAsset({ assetId, version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength }, stage?.scene);
      if (!res.ok) {
        failRef.current({ code: res.code, message: res.message });
        return;
      }
      stage?.frame(res.session.root);
      sessionRef.current = res.session;
      setView({ assetId, clips: res.session.clips, clipIndex: null, playing: false, timeSeconds: 0, durationSeconds: 0 });
    },
    [clientRef, modelInstancesRef],
  );

  const publish = useCallback(() => {
    const s = sessionRef.current?.controller.state();
    if (!s) return;
    setView((p) => (p ? { ...p, playing: s.playing, clipIndex: s.clipIndex, timeSeconds: s.timeSeconds, durationSeconds: s.durationSeconds } : p));
  }, []);
  const play = useCallback(() => {
    sessionRef.current?.controller.play();
    publish();
  }, [publish]);
  const pause = useCallback(() => {
    sessionRef.current?.controller.pause();
    publish();
  }, [publish]);
  const scrub = useCallback(
    (seconds: number) => {
      sessionRef.current?.controller.scrub(seconds);
      publish();
    },
    [publish],
  );
  const forget = useCallback(() => {
    sessionRef.current = null;
  }, []);

  useEffect(() => {
    if (!view?.playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      modelInstancesRef.current?.updatePreview(dt);
      publish();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [view?.playing, publish, modelInstancesRef]);

  return { view, canvasRef, load, play, pause, scrub, forget };
}
