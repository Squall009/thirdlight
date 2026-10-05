/**
 * The preview of one asset in its Inspector: the preview renderer (the one
 * path the editor window's preview pane draws with) on the Inspector's canvas,
 * where the selected model's current version is realized and its clips
 * played, paused and scrubbed. The host owns the clip clock while a clip
 * plays (the controller installs none).
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { previewFrameSeconds } from '@thirdlight/runtime';

import type { SessionClient } from '../../session/client';
import type { AssetPreviewSession, ModelFiles } from '../../viewport/model-files';
import { PreviewRenderer } from '../../viewport/preview-renderer';
import { ModelSubject } from '../../viewport/preview-subjects';

/** What the preview shows: the model, its clips, the clip playing and where. */
export interface AssetPreviewView {
  assetId: string;
  clips: readonly { index: number; name: string; durationSeconds: number }[];
  clipIndex: number | null;
  playing: boolean;
  timeSeconds: number;
  durationSeconds: number;
}

export interface AssetPreview {
  readonly view: AssetPreviewView | null;
  /** Mounts/unmounts the preview canvas (the Inspector mounts a new one each time). */
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
  modelFilesRef: RefObject<ModelFiles | null>;
  selectedAssetId: string | null;
  onFailure: (error: { code: string; message: string }) => void;
}): AssetPreview {
  const { clientRef, modelFilesRef } = deps;
  const [view, setView] = useState<AssetPreviewView | null>(null);
  const sessionRef = useRef<AssetPreviewSession | null>(null);
  const stageRef = useRef<PreviewRenderer | null>(null);
  const failRef = useRef(deps.onFailure);
  failRef.current = deps.onFailure;

  const canvasRef = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      // The Inspector mounts a new canvas each time: the old one's renderer and context go with it.
      stageRef.current?.dispose();
      stageRef.current = null;
      if (canvas === null) {
        modelFilesRef.current?.clearPreview();
        sessionRef.current = null;
        setView(null);
        return;
      }
      // A model's own materials and textures: the stage needs no texture assets of its own.
      stageRef.current = new PreviewRenderer(canvas, { loadTexture: () => Promise.resolve(null) });
    },
    [modelFilesRef],
  );

  // Another asset chosen: the preview of the last one goes.
  useEffect(() => {
    setView(null);
  }, [deps.selectedAssetId]);

  const load = useCallback(
    async (assetId: string) => {
      const c = clientRef.current;
      const m = modelFilesRef.current;
      if (!c || !m) return;
      const v = c.content.resolveVersion(assetId);
      if (!v || !/^[0-9a-f]{64}$/.test(v.sourceDigest)) {
        failRef.current({ code: 'asset_not_found', message: `no immutable version facts for ${assetId}` });
        return;
      }
      const stage = stageRef.current;
      if (stage === null) return;
      const descriptor = { assetId, version: v.version, sourceDigest: v.sourceDigest, sourceByteLength: v.sourceByteLength };
      const res = await new Promise<Awaited<ReturnType<typeof m.previewAsset>>>((resolve) => {
        stage.show(
          new ModelSubject(`asset:${assetId}`, async (parent) => {
            const r = await m.previewAsset(descriptor, parent);
            resolve(r);
            if (!r.ok) return r.message;
            // A later preview (the Animator's) already released this session when it replaced it.
            return { root: r.session.root, dispose: () => (m.previewSession() === r.session ? m.clearPreview() : undefined) };
          }),
        );
      });
      if (!res.ok) {
        failRef.current({ code: res.code, message: res.message });
        return;
      }
      sessionRef.current = res.session;
      setView({ assetId, clips: res.session.clips, clipIndex: null, playing: false, timeSeconds: 0, durationSeconds: 0 });
    },
    [clientRef, modelFilesRef],
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
      const dt = previewFrameSeconds(now, last);
      last = now;
      modelFilesRef.current?.updatePreview(dt);
      publish();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [view?.playing, publish, modelFilesRef]);

  return { view, canvasRef, load, play, pause, scrub, forget };
}
