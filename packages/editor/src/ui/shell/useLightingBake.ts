/**
 * The Lighting window's bake of the active scene: "Bake lighting" running
 * with its progress and outcome, and clearing a bake. The same run answers
 * an agent's request through the backend (`lighting.bake.request`).
 */
import { useCallback, useRef, useState } from 'react';
import type { SceneHeaderView } from '../Hierarchy';
import { lightingBakeSummary, runLightingBake } from '../../viewport/lighting-bake-run';
import { refusal, type ClientRef, type ViewportRef } from './commands';

/** Why this view cannot bake lighting (null: it can). */
export function lightingBakeUnavailable(api: string | null): string | null {
  return api === 'webgpu' ? null : 'baking lighting needs WebGPU; the Scene view draws with WebGL 2 (saved lighting still draws)';
}

/** `sceneApi`: the Scene view's graphics API (lighting bakes on WebGPU only). */
export function useLightingBake(clientRef: ClientRef, viewportRef: ViewportRef, activeScene: SceneHeaderView | null, sceneApi: string | null) {
  const [bakeBusy, setBakeBusy] = useState<{ text: string; fraction: number } | null>(null);
  const [bakeMessage, setBakeMessage] = useState<string | null>(null);
  const bakeAbortRef = useRef<AbortController | null>(null);
  const lightingUnavailable = lightingBakeUnavailable(sceneApi);
  /** "Bake lighting" of the active scene (the button, and an agent's request through the backend): the outcome in words. */
  const bakeLighting = useCallback(async (): Promise<{ ok: true; message: string } | { ok: false; message: string }> => {
    const c = clientRef.current;
    const v = viewportRef.current;
    if (!c || !v || activeScene === null) return { ok: false, message: 'the editor has no scene open' };
    const abort = new AbortController();
    bakeAbortRef.current = abort;
    setBakeMessage(null);
    setBakeBusy({ text: 'preparing…', fraction: 0 });
    const r = await runLightingBake({ client: c, viewport: v, sceneId: activeScene.sceneId, sceneName: activeScene.name, onProgress: (text, fraction) => setBakeBusy({ text, fraction }), signal: abort.signal });
    bakeAbortRef.current = null;
    setBakeBusy(null);
    const message = r.ok ? lightingBakeSummary(r.bake.surface!) : `Bake failed: ${r.message}`;
    setBakeMessage(message);
    return r.ok ? { ok: true, message } : { ok: false, message: r.message };
  }, [activeScene, clientRef, viewportRef]);
  /** Clear the scene's whole bake (saved lighting, or the earlier bakers' lightmaps and probes). */
  const clearBake = useCallback(async () => {
    const c = clientRef.current;
    if (!c || activeScene === null || c.getLighting()[activeScene.sceneId] === undefined) return;
    const err = refusal(await c.command('setLighting', { sceneId: activeScene.sceneId, lighting: null }, c.projection.revision));
    setBakeMessage(err === null ? 'The bake was cleared.' : `Clear failed: ${err}`);
  }, [activeScene, clientRef]);

  return { bakeBusy, bakeMessage, bakeAbortRef, bakeLighting, lightingUnavailable, clearBake };
}

export type LightingBakeState = ReturnType<typeof useLightingBake>;
