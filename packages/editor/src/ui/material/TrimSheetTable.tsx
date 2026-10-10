/**
 * A trim material's row table in the Inspector: the sheet's size, texel
 * density and padding, and one line per row — its slot, pixel bounds, its
 * own density (empty: the sheet's), whether it tiles in v — with the row's
 * height in metres and the deepest mip level it reads cleanly. "Equal rows"
 * splits the sheet again into equal rows (the default layout), "Import
 * layout.json" reads a Texture Designer trim export's table (its rows and
 * its decal cells, listed under the rows), "Check padding"
 * asks the backend to compare the albedo's padding pixels with each row's
 * edge. A table the model would refuse is not saved (the message says why);
 * the warnings (thin padding, a shallow safe mip level, missing starter
 * slots) are shown under it. Every change is one `setMaterial`.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import type { MaterialDef, TrimRow, TrimSheet } from '@thirdlight/project-model';
import {
  canonicalTrimSheet,
  defaultTrimSheet,
  equalTrimRows,
  TRIM_STARTER_LAYOUT,
  trimLayoutMissing,
  trimRowMetres,
  trimSafeMipLevel,
  trimSheetErrors,
  trimSheetFromLayout,
  trimSheetProblems,
  trimSheetSafeMipLevel,
  trimCellMetres,
} from '@thirdlight/project-model/trim-sheet';

import type { TrimCheckView } from '../../session/client';

export type TrimCheck = (texture: string, trim: TrimSheet) => Promise<TrimCheckView | { ok: false; error: { code: string; message: string } }>;

/** The first starter slot the sheet lacks, else `row-2`, `row-3`, … */
function freeSlot(sheet: TrimSheet): string {
  const used = new Set(sheet.rows.map((r) => r.slot));
  const starter = TRIM_STARTER_LAYOUT.find((s) => !used.has(s));
  if (starter !== undefined) return starter;
  let n = 2;
  while (used.has(`row-${n}`)) n += 1;
  return `row-${n}`;
}

export function TrimSheetTable({ material, onSave, onCheck }: { material: MaterialDef; onSave: (m: MaterialDef) => void; onCheck?: TrimCheck }): JSX.Element {
  const stored = material.trim ?? defaultTrimSheet();
  // The table as last saved here: edits in quick succession build on each other before the project shows them back.
  const [sheet, setSheet] = useState<TrimSheet>(stored);
  const storedKey = JSON.stringify(stored);
  useEffect(() => setSheet(JSON.parse(storedKey) as TrimSheet), [storedKey]);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const save = (next: TrimSheet): boolean => {
    const bad = trimSheetErrors(next)[0];
    if (bad !== undefined) {
      setError(`${bad.path.replace(/^\/rows\/(\d+)/, (_, i: string) => `row ${Number(i) + 1}`)}: ${bad.message}`);
      return false;
    }
    setError(null);
    setChecked(null);
    const canonical = canonicalTrimSheet(next);
    setSheet(canonical);
    onSave({ ...material, trim: canonical });
    return true;
  };
  const setRow = (i: number, patch: Partial<TrimRow>): boolean => {
    const rows = sheet.rows.map((r, k) => {
      if (k !== i) return r;
      const next: TrimRow = { ...r, ...patch };
      if (patch.texelDensity === undefined && 'texelDensity' in patch) delete next.texelDensity;
      if (next.tileV !== true) delete next.tileV;
      return next;
    });
    return save({ ...sheet, rows });
  };
  const addRow = (): void => {
    const last = sheet.rows.reduce((m, r) => Math.max(m, r.bottom), 0);
    const top = last + 2 * sheet.padding;
    const bottom = Math.min(sheet.size[1] - sheet.padding, top + 64);
    if (bottom <= top) {
      setError('no room below the last row: make a row shorter (or the sheet taller) first');
      return;
    }
    save({ ...sheet, rows: [...sheet.rows, { slot: freeSlot(sheet), top, bottom }] });
  };
  const importLayout = async (f: File): Promise<void> => {
    let json: unknown;
    try {
      json = JSON.parse(await f.text());
    } catch {
      setError(`${f.name} is not JSON`);
      return;
    }
    const r = trimSheetFromLayout(json);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    const cells = r.sheet.cells?.length ?? 0;
    if (save(r.sheet)) setChecked(`Imported ${r.sheet.rows.length} rows and ${cells} decal cell${cells === 1 ? '' : 's'}${r.skipped.length > 0 ? ` (left out, neither rows nor cells: ${r.skipped.join(', ')})` : ''}.`);
  };
  const runCheck = async (): Promise<void> => {
    const texture = material.textures['map'];
    if (onCheck === undefined || texture === undefined) return;
    setChecked('Checking…');
    const r = await onCheck(texture, sheet);
    if (!r.ok) {
      setChecked(`Not checked: ${r.error.message}`);
      return;
    }
    if (!r.sizeMatches) setChecked(`The albedo is ${r.width} × ${r.height}, the table says ${sheet.size[0]} × ${sheet.size[1]}: set the size to the image's.`);
    else if (r.problems.length === 0) setChecked(`Padding OK: every row's padding repeats its edge (${r.width} × ${r.height}${r.transcoded ? ', read from the KTX2' : ''}).`);
    else setChecked(r.problems.map((p) => `“${p.slot}”: the padding ${p.side} differs from the row by up to ${p.difference} (pixel row ${p.y})`).join('; '));
  };

  const problems = trimSheetProblems(sheet);
  const missing = trimLayoutMissing(sheet, TRIM_STARTER_LAYOUT);
  const safe = trimSheetSafeMipLevel(sheet);
  return (
    <div className="tl-trim-sheet">
      <div className="tl-subhead">Trim sheet</div>
      <div className="tl-trim-sheet__fields">
        <NumberField label="sheet width (px)" value={sheet.size[0]} onCommit={(v) => save({ ...sheet, size: [v!, sheet.size[1]] })} />
        <NumberField label="sheet height (px)" value={sheet.size[1]} onCommit={(v) => save({ ...sheet, size: [sheet.size[0], v!] })} />
        <NumberField label="texel density (px/m)" value={sheet.texelDensity} onCommit={(v) => save({ ...sheet, texelDensity: v! })} />
        <NumberField label="padding (px)" value={sheet.padding} onCommit={(v) => save({ ...sheet, padding: v! })} />
      </div>
      <table className="tl-material-layers__table" aria-label="trim rows">
        <thead>
          <tr>
            <th scope="col">slot</th>
            <th scope="col" title="The row's first pixel row (from the image's top)">top</th>
            <th scope="col" title="The pixel row below the row's last">bottom</th>
            <th scope="col" title="Pixels per metre along the strip (empty: the sheet's)">px/m</th>
            <th scope="col" title="The row tiles in v too: its padding continues its wrap">tiles v</th>
            <th scope="col" title="The row's height in metres with square texels">m</th>
            <th scope="col" title="The deepest mip level the row reads without its neighbours">mips</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((r, i) => (
            <tr key={`${i}:${r.slot}`}>
              <td>
                <TextField label={`row ${i + 1} slot`} value={r.slot} onCommit={(v) => setRow(i, { slot: v })} />
              </td>
              <td>
                <NumberField label={`row ${i + 1} top`} value={r.top} onCommit={(v) => setRow(i, { top: v! })} bare />
              </td>
              <td>
                <NumberField label={`row ${i + 1} bottom`} value={r.bottom} onCommit={(v) => setRow(i, { bottom: v! })} bare />
              </td>
              <td>
                <NumberField label={`row ${i + 1} texel density`} value={r.texelDensity ?? null} onCommit={(v) => setRow(i, { texelDensity: v ?? undefined })} bare optional />
              </td>
              <td>
                <input type="checkbox" aria-label={`row ${i + 1} tiles in v`} checked={r.tileV === true} onChange={(e) => setRow(i, { tileV: e.target.checked })} />
              </td>
              <td aria-label={`row ${i + 1} metres`}>{trimRowMetres(sheet, r).toFixed(3)}</td>
              <td aria-label={`row ${i + 1} safe mip level`}>{trimSafeMipLevel(sheet, r)}</td>
              <td>
                <button className="tl-btn tl-btn--small" aria-label={`delete row ${i + 1}`} title="Delete the row" disabled={sheet.rows.length <= 1} onClick={() => save({ ...sheet, rows: sheet.rows.filter((_, k) => k !== i) })}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {sheet.cells !== undefined && (
        <ul className="tl-inspector__hint" aria-label="trim decal cells" title="Marks placed once on the sheet, drawn by decal materials (read from layout.json)">
          {sheet.cells.map((c) => {
            const [w, h] = trimCellMetres(sheet, c);
            return (
              <li key={c.name}>
                {c.name}: {c.rect[2]} × {c.rect[3]} px at {c.rect[0]}, {c.rect[1]} ({w.toFixed(2)} × {h.toFixed(2)} m)
              </li>
            );
          })}
        </ul>
      )}
      <div className="tl-inspector__modes">
        <button className="tl-btn tl-btn--small" onClick={addRow} title="A row below the last one">
          + row
        </button>
        <button className="tl-btn tl-btn--small" onClick={() => save({ ...sheet, rows: equalTrimRows(sheet.size[1], sheet.rows.map((r) => r.slot), sheet.padding) })} title="Split the sheet into equal rows again (the slots kept, in order)">
          Equal rows
        </button>
        <button className="tl-btn tl-btn--small" onClick={() => file.current?.click()} title="Read the row table of a Texture Designer trim export (layout.json)">
          Import layout.json
        </button>
        <input
          ref={file}
          type="file"
          accept=".json,application/json"
          aria-label="trim layout file"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f !== undefined) void importLayout(f);
          }}
        />
        <button className="tl-btn tl-btn--small" disabled={onCheck === undefined || material.textures['map'] === undefined} onClick={() => void runCheck()} title="Compare the albedo's padding pixels with each row's edge (on the backend)">
          Check padding
        </button>
      </div>
      {error !== null && (
        <div className="tl-assets__error" role="alert" aria-label="trim table error">
          {error}
        </div>
      )}
      {checked !== null && (
        <p className="tl-inspector__hint" aria-label="trim check">
          {checked}
        </p>
      )}
      <p className="tl-inspector__hint" aria-label="trim summary">
        Texture reads a pixel: 3. Sampling stops at mip level {safe}
        {safe > 0 ? ` (1/${2 ** safe} of the sheet's size)` : ''}.{missing.length > 0 ? ` Starter slots it lacks: ${missing.join(', ')}.` : ' It has every starter slot.'}
      </p>
      {problems.length > 0 && (
        <ul className="tl-inspector__hint" aria-label="trim warnings">
          {problems.map((p, i) => (
            <li key={i}>{p.slot === null ? p.message : `“${p.slot}”: ${p.message}`}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One whole number (or empty when optional), committed on Enter or blur; a value the field cannot take puts the stored one back. */
function NumberField({ label, value, onCommit, bare = false, optional = false }: { label: string; value: number | null; onCommit: (v: number | null) => boolean | void; bare?: boolean; optional?: boolean }): JSX.Element {
  const shown = value === null ? '' : String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = (): void => {
    const t = draft.trim();
    if (t === shown) return;
    if (t === '' && optional) {
      if (onCommit(null) === false) setDraft(shown);
      return;
    }
    const v = Number(t);
    if (t === '' || !Number.isFinite(v) || onCommit(v) === false) setDraft(shown);
  };
  const input = <input className="tl-input tl-input--num" aria-label={label} value={draft} placeholder={optional ? 'sheet' : undefined} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
  if (bare) return input;
  return (
    <label className="tl-field">
      <span className="tl-field__label">{label}</span>
      {input}
    </label>
  );
}

function TextField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => boolean | void }): JSX.Element {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (): void => {
    const t = draft.trim();
    if (t !== value && onCommit(t) === false) setDraft(value);
  };
  return <input className="tl-input" aria-label={label} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />;
}
