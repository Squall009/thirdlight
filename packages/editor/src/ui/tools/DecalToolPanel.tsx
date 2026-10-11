/**
 * The Decals tool window: while it is open (and the Scene view in front),
 * the Scene view's Decal tool is armed — a click on a surface places the
 * chosen decal, Shift+click stamps more, the selected decal's knob and
 * corner turn and scale it.
 *
 * - The picker lists the decal materials and the trim sheets' decal cells
 *   by name. A cell no decal material draws yet gets one when it is picked
 *   (one `setMaterial`), so a placement stays one command.
 * - Picking a sheet cell sizes the decal at the sheet's texel density (no
 *   stretch); the size fields change it.
 * - The settings are remembered per browser (never project data).
 *
 * Browser-only (React).
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';
import { trimCellMetres, trimCellOf } from '@thirdlight/runtime';

import { DECAL_TOOL_DEFAULTS, decalToolSettingsError, type DecalToolSettings } from '../../session/decal-place';
import { newMaterialId } from '../material/MaterialInspector';
import type { ClientRef, ReportFailure, SetNotice, ViewportRef } from '../shell/commands';

const KEY = 'thirdlight.decalTool.v1';

function stored(): DecalToolSettings {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<DecalToolSettings> | null;
    const s: DecalToolSettings = { ...DECAL_TOOL_DEFAULTS, ...(v ?? {}), stamp: { ...DECAL_TOOL_DEFAULTS.stamp, ...(v?.stamp ?? {}) } };
    return decalToolSettingsError(s) === null ? s : { ...DECAL_TOOL_DEFAULTS };
  } catch {
    return { ...DECAL_TOOL_DEFAULTS };
  }
}

/** A trim sheet's decal cell no decal material draws yet. */
interface FreeCell {
  sheet: MaterialDef;
  cell: string;
}

export interface DecalToolState {
  settings: DecalToolSettings;
  setSettings: (s: DecalToolSettings) => void;
  /** The decal materials (roots and instances), and the cells without one. */
  decals: readonly MaterialDef[];
  freeCells: readonly FreeCell[];
  /** Choose a cell: its decal material (made now when it has none) becomes the one placed. */
  pickCell: (sheetId: string, cell: string) => Promise<void>;
  /** A material's name (its id when it has none here). */
  nameOf: (materialId: string) => string;
}

export interface DecalToolDeps {
  clientRef: ClientRef;
  viewportRef: ViewportRef;
  materials: readonly MaterialDef[];
  /** The tool window is open over the Scene view. */
  armed: boolean;
  /** The scene new decals go into (the active one). */
  sceneId: string | null;
  select: (id: string) => void;
  setNotice: SetNotice;
  reportFailure: ReportFailure;
}

export function useDecalTool(deps: DecalToolDeps): DecalToolState {
  const { clientRef, viewportRef, materials, armed, sceneId, select, setNotice, reportFailure } = deps;
  const [settings, setState] = useState<DecalToolSettings>(stored);
  const setSettings = useCallback((s: DecalToolSettings) => {
    setState(s);
    try {
      window.localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      // A browser without storage keeps the settings for this page only.
    }
  }, []);
  const decals = useMemo(() => materials.filter((m) => m.shader === 'decal'), [materials]);
  const freeCells = useMemo(() => {
    const out: FreeCell[] = [];
    for (const sheet of materials) {
      if (sheet.shader !== 'trim' || sheet.instanceOf !== undefined) continue;
      for (const c of sheet.trim?.cells ?? []) if (!decals.some((d) => d.instanceOf === undefined && d.decal?.sheet === sheet.materialId && d.decal.cell === c.name)) out.push({ sheet, cell: c.name });
    }
    return out;
  }, [materials, decals]);
  // A chosen material that is gone (deleted, undone) places nothing until another is chosen.
  const material = settings.material !== null && decals.some((d) => d.materialId === settings.material) ? settings.material : null;

  useEffect(() => {
    const v = viewportRef.current;
    if (v === null) return;
    if (!armed || decalToolSettingsError(settings) !== null) return v.setDecalTool(null, null, null);
    v.setDecalTool({ ...settings, material }, sceneId, {
      place: async (args) => {
        const c = clientRef.current;
        if (c === null) return null;
        const r = await c.command('createEntity', args, c.projection.revision);
        if (!r.ok || r.createdId === undefined) {
          reportFailure('Place decal', r);
          return null;
        }
        select(r.createdId);
        return r.createdId;
      },
      turn: async (entityId, transform) => {
        const c = clientRef.current;
        if (c === null) return false;
        const r = await c.command('setTransform', { entityId, transform }, c.projection.revision);
        if (!r.ok) reportFailure('Turn decal', r);
        return r.ok;
      },
      resize: async (entityId, decal) => {
        const c = clientRef.current;
        if (c === null) return false;
        const r = await c.setComponent(entityId, 'decal', decal as unknown as Record<string, unknown>, c.projection.revision);
        if (!r.ok && (r.response as { code?: string }).code !== 'no_change') reportFailure('Scale decal', r);
        return r.ok;
      },
      refused: (m) => setNotice(m),
    });
  }, [armed, settings, material, sceneId, clientRef, viewportRef, select, setNotice, reportFailure]);
  // The tool goes off with the page.
  useEffect(() => () => viewportRef.current?.setDecalTool(null, null, null), [viewportRef]);

  const pickCell = useCallback(
    async (sheetId: string, cell: string) => {
      const c = clientRef.current;
      const trim = materials.find((m) => m.materialId === sheetId)?.trim;
      const found = trim === undefined ? null : trimCellOf(trim, cell);
      if (c === null || trim === undefined || found === null) return;
      const metres = trimCellMetres(trim, found);
      const sized = { ...settings, size: [metres[0], metres[1], settings.size[2]] as [number, number, number] };
      const existing = decals.find((d) => d.instanceOf === undefined && d.decal?.sheet === sheetId && d.decal.cell === cell);
      if (existing !== undefined) return setSettings({ ...sized, material: existing.materialId });
      const def: MaterialDef = { materialId: newMaterialId(materials, `${cell} decal`), name: `${cell} decal`, shader: 'decal', params: {}, textures: {}, decal: { sheet: sheetId, cell } };
      const r = await c.command('setMaterial', { material: def }, c.projection.revision);
      if (!r.ok) return reportFailure('New decal material', r);
      setSettings({ ...sized, material: def.materialId });
    },
    [clientRef, materials, decals, settings, setSettings, reportFailure],
  );
  const nameOf = useCallback((id: string) => materials.find((m) => m.materialId === id)?.name ?? id, [materials]);
  return { settings: { ...settings, material }, setSettings, decals, freeCells, pickCell, nameOf };
}

const num = (v: string): number => (v.trim() === '' ? Number.NaN : Number(v));

/** The Decals window's body: what to place and how. */
export function DecalToolPanel({ tool }: { tool: DecalToolState }): JSX.Element {
  const { settings: s, setSettings, decals, freeCells, pickCell, nameOf } = tool;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  /** A number field: stored when the settings it makes can place a decal, else the reason is shown. */
  const field = (label: string, key: string, value: number, apply: (v: number) => DecalToolSettings, step: number, title: string): JSX.Element => (
    <label className="tl-field" title={title}>
      <span className="tl-field__label">{label}</span>
      <input
        className="tl-input"
        type="number"
        step={step}
        aria-label={`decal ${key}`}
        value={draft[key] ?? String(value)}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
        onBlur={() => {
          const raw = draft[key];
          if (raw === undefined) return;
          const next = apply(num(raw));
          const why = decalToolSettingsError(next);
          setError(why);
          if (why === null) setSettings(next);
          const { [key]: _gone, ...rest } = draft;
          setDraft(rest);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
  const choice = s.material ?? '';
  return (
    <div className="tl-decal-tool" aria-label="decal tool">
      <label className="tl-field">
        <span className="tl-field__label">decal</span>
        <select
          className="tl-input"
          aria-label="decal to place"
          value={choice}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('cell:')) {
              const [, sheetId, ...cell] = v.split(':');
              void pickCell(sheetId!, cell.join(':'));
            } else setSettings({ ...s, material: v === '' ? null : v });
          }}
          title="A decal material, or a trim sheet's decal cell by name (a cell gets its decal material when picked)"
        >
          <option value="">— choose a decal —</option>
          {decals.length > 0 && (
            <optgroup label="Decal materials">
              {decals.map((d) => (
                <option key={d.materialId} value={d.materialId}>
                  {d.name}
                  {d.decal !== undefined ? ` (${nameOf(d.decal.sheet)} / ${d.decal.cell})` : ''}
                </option>
              ))}
            </optgroup>
          )}
          {freeCells.length > 0 && (
            <optgroup label="Trim sheet cells">
              {freeCells.map((f) => (
                <option key={`${f.sheet.materialId}:${f.cell}`} value={`cell:${f.sheet.materialId}:${f.cell}`}>
                  {f.sheet.name} / {f.cell}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <label className="tl-field" title="Projected: marks every surface in its box, per channel, as the camera sees it. Clipped: a mesh cut from the surfaces under it (many static marks for less).">
        <span className="tl-field__label">mode</span>
        <select className="tl-input" aria-label="decal mode" value={s.mode} onChange={(e) => setSettings({ ...s, mode: e.target.value as DecalToolSettings['mode'] })}>
          <option value="projected">projected</option>
          <option value="clipped">clipped</option>
        </select>
      </label>
      {field('width', 'width', s.size[0], (v) => ({ ...s, size: [v, s.size[1], s.size[2]] }), 0.05, 'Width of the mark (metres).')}
      {field('height', 'height', s.size[1], (v) => ({ ...s, size: [s.size[0], v, s.size[2]] }), 0.05, 'Height of the mark (metres).')}
      {field('depth', 'depth', s.size[2], (v) => ({ ...s, size: [s.size[0], s.size[1], v] }), 0.05, 'How deep the box reaches through the surface (metres): half in front of the point clicked, half behind.')}
      {field('angle', 'angle', s.angle, (v) => ({ ...s, angle: v }), 15, 'Degrees a placed decal turns about the surface normal.')}
      <div className="tl-decal-tool__stamp" aria-label="stamp settings">
        {field('stamp turn', 'turn', s.stamp.turn, (v) => ({ ...s, stamp: { ...s.stamp, turn: v } }), 15, 'Shift+click stamps: each turns by a random angle up to ± this many degrees.')}
        {field('stamp size min', 'scale-min', s.stamp.scaleMin, (v) => ({ ...s, stamp: { ...s.stamp, scaleMin: v } }), 0.05, 'Shift+click stamps: each is sized by a random factor between min and max.')}
        {field('stamp size max', 'scale-max', s.stamp.scaleMax, (v) => ({ ...s, stamp: { ...s.stamp, scaleMax: v } }), 0.05, 'Shift+click stamps: each is sized by a random factor between min and max.')}
        {field('seed', 'seed', s.stamp.seed, (v) => ({ ...s, stamp: { ...s.stamp, seed: v } }), 1, 'The same stamps with the same seed give the same turns and sizes; another seed others.')}
      </div>
      {error !== null && (
        <p className="tl-hint tl-hint--error" role="alert">
          {error}
        </p>
      )}
      <p className="tl-hint">
        {s.material === null
          ? 'Choose a decal, then click a surface in the Scene view.'
          : 'Click a surface to place; Shift+click to stamp more. Drag the selected decal’s knob to turn it, its corner to scale it. Each is one undo step.'}
      </p>
    </div>
  );
}
