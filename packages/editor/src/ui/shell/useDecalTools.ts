/**
 * The decal editor's wiring: its selection, the settings of placing and
 * scattering (remembered per browser, never project data), the palette's
 * picks, and every command the editor sends — the same commands as anywhere
 * else:
 *
 * - a placement is one `createEntity`, a scatter stroke one
 *   `createEntities`, a turn or a move one `setTransform`, a scale one
 *   `setComponent`;
 * - an edit of the selection's fields is one `setComponent` on all of them
 *   (`entityIds`), a blend one `setMaterial` of their material;
 * - a trim sheet's cell picked gets its decal material (one `setMaterial`),
 *   a texture or a dropped image becomes a decal material (an import, then
 *   one `setMaterial`);
 * - Delete removes the selected decals in one `deleteEntity` (`entityIds`),
 *   as the editor's delete does; Bake to model bakes each clipped one.
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DecalBlend, DecalComponent, MaterialDef } from '@thirdlight/project-model';
import { trimCellMetres, trimCellOf } from '@thirdlight/runtime';

import { brushStore, DEFAULT_BRUSH, type BrushBounds, type BrushStore } from '../../session/brush';
import { decalPalette, NO_DECAL_FILTER, sanitizeScatter, selectionEdit, type DecalFieldEdit, type DecalFilter, type DecalPaletteEntry, type DecalPaletteFilter, type DecalScatterSettings } from '../../session/decal-editor';
import { DECAL_TOOL_DEFAULTS, decalToolSettingsError, type DecalToolSettings } from '../../session/decal-place';
import { deletedIds, deleteEntitiesArgs } from '../../session/delete-entities';
import type { ProjectedEntity } from '../../session/projection';
import { createEntitiesArgs } from '../../session/request-batches';
import { publishFileAsset } from '../../session/publish-file';
import type { DecalToolMode } from '../../viewport/decal-tool';
import { unionBoxes, type FrameBox } from '../../viewport/frame-view';
import { bakeClippedDecal } from './decal-bake';
import type { ClientRef, ReportFailure, SetNotice, ViewportRef } from './commands';

const SETTINGS_KEY = 'thirdlight.decalTool.v1';
const SCATTER_KEY = 'thirdlight.decalScatter.v1';

/** A scatter brush's footprint: from a hand's width to a square's (metres across). */
const SCATTER_BOUNDS: BrushBounds = Object.freeze({ size: [0.25, 64] as const, heightStep: [DEFAULT_BRUSH.heightStep, DEFAULT_BRUSH.heightStep] as const });
const SCATTER_BRUSH = Object.freeze({ ...DEFAULT_BRUSH, size: 4 });

function read<T>(key: string, parse: (v: unknown) => T, fallback: T): T {
  try {
    return parse(JSON.parse(window.localStorage.getItem(key) ?? 'null') as unknown);
  } catch {
    return fallback;
  }
}
function write(key: string, v: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(v));
  } catch {
    // A browser without storage keeps the settings for this page only.
  }
}

function storedSettings(v: unknown): DecalToolSettings {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Partial<DecalToolSettings>;
  const s: DecalToolSettings = { ...DECAL_TOOL_DEFAULTS, ...o, stamp: { ...DECAL_TOOL_DEFAULTS.stamp, ...(o.stamp ?? {}) } };
  return decalToolSettingsError(s) === null ? s : { ...DECAL_TOOL_DEFAULTS };
}

export interface DecalSelection {
  readonly ids: readonly string[];
  readonly primary: string | null;
}

/** The selected decals with their components (in the selection's order). */
export interface SelectedDecal {
  readonly id: string;
  readonly name: string;
  readonly decal: DecalComponent;
}

export interface DecalTools {
  readonly selection: DecalSelection;
  select(ids: readonly string[], primary?: string | null): void;
  /** What a click places (and a stroke scatters). */
  readonly settings: DecalToolSettings;
  setSettings(s: DecalToolSettings): void;
  readonly scatter: DecalScatterSettings;
  setScatter(s: DecalScatterSettings): void;
  /** The scatter brush's shared settings (its footprint). */
  readonly brush: BrushStore;
  readonly filter: DecalFilter;
  setFilter(f: DecalFilter): void;
  readonly paletteFilter: DecalPaletteFilter;
  setPaletteFilter(f: DecalPaletteFilter): void;
  /** The palette's entries. */
  readonly palette: readonly DecalPaletteEntry[];
  /** The decal materials (roots and instances). */
  readonly materials: readonly MaterialDef[];
  /** Pick an entry: its material is what is placed (a cell gets one now), sized at its sheet's texel density. */
  pick(entry: DecalPaletteEntry): Promise<void>;
  /** A texture becomes a decal material named after it (or `name`), picked now. */
  fromTexture(textureId: string, name?: string): Promise<void>;
  /** An image file is imported and becomes a decal material (picked now). */
  fromFile(file: File): Promise<void>;
  /** Arm the Scene view's tool for a rail mode (null: off); `navigate`: no tool in hand (a click selects, a drag orbits) whatever the mode. */
  arm(mode: DecalToolMode | null, entities: readonly ProjectedEntity[], navigate: boolean): void;
  /** The selected decals now. */
  selected(entities: readonly ProjectedEntity[]): SelectedDecal[];
  /** One field of every selected decal (one command). */
  edit(entities: readonly ProjectedEntity[], e: DecalFieldEdit): Promise<void>;
  /** A material's blend (one `setMaterial`: every decal of it changes). */
  setBlend(materialId: string, blend: DecalBlend): Promise<void>;
  /** Select every decal of the selection's materials. */
  selectSame(entities: readonly ProjectedEntity[]): void;
  /** Delete the selected decals. */
  remove(ids: readonly string[]): Promise<void>;
  /** Bake each selected clipped decal to a model. */
  bake(entities: readonly ProjectedEntity[]): Promise<void>;
  /** The selected decals' box in world metres (each its projector box through its transform; null: none): what Home frames. */
  selectionBox(entities: readonly ProjectedEntity[]): FrameBox | null;
  busy: string | null;
}

export interface DecalToolsDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  materials: readonly MaterialDef[];
  sceneId: string | null;
  newMaterialId: (name: string) => Promise<string>;
  setNotice: SetNotice;
  reportFailure: ReportFailure;
}

export function useDecalTools(deps: DecalToolsDeps): DecalTools {
  const { clientRef, viewportRef, materials, sceneId, newMaterialId, setNotice, reportFailure } = deps;
  const [selection, setSelectionState] = useState<DecalSelection>({ ids: [], primary: null });
  const [settings, setSettingsState] = useState<DecalToolSettings>(() => read(SETTINGS_KEY, storedSettings, { ...DECAL_TOOL_DEFAULTS }));
  const [scatter, setScatterState] = useState<DecalScatterSettings>(() => read(SCATTER_KEY, sanitizeScatter, sanitizeScatter(null)));
  const [filter, setFilter] = useState<DecalFilter>(NO_DECAL_FILTER);
  const [paletteFilter, setPaletteFilter] = useState<DecalPaletteFilter>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const brush = brushStore('decals', 'scatter', SCATTER_BRUSH, SCATTER_BOUNDS);

  const setSettings = useCallback((s: DecalToolSettings) => {
    setSettingsState(s);
    write(SETTINGS_KEY, s);
  }, []);
  const setScatter = useCallback((s: DecalScatterSettings) => {
    const clean = sanitizeScatter(s);
    setScatterState(clean);
    write(SCATTER_KEY, clean);
  }, []);
  const select = useCallback((ids: readonly string[], primary?: string | null) => setSelectionState({ ids: [...ids], primary: primary === undefined ? (ids.at(-1) ?? null) : primary }), []);

  const decalMaterials = useMemo(() => materials.filter((m) => m.shader === 'decal'), [materials]);
  const palette = useMemo(() => decalPalette(materials), [materials]);
  // A picked material that is gone (deleted, undone) places nothing until another is picked.
  const material = settings.material !== null && decalMaterials.some((d) => d.materialId === settings.material) ? settings.material : null;
  const effective = useMemo(() => ({ ...settings, material }), [settings, material]);

  const run = useCallback(
    async (what: string, op: string, args: Record<string, unknown>): Promise<Awaited<ReturnType<NonNullable<ClientRef['current']>['command']>> | null> => {
      const c = clientRef.current;
      if (c === null) return null;
      const r = await c.command(op, args, c.projection.revision);
      if (!r.ok && (r.response as { code?: string }).code !== 'no_change') reportFailure(what, r);
      return r;
    },
    [clientRef, reportFailure],
  );

  // The callbacks the Scene view's tool sends through (read at call time: always the latest wiring).
  const latest = useRef({ run, select, setNotice, selection });
  latest.current = { run, select, setNotice, selection };
  const callbacks = useMemo(
    () => ({
      place: async (args: Record<string, unknown>) => {
        const r = await latest.current.run('Place decal', 'createEntity', args);
        if (r === null || !r.ok || r.createdId === undefined) return null;
        latest.current.select([r.createdId], r.createdId);
        return r.createdId;
      },
      placeMany: async (items: Record<string, unknown>[]) => {
        // One command for the stroke, or as many as the request's count and bytes take; a refused one ends it with what was stored.
        const ids: string[] = [];
        for (const args of createEntitiesArgs(items)) {
          const r = await latest.current.run('Scatter decals', 'createEntities', args);
          if (r === null || !r.ok) return ids.length > 0 ? ids : null;
          for (const e of (r.change as { entities?: { id: string }[] } | undefined)?.entities ?? []) ids.push(e.id);
        }
        return ids;
      },
      transform: async (entityId: string, transform: { position: number[]; rotation: number[]; scale: number[] }) => (await latest.current.run('Move decal', 'setTransform', { entityId, transform }))?.ok === true,
      resize: async (entityId: string, decal: DecalComponent) => (await latest.current.run('Scale decal', 'setComponent', { entityId, component: 'decal', value: decal as unknown as Record<string, unknown> }))?.ok === true,
      select: (ids: readonly string[], primary: string | null) => latest.current.select(ids, primary),
      remove: (ids: readonly string[]) => void removeRef.current(ids),
      refused: (m: string) => latest.current.setNotice(m),
    }),
    [],
  );

  const remove = useCallback(
    async (ids: readonly string[]) => {
      // A refused command leaves what it and the ones after it held selected (they are still there).
      const gone = new Set<string>();
      for (const args of deleteEntitiesArgs(ids)) {
        const r = await run(ids.length === 1 ? 'Delete decal' : 'Delete decals', 'deleteEntity', args);
        if (r === null || !r.ok) break;
        for (const id of deletedIds(args)) gone.add(id);
      }
      setSelectionState((s) => ({ ids: s.ids.filter((id) => !gone.has(id)), primary: s.primary !== null && gone.has(s.primary) ? null : s.primary }));
    },
    [run],
  );
  const removeRef = useRef(remove);
  removeRef.current = remove;

  const armed = useRef<{ mode: DecalToolMode | null; entities: readonly ProjectedEntity[]; navigate: boolean }>({ mode: null, entities: [], navigate: true });
  const arm = useCallback(
    (mode: DecalToolMode | null, entities: readonly ProjectedEntity[], navigate: boolean) => {
      armed.current = { mode, entities, navigate };
      const v = viewportRef.current;
      if (v === null) return;
      if (mode === null) return v.setDecalTool(null, null);
      // A selected decal that is gone (deleted, undone) leaves the selection.
      const live = new Set(entities.filter((e) => e.components['decal'] !== undefined).map((e) => e.id));
      const ids = selection.ids.filter((id) => live.has(id));
      // With no tool, every mode selects (the Select mode's Navigate); Select's one tool is the Box.
      v.setDecalTool({ mode: navigate ? 'select' : mode, selectTool: navigate ? 'navigate' : 'box', settings: effective, scatter, brush, selection: ids, primary: selection.primary !== null && live.has(selection.primary) ? selection.primary : (ids.at(-1) ?? null), filter, sceneId }, callbacks);
    },
    [viewportRef, effective, scatter, brush, selection, filter, sceneId, callbacks],
  );
  // The tool goes off with the page.
  useEffect(() => () => viewportRef.current?.setDecalTool(null, null), [viewportRef]);

  const pick = useCallback(
    async (entry: DecalPaletteEntry) => {
      const c = clientRef.current;
      if (c === null) return;
      // A sheet's cell is placed at the sheet's texel density (no stretch).
      const sheet = entry.cell === undefined ? undefined : materials.find((m) => m.materialId === entry.cell!.sheet)?.trim;
      const cell = sheet === undefined || entry.cell === undefined ? null : trimCellOf(sheet, entry.cell.cell);
      const sized = sheet !== undefined && cell !== null ? { ...settings, size: [...trimCellMetres(sheet, cell), settings.size[2]] as [number, number, number] } : settings;
      if (entry.material !== null) return setSettings({ ...sized, material: entry.material });
      const id = await newMaterialId(`${entry.name} decal`);
      const def: MaterialDef = { materialId: id, name: `${entry.name} decal`, shader: 'decal', params: {}, textures: {}, decal: { sheet: entry.cell!.sheet, cell: entry.cell!.cell } };
      const r = await run('New decal material', 'setMaterial', { material: def });
      if (r?.ok === true) setSettings({ ...sized, material: id });
    },
    [clientRef, materials, settings, setSettings, newMaterialId, run],
  );

  const fromTexture = useCallback(
    async (textureId: string, given?: string) => {
      const c = clientRef.current;
      if (c === null) return;
      // Named after the texture (its name read by id: the editor holds no whole catalog).
      if (given === undefined) await c.catalog.ensureAssets([textureId]);
      const name = given ?? c.content.getAsset(textureId)?.displayName ?? 'Decal';
      const id = await newMaterialId(name);
      const def: MaterialDef = { materialId: id, name, shader: 'decal', params: {}, textures: { map: textureId } };
      const r = await run('New decal material', 'setMaterial', { material: def });
      if (r?.ok === true) setSettings({ ...settings, material: id });
    },
    [clientRef, newMaterialId, run, settings, setSettings],
  );

  const fromFile = useCallback(
    async (file: File) => {
      const c = clientRef.current;
      if (c === null) return;
      if (!/\.(png|jpe?g|webp)$/i.test(file.name)) return setNotice(`${file.name}: a decal image is a PNG, JPEG or WebP (its alpha is the decal's shape).`);
      const name = file.name.replace(/\.[^.]+$/, '');
      setBusy(`Importing ${file.name}…`);
      try {
        const id = await publishFileAsset(c, new Uint8Array(await file.arrayBuffer()), name, undefined, file.name);
        if (typeof id !== 'string') return setNotice(id.message);
        await fromTexture(id, name);
      } finally {
        setBusy(null);
      }
    },
    [clientRef, fromTexture, setNotice],
  );

  const selected = useCallback(
    (entities: readonly ProjectedEntity[]): SelectedDecal[] => {
      const byId = new Map(entities.map((e) => [e.id, e]));
      const out: SelectedDecal[] = [];
      for (const id of selection.ids) {
        const e = byId.get(id);
        const d = e?.components['decal'] as DecalComponent | undefined;
        if (e !== undefined && d !== undefined) out.push({ id, name: e.name, decal: d });
      }
      return out;
    },
    [selection],
  );

  const edit = useCallback(
    async (entities: readonly ProjectedEntity[], e: DecalFieldEdit) => {
      // One command for the selection (a selection larger than one request holds goes as more).
      for (const args of selectionEdit(selected(entities), e)) {
        if ((await run('Edit decals', 'setComponent', args))?.ok !== true) break;
      }
    },
    [selected, run],
  );

  const setBlend = useCallback(
    async (materialId: string, blend: DecalBlend) => {
      const m = materials.find((x) => x.materialId === materialId);
      if (m === undefined || m.instanceOf !== undefined) return;
      await run('Decal blend', 'setMaterial', { material: { ...m, params: { ...m.params, blend } } });
    },
    [materials, run],
  );

  const selectSame = useCallback(
    (entities: readonly ProjectedEntity[]) => {
      const mats = new Set(selected(entities).map((s) => s.decal.material));
      const ids = entities.filter((e) => mats.has((e.components['decal'] as DecalComponent | undefined)?.material ?? '\u0000')).map((e) => e.id);
      select(ids, selection.primary);
    },
    [selected, select, selection.primary],
  );

  const bake = useCallback(
    async (entities: readonly ProjectedEntity[]) => {
      const c = clientRef.current;
      if (c === null) return;
      const clipped = selected(entities).filter((s) => s.decal.mode === 'clipped');
      if (clipped.length === 0) return setNotice('Bake to model takes clipped decals: set Projection to Clipped first.');
      setBusy('Baking…');
      try {
        for (const s of clipped) {
          const r = await bakeClippedDecal(c, s.id, viewportRef.current?.clippedDecalMesh(s.id) ?? null);
          if (!r.ok) return setNotice(r.message);
        }
        setNotice(clipped.length === 1 ? 'Baked the decal to a model.' : `Baked ${clipped.length} decals to models.`);
        setSelectionState((x) => ({ ids: x.ids.filter((id) => !clipped.some((s) => s.id === id)), primary: null }));
      } finally {
        setBusy(null);
      }
    },
    [clientRef, viewportRef, selected, setNotice],
  );

  // A change of the settings or the selection re-arms the tool in the mode it is in.
  useEffect(() => {
    if (armed.current.mode !== null) arm(armed.current.mode, armed.current.entities, armed.current.navigate);
  }, [arm]);

  const selectionBox = useCallback(
    (entities: readonly ProjectedEntity[]): FrameBox | null =>
      unionBoxes(
        selection.ids.map((id) => {
          const d = entities.find((e) => e.id === id)?.components['decal'] as DecalComponent | undefined;
          if (d === undefined) return null;
          const [w, h, depth] = d.size;
          return viewportRef.current?.worldBoxOf(id, { min: [-w / 2, -h / 2, -depth / 2], max: [w / 2, h / 2, depth / 2] }) ?? null;
        }),
      ),
    [selection.ids, viewportRef],
  );
  return { selection, select, settings: effective, setSettings, scatter, setScatter, brush, filter, setFilter, paletteFilter, setPaletteFilter, palette, materials: decalMaterials, pick, fromTexture, fromFile, arm, selected, edit, setBlend, selectSame, remove, bake, selectionBox, busy };
}
