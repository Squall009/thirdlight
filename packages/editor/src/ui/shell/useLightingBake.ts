/**
 * The Lighting window's bakes of the active scene: the settings, a running
 * bake (in the browser or on the bake host) with its progress and outcome,
 * and clearing a bake.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SceneHeaderView } from '../Hierarchy';
import { DEFAULT_BAKE_SETTINGS, runBlenderBake, runBrowserBake, type BakeSettings } from '../../viewport/bake-run';
import { refusal, type ClientRef, type ViewportRef } from './commands';

export function useLightingBake(clientRef: ClientRef, viewportRef: ViewportRef, activeScene: SceneHeaderView | null, refreshEntities: () => void, lightingShown: boolean) {
  // The Lighting window (bake settings, a running bake, its outcome).
  const [bakeSettings, setBakeSettings] = useState<BakeSettings>(DEFAULT_BAKE_SETTINGS);
  const [bakeBusy, setBakeBusy] = useState<{ text: string; fraction: number } | null>(null);
  const [bakeMessage, setBakeMessage] = useState<string | null>(null);
  const [bakeHost, setBakeHost] = useState<string | null>('checking the bake host…');
  const bakeAbortRef = useRef<AbortController | null>(null);
  const bakePreview = useCallback(async () => {
    const c = clientRef.current;
    const v = viewportRef.current;
    if (!c || !v || activeScene === null) return;
    if (v.getLighting() !== 'game') v.setLighting('game');
    const abort = new AbortController();
    bakeAbortRef.current = abort;
    setBakeMessage(null);
    setBakeBusy({ text: 'preparing…', fraction: 0 });
    const r = await runBrowserBake({
      client: c,
      viewport: v,
      sceneId: activeScene.sceneId,
      sceneName: activeScene.name,
      settings: bakeSettings,
      onProgress: (text, fraction) => setBakeBusy({ text, fraction }),
      signal: abort.signal,
    });
    bakeAbortRef.current = null;
    setBakeBusy(null);
    if (!r.ok) setBakeMessage(`Bake failed: ${r.message}`);
    else {
      setBakeMessage(`Baked ${r.bake.entries.length} objects in ${(r.millis / 1000).toFixed(1)} s${r.where === 'worker' ? ' (in a worker)' : ''}${r.skipped.length > 0 ? `; ${r.skipped.length} static object(s) have no lightmap UV (UV1) and only cast shadows` : ''}.`);
      await c.fullResync();
      refreshEntities();
    }
  }, [activeScene, bakeSettings, clientRef, refreshEntities, viewportRef]);
  const bakeFinal = useCallback(async () => {
    const c = clientRef.current;
    const v = viewportRef.current;
    if (!c || !v || activeScene === null) return;
    const abort = new AbortController();
    bakeAbortRef.current = abort;
    setBakeMessage(null);
    setBakeBusy({ text: 'preparing…', fraction: 0 });
    const r = await runBlenderBake({
      client: c,
      viewport: v,
      sceneId: activeScene.sceneId,
      sceneName: activeScene.name,
      settings: bakeSettings,
      onProgress: (text, fraction) => setBakeBusy({ text, fraction }),
      signal: abort.signal,
    });
    bakeAbortRef.current = null;
    setBakeBusy(null);
    if (!r.ok) setBakeMessage(`Final bake failed: ${r.message}`);
    else {
      setBakeMessage(
        `Final bake of ${r.bake.entries.length} objects done in ${(r.millis / 1000).toFixed(0)} s${r.device !== undefined ? ` (${r.device})` : ''}${r.skipped.length > 0 ? `; ${r.skipped.length} static object(s) have no lightmap UV (UV1) and only cast shadows` : ''}.`,
      );
      await c.fullResync();
      refreshEntities();
    }
  }, [activeScene, bakeSettings, clientRef, refreshEntities, viewportRef]);
  const clearBake = useCallback(async () => {
    const c = clientRef.current;
    if (!c || activeScene === null) return;
    const err = refusal(await c.command('setLighting', { sceneId: activeScene.sceneId, lighting: null }, c.projection.revision));
    setBakeMessage(err === null ? 'The bake was cleared.' : `Clear failed: ${err}`);
  }, [activeScene, clientRef]);
  useEffect(() => {
    if (!lightingShown) return;
    const c = clientRef.current;
    if (!c) return;
    void c.bakeHostStatus().then((st) => setBakeHost(st.ok ? null : st.message));
  }, [clientRef, lightingShown]);

  return { bakeSettings, setBakeSettings, bakeBusy, bakeMessage, bakeHost, bakeAbortRef, bakePreview, bakeFinal, clearBake };
}

export type LightingBakeState = ReturnType<typeof useLightingBake>;
