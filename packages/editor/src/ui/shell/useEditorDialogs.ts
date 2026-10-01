/**
 * The editor's modal dialogs' state and actions: which one is open, Export
 * game (and its zip), Play from… (a scene, script variables, a save slot, a
 * game mode), the instance-set scatter and the snapping settings' draft.
 */
import { useCallback, useState } from 'react';
import { SessionClient } from '../../session/client';
import { scatterProblem, scatterTransforms } from '../../session/instances';
import { editorWorkers } from '../../workers/editor-workers';
import type { ClientRef } from './commands';

export interface EditorDialogsDeps {
  clientRef: ClientRef;
  play: (start?: Parameters<SessionClient['playStart']>[1]) => Promise<void>;
  createEntityAt: (what: string, args: Record<string, unknown>, position?: number[]) => Promise<void>;
}

export function useEditorDialogs(deps: EditorDialogsDeps) {
  const { clientRef, play, createEntityAt } = deps;
  /** The open modal (File → Export…, Help → Shortcuts / About). */
  const [dialog, setDialog] = useState<'export' | 'shortcuts' | 'about' | 'instances' | 'playFrom' | 'snapping' | null>(null);
  /** The "Play from…" form (a scene, script variables as JSON, a save slot). */
  const [playFromForm, setPlayFromForm] = useState({ sceneId: '', variables: '', saveSlot: '', mode: '', busy: false, error: null as string | null });
  /**
   * The scatter dialog's form (an instance set of one model).
   * A 20 × 20 m square (it was a 40 × 8 m side-scroller strip) —
   * no view direction assumed; 200 copies at 0.7–1.3× with a random turn read
   * as a natural scatter of props at any scale.
   */
  const [scatter, setScatter] = useState({ assetId: '', count: '200', width: '20', depth: '20', scaleMin: '0.7', scaleMax: '1.3', randomYaw: true, seed: '1', busy: false, error: null as string | null });
  const [exportState, setExportState] = useState<{ busy: boolean; result: { outputDir: string; revision: number; files: number } | null; error: string | null }>({ busy: false, result: null, error: null });
  /** File → Export game…: the admin export route, then a zip download. */
  const exportGame = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    setExportState({ busy: true, result: null, error: null });
    const r = await c.exportProject();
    if (r.ok) setExportState({ busy: false, result: { outputDir: r.outputDir, revision: r.revision, files: r.files }, error: null });
    else setExportState({ busy: false, result: null, error: r.error.message });
  }, [clientRef]);
  const downloadExport = useCallback(async (dir: string) => {
    const c = clientRef.current;
    if (!c) return;
    try {
      const blob = await c.fetchExportZip(dir);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${dir.replace('@', '-')}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setExportState((st) => ({ ...st, error: e instanceof Error ? e.message : String(e) }));
    }
  }, [clientRef]);
  /** Scatter copies of one model into a new instance set at the point the camera looks at. */
  const createInstanceSet = useCallback(async () => {
    const c = clientRef.current;
    if (!c) return;
    const opts = {
      count: Number(scatter.count),
      width: Number(scatter.width),
      depth: Number(scatter.depth),
      scaleMin: Number(scatter.scaleMin),
      scaleMax: Number(scatter.scaleMax),
      randomYaw: scatter.randomYaw,
      seed: Number(scatter.seed),
    };
    const problem = scatter.assetId === '' ? 'choose a model' : scatterProblem(opts);
    if (problem !== null) {
      setScatter((f) => ({ ...f, error: problem }));
      return;
    }
    setScatter((f) => ({ ...f, busy: true, error: null }));
    // The placements are computed in the editor worker (inline without one: the same function).
    let floats: Float32Array;
    try {
      floats = await editorWorkers().run('scatter', () => ({ input: opts }), { inline: () => scatterTransforms(opts) });
    } catch (e) {
      setScatter((f) => ({ ...f, busy: false, error: e instanceof Error ? e.message : String(e) }));
      return;
    }
    const published = await c.publishInstanceBuffer(floats);
    if (!published.ok) {
      setScatter((f) => ({ ...f, busy: false, error: published.error.message }));
      return;
    }
    const name = `${c.content.getAsset(scatter.assetId)?.displayName ?? 'Model'} ×${published.count}`;
    await createEntityAt('Instance set', { kind: 'group', name, components: { instances: { asset: { assetId: scatter.assetId }, buffer: published.digest, count: published.count } } });
    setScatter((f) => ({ ...f, busy: false }));
    setDialog(null);
  }, [clientRef, scatter.count, scatter.width, scatter.depth, scatter.scaleMin, scatter.scaleMax, scatter.randomYaw, scatter.seed, scatter.assetId, createEntityAt]);
  /**
   * "Play from…" — the same play start as the Play button with
   * start options (the backend resolves them; `tl_play_start` sends the same).
   */
  const playFrom = useCallback(async () => {
    const f = playFromForm;
    let variables: Record<string, unknown> | undefined;
    if (f.variables.trim() !== '') {
      try {
        const v = JSON.parse(f.variables) as unknown;
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
        variables = v as Record<string, unknown>;
      } catch {
        setPlayFromForm((x) => ({ ...x, error: 'Variables must be a JSON object, e.g. {"gold": 100}' }));
        return;
      }
    }
    const start = {
      ...(f.sceneId !== '' ? { sceneId: f.sceneId } : {}),
      ...(variables !== undefined ? { variables } : {}),
      ...(f.saveSlot !== '' ? { saveSlot: f.saveSlot } : {}),
      // The game mode the run starts in.
      ...(f.mode !== '' ? { mode: f.mode } : {}),
    };
    setPlayFromForm((x) => ({ ...x, busy: true, error: null }));
    try {
      await play(start);
      setPlayFromForm((x) => ({ ...x, busy: false }));
      setDialog(null);
    } catch (e) {
      const body = (e as { body?: { error?: { message?: unknown } } }).body;
      const message = typeof body?.error?.message === 'string' ? body.error.message : e instanceof Error ? e.message : 'Play could not start';
      setPlayFromForm((x) => ({ ...x, busy: false, error: message }));
    }
  }, [playFromForm, play]);
  // The snapping settings' form while the dialog is open.
  const [snapDraft, setSnapDraft] = useState<{ translateM: string; rotateDeg: string; scale: string; cellTops: boolean } | null>(null);

  return { dialog, setDialog, playFromForm, setPlayFromForm, scatter, setScatter, exportState, setExportState, snapDraft, setSnapDraft, exportGame, downloadExport, createInstanceSet, playFrom };
}

export type EditorDialogsState = ReturnType<typeof useEditorDialogs>;
