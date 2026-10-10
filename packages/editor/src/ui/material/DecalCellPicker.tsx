/**
 * A decal material's source in the Inspector: its own texture slots, or one
 * decal cell of a trim sheet (a trim material's `cells`) — the sheet, then
 * the cell by name. A cell takes the place of the slots (the model refuses
 * both), so choosing one clears them. Each choice is one `setMaterial`.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';

/** The trim materials that hold decal cells (roots: an instance has no table of its own). */
function sheetsWithCells(materials: readonly MaterialDef[]): MaterialDef[] {
  return materials.filter((m) => m.shader === 'trim' && m.instanceOf === undefined && (m.trim?.cells?.length ?? 0) > 0);
}

export function DecalCellPicker({ material, materials, onSave }: { material: MaterialDef; materials: readonly MaterialDef[]; onSave: (m: MaterialDef) => void }): JSX.Element {
  const sheets = sheetsWithCells(materials);
  const ref = material.decal;
  const sheet = ref === undefined ? undefined : materials.find((m) => m.materialId === ref.sheet);
  const cells = sheet?.trim?.cells ?? [];
  const pickSheet = (id: string): void => {
    const rest: MaterialDef = { ...material };
    delete rest.decal;
    if (id === '') return onSave(rest);
    const first = sheets.find((m) => m.materialId === id)?.trim?.cells?.[0];
    if (first !== undefined) onSave({ ...rest, textures: {}, decal: { sheet: id, cell: first.name } });
  };
  return (
    <div className="tl-decal-cell">
      <label className="tl-field">
        <span className="tl-field__label">source</span>
        <select className="tl-input" aria-label="decal sheet" value={ref?.sheet ?? ''} onChange={(e) => pickSheet(e.target.value)} title="Its own textures, or a decal cell of a trim sheet (a level restyled with another sheet swaps its decals too)">
          <option value="">— its own textures —</option>
          {sheets.map((m) => (
            <option key={m.materialId} value={m.materialId}>
              {m.name}
            </option>
          ))}
          {ref !== undefined && sheet === undefined && <option value={ref.sheet}>{ref.sheet} (missing)</option>}
        </select>
      </label>
      {ref !== undefined && (
        <label className="tl-field">
          <span className="tl-field__label">cell</span>
          <select className="tl-input" aria-label="decal cell" value={ref.cell} onChange={(e) => onSave({ ...material, decal: { sheet: ref.sheet, cell: e.target.value } })}>
            {cells.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} ({c.rect[2]} × {c.rect[3]} px)
              </option>
            ))}
            {!cells.some((c) => c.name === ref.cell) && <option value={ref.cell}>{ref.cell} (missing)</option>}
          </select>
        </label>
      )}
    </div>
  );
}
