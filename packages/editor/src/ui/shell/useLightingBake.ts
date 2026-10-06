/**
 * The Lighting window's bakes of the active scene: the settings, a running
 * bake (in the browser or on the bake host) with its progress and outcome,
 * and clearing a bake.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SceneHeaderView } from '../Hierarchy';
import { DEFAULT_BAKE_SETTINGS, runBlenderBake, runBrowserBake, type BakeSettings } from '../../viewport/bake-run';
import { DEFAULT_PROBE_BAKE_SETTINGS, probeBakeUnavailable, runProbeBake, withoutLightmaps, withoutProbes, type ProbeBakeSettings } from '../../viewport/probe-bake-run';
import { refusal, type ClientRef, type ViewportRef } from './commands';

/** `sceneApi`: the Scene view's graphics API (probes bake on WebGPU only). */
export function useLightingBake(clientRef: ClientRef, viewportRef: ViewportRef, activeScene: SceneHeaderView | null, refreshEntities: () => void, lightingShown: boolean, sceneApi: string | null) {
  // The Lighting window (bake settings, a running bake, its outcome).
  const [bakeSettings, setBakeSettings] = useState<BakeSettings>(DEFAULT_BAKE_SETTINGS);
  const [bakeBusy, setBakeBusy] = useState<{ text: string; fraction: number } | null>(null);
  const [bakeMessage, setBakeMessage] = useState<string | null>(null);
  const [bakeHost, setBakeHost] = useState<string | null>('checking the bake host…');
  const bakeAbortRef = useRef<AbortController | null>(null);
  const [probeSettings, setProbeSettings] = useState<ProbeBakeSettings>(DEFAULT_PROBE_BAKE_SETTINGS);
  const probeUnavailable = probeBakeUnavailable(sceneApi);
  // The scene's probe spacing and bounces are the ones its last probe bake used.
  const activeId = activeScene?.sceneId ?? null;
  useEffect(() => {
    const last = activeId !== null ? clientRef.current?.getLighting()[activeId]?.probes : undefined;
    setProbeSettings(last !== undefined ? { spacing: last.spacing, bounces: last.bounces } : DEFAULT_PROBE_BAKE_SETTINGS);
  }, [activeId, clientRef]);
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
  const bakeProbes = useCallback(async () => {
    const c = clientRef.current;
    const v = viewportRef.current;
    if (!c || !v || activeScene === null) return;
    // The probes see the scene's own sky (game lighting).
    if (v.getLighting() !== 'game') v.setLighting('game');
    const abort = new AbortController();
    bakeAbortRef.current = abort;
    setBakeMessage(null);
    setBakeBusy({ text: 'preparing…', fraction: 0 });
    const r = await runProbeBake({ client: c, viewport: v, sceneId: activeScene.sceneId, sceneName: activeScene.name, settings: probeSettings, onProgress: (text, fraction) => setBakeBusy({ text, fraction }), signal: abort.signal });
    bakeAbortRef.current = null;
    setBakeBusy(null);
    if (!r.ok) setBakeMessage(`Probe bake failed: ${r.message}`);
    else {
      const p = r.probes;
      setBakeMessage(
        `Baked ${p.probes} probes in ${p.grids.length} tile${p.grids.length === 1 ? '' : 's'} in ${(r.millis / 1000).toFixed(1)} s: ${(p.gpuBytes / 1048576).toFixed(1)} MB GPU, ${(r.fileBytes / 1024).toFixed(0)} KB of files; ${p.moved} moved out of geometry, ${p.filled} filled from neighbours.`,
      );
    }
  }, [activeScene, clientRef, probeSettings, viewportRef]);
  /** Clear one part of the scene's bake (the lightmaps or the probes); the other part stays. */
  const clearPart = useCallback(
    async (part: 'lightmaps' | 'probes') => {
      const c = clientRef.current;
      if (!c || activeScene === null) return;
      const bake = c.getLighting()[activeScene.sceneId];
      if (bake === undefined) return;
      const next = part === 'probes' ? withoutProbes(bake) : withoutLightmaps(bake);
      const err = refusal(await c.command('setLighting', { sceneId: activeScene.sceneId, lighting: next }, c.projection.revision));
      setBakeMessage(err === null ? (part === 'probes' ? 'The probes were cleared.' : 'The bake was cleared.') : `Clear failed: ${err}`);
    },
    [activeScene, clientRef],
  );
  const clearBake = useCallback(() => clearPart('lightmaps'), [clearPart]);
  const clearProbes = useCallback(() => clearPart('probes'), [clearPart]);
  useEffect(() => {
    if (!lightingShown) return;
    const c = clientRef.current;
    if (!c) return;
    void c.bakeHostStatus().then((st) => setBakeHost(st.ok ? null : st.message));
  }, [clientRef, lightingShown]);

  return { bakeSettings, setBakeSettings, bakeBusy, bakeMessage, bakeHost, bakeAbortRef, bakePreview, bakeFinal, clearBake, probeSettings, setProbeSettings, probeUnavailable, bakeProbes, clearProbes };
}

export type LightingBakeState = ReturnType<typeof useLightingBake>;
