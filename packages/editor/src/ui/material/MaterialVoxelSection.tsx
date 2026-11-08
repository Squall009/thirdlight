/**
 * A material's voxel use in the Inspector: whether and how the record is
 * also a voxel material (its voxel id, use, kit, tile and relief depth),
 * and the badges of what it can be used for. Every change is one
 * `setMaterial` (committed on release), so each is one undo; the backend's
 * refusals (a voxel id another material has, a kit the project lacks) show
 * as every material refusal does.
 *
 * An instance is a voxel variant when it has a voxel part of its own: its
 * own id (the id is never inherited), the rest its parent's unless it sets
 * them. Texture sets per surface (wall, floor, ceiling) are named on the
 * record by MCP and drawn once voxel texture arrays are; this section shows
 * how many it names.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';
import { materialBadges, VOXEL_MATERIAL_LIMITS, VOXEL_MATERIAL_USES, voxelTileMetresDefault, type MaterialVoxel, type VoxelMaterialUse } from '@thirdlight/project-model/voxel-materials';
import { RefPicker } from '../catalog/RefPicker';

/** What each badge says (the material library's tile shows the same). */
export const BADGE_TITLES: Readonly<Record<string, string>> = {
  mesh: 'draws on meshes (props, characters, kit pieces)',
  voxel: 'a voxel material: voxel tools list it',
  kit: "its voxel edges draw a kit's detail pieces",
  liquid: 'a liquid',
  decal: 'a decal',
  graph: 'a node graph that compiles its own shader',
};

/** A material's badges as tags. */
export function MaterialBadges(p: { badges: readonly string[] }): JSX.Element {
  return (
    <span className="tl-material-badges" aria-label="material badges">
      {p.badges.map((b) => (
        <span key={b} className="tl-tag" data-badge={b} title={BADGE_TITLES[b] ?? b}>
          {b}
        </span>
      ))}
    </span>
  );
}

/** The smallest voxel id no material has (null: all are taken). */
export function freeVoxelId(materials: readonly MaterialDef[]): number | null {
  const taken = new Set(materials.flatMap((m) => (m.voxel !== undefined ? [m.voxel.id] : [])));
  for (let id = VOXEL_MATERIAL_LIMITS.idMin; id <= VOXEL_MATERIAL_LIMITS.idMax; id++) if (!taken.has(id)) return id;
  return null;
}

/** A number field committed on blur or Enter (empty: absent). */
function NumberField(p: { aria: string; value: number | undefined; placeholder: string; min: number; max: number; step: number; onCommit: (v: number | undefined) => void }): JSX.Element {
  const [draft, setDraft] = useState(p.value === undefined ? '' : String(p.value));
  useEffect(() => setDraft(p.value === undefined ? '' : String(p.value)), [p.value]);
  const commit = (): void => {
    const t = draft.trim();
    const v = t === '' ? undefined : Math.min(p.max, Math.max(p.min, Number(t)));
    if (v !== undefined && !Number.isFinite(v)) return;
    if (v !== p.value) p.onCommit(v);
  };
  return (
    <input
      className="tl-input tl-input--num"
      type="number"
      aria-label={p.aria}
      min={p.min}
      max={p.max}
      step={p.step}
      placeholder={p.placeholder}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/**
 * The voxel section of a material (or instance) record. `resolved`: the record with its chain folded in (what it
 * draws as: its badges); `parent`: an instance's parent resolved (what a variant inherits, shown as placeholders).
 */
export function MaterialVoxelSection(p: { material: MaterialDef; resolved: MaterialDef; parent: MaterialDef | null; materials: readonly MaterialDef[]; onSave: (m: MaterialDef) => void }): JSX.Element {
  const m = p.material;
  const own = m.voxel;
  const instance = m.instanceOf !== undefined;
  const inherited = p.parent?.voxel;
  const L = VOXEL_MATERIAL_LIMITS;
  const save = (voxel: MaterialVoxel | undefined): void => {
    const { voxel: _old, ...rest } = m;
    p.onSave(voxel === undefined ? rest : { ...rest, voxel });
  };
  const set = (patch: Partial<MaterialVoxel>): void => {
    if (own === undefined) return;
    const next: MaterialVoxel = { ...own, ...patch };
    for (const k of Object.keys(patch) as (keyof MaterialVoxel)[]) if (patch[k] === undefined) delete next[k];
    save(next);
  };
  const use = own?.use;
  const shownUse: VoxelMaterialUse | undefined = own?.use ?? (own !== undefined ? inherited?.use : undefined);
  const surfaces = Object.keys(own?.surfaces ?? {}).length;
  return (
    <div className="tl-material-voxel" aria-label="voxel use">
      <div className="tl-subhead">Voxel use</div>
      <div className="tl-field">
        <span className="tl-field__label">badges</span>
        <MaterialBadges badges={materialBadges(p.resolved)} />
      </div>
      <label className="tl-field">
        <span className="tl-field__label">{instance ? 'voxel variant' : 'voxel use'}</span>
        <select
          className="tl-input"
          aria-label="voxel use"
          value={own === undefined ? '' : (use ?? 'inherit')}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') return save(undefined);
            const id = own?.id ?? freeVoxelId(p.materials);
            if (id === null) return;
            if (v === 'inherit') {
              const { use: _u, ...rest } = own ?? { id };
              return save({ ...rest, id });
            }
            save({ ...(own ?? { id }), use: v as VoxelMaterialUse });
          }}
        >
          <option value="">{instance ? '— not a voxel variant (mesh only) —' : '— none (meshes only) —'}</option>
          {instance && <option value="inherit">{`a variant: the parent's use${inherited?.use !== undefined ? ` (${inherited.use})` : ''}`}</option>}
          {VOXEL_MATERIAL_USES.map((u) => (
            <option key={u} value={u}>
              {u}
            </option>
          ))}
        </select>
      </label>
      {own !== undefined && (
        <>
          <label className="tl-field">
            <span className="tl-field__label">voxel id</span>
            <NumberField aria="voxel id" value={own.id} placeholder="" min={L.idMin} max={L.idMax} step={1} onCommit={(v) => v !== undefined && Number.isInteger(v) && set({ id: v })} />
          </label>
          {shownUse !== 'liquid' && (
            <label className="tl-field">
              <span className="tl-field__label">kit</span>
              <RefPicker aria="voxel kit" kinds={['voxelkit']} value={own.kit ?? ''} none={instance && inherited?.kit !== undefined && own.kit === undefined ? `— the parent's (${inherited.kit}) —` : '— no kit (plain faces) —'} onPick={(id) => set({ kit: id === '' ? undefined : id })} />
            </label>
          )}
          <label className="tl-field">
            <span className="tl-field__label">tile metres</span>
            <NumberField aria="voxel tile metres" value={own.tileMetres} placeholder={String(inherited?.tileMetres ?? (shownUse !== undefined ? voxelTileMetresDefault(shownUse) : ''))} min={L.tileMetresMin} max={L.tileMetresMax} step={0.5} onCommit={(v) => set({ tileMetres: v })} />
          </label>
          <label className="tl-field">
            <span className="tl-field__label">height depth m</span>
            <NumberField aria="voxel height depth" value={own.heightDepth} placeholder={String(inherited?.heightDepth ?? L.heightDepthDefault)} min={0} max={L.heightDepthMax} step={0.005} onCommit={(v) => set({ heightDepth: v })} />
          </label>
          <p className="tl-hint">
            {surfaces === 0 ? 'Wall, floor and ceiling draw with the material’s own look.' : `${surfaces} surface texture set${surfaces === 1 ? '' : 's'} named (wall, floor, ceiling).`} The colour above tints its voxels.
          </p>
        </>
      )}
    </div>
  );
}
