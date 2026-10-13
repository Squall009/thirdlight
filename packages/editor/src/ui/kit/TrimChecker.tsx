/**
 * The kit editor's trim checker: the kit's trim sheet with its row bounds
 * and gutters drawn over it (each row coloured by its checks' state), its
 * rows (slot, kind, height, pixels), and the trim sheet spec's checklist run
 * on it by the backend — the table's checks always, the pixels' (gutters
 * repeating their rows, seams at the wraps, height in A) once read.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { KitCheck, KitSheetReport } from '@thirdlight/project-model';

import type { TileThumbnails } from '../../viewport/thumbnails';
import { EmptyState } from '../chrome/EditorChrome';
import { CheckRow } from '../editmode/CheckRow';
import { Toggle } from '../editmode/controls';
import { useLayerThumb } from '../palette/LayerPalette';

const ORDER: Record<KitCheck['state'], number> = { err: 0, warn: 1, info: 2, ok: 3 };

const metres = (m: number): string => `${Number(m.toFixed(4))} m`;

/** A row label's height as a share of the drawn sheet (13 px on the ~290 px the checker shows the sheet at). */
const LABEL_SHARE = 0.045;
/** Label lanes across the sheet: a label that would cover the one above moves one lane right. */
const LABEL_LANES = 3;

/**
 * The lane of each row's label, so labels of thin rows (a baseboard, a
 * bevel: a few pixels tall when drawn) sit side by side instead of on top of
 * each other: the first lane whose last label ends above this row's top.
 */
function labelLanes(rows: readonly { top: number }[], height: number): number[] {
  const ends: number[] = [];
  return rows.map((r) => {
    const top = r.top / height;
    let lane = ends.findIndex((end) => end <= top);
    if (lane < 0) lane = ends.length < LABEL_LANES ? ends.length : ends.indexOf(Math.min(...ends));
    ends[lane] = top + LABEL_SHARE;
    return lane;
  });
}

export function TrimChecker(p: { sheet: KitSheetReport | null; hasSheet: boolean; albedo: string | null; thumbnails: TileThumbnails | null; onSpec: () => void }): JSX.Element {
  const [bounds, setBounds] = useState(true);
  const [gutters, setGutters] = useState(true);
  const thumb = useLayerThumb(p.albedo, p.thumbnails);
  const s = p.sheet;
  if (s === null) {
    return (
      <EmptyState kind="material" title={p.hasSheet ? 'Reading the trim sheet…' : 'No trim sheet yet'}>
        {p.hasSheet ? 'The checks of its rows and pixels show here.' : 'Pick the kit\'s trim sheet on the left (a trim material made to the trim sheet spec): its rows are checked here.'}
      </EmptyState>
    );
  }
  const [w, h] = s.trim.size;
  const checks = [...s.report.checks].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  const lanes = labelLanes(s.report.rows, h);
  return (
    <div className="tl-trimcheck" aria-label="trim checker">
      <div className="tl-trimcheck__head">
        <b>Trim checker · {s.name}</b>
        <span className="tl-hint">against the trim sheet spec{s.report.scale === 2 ? ' (4096² version)' : ''}</span>
        <span className="tl-editor-toolbar__spacer" />
        <Toggle label="Row bounds" on={bounds} onChange={setBounds} />
        <Toggle label="Gutters" on={gutters} onChange={setGutters} />
        <button type="button" className="tl-btn tl-btn--small" onClick={p.onSpec}>
          Open the spec
        </button>
      </div>
      <div className="tl-trimcheck__body">
        <div className="tl-trimcheck__sheet" aria-label="trim sheet with row bounds" data-thumb={thumb.state}>
          {thumb.url !== null ? <img src={thumb.url} alt="" draggable={false} /> : <span className="tl-hint">{p.albedo === null ? 'The material has no albedo map.' : 'Reading the picture…'}</span>}
          {s.report.rows.map((r, i) => (
            <div key={r.slot} className={`tl-trimcheck__row is-${r.state}${bounds ? '' : ' is-hidden'}`} style={{ top: `${(r.top / h) * 100}%`, height: `${((r.bottom - r.top) / h) * 100}%` }} data-row={r.slot}>
              {gutters && (
                <>
                  <span className="tl-trimcheck__gutter is-above" style={{ height: `${(s.trim.padding / (r.bottom - r.top)) * 100}%` }} />
                  <span className="tl-trimcheck__gutter is-below" style={{ height: `${(s.trim.padding / (r.bottom - r.top)) * 100}%` }} />
                </>
              )}
              {bounds && (
                <span className="tl-trimcheck__label" style={{ left: `calc(${(lanes[i]! * 100) / LABEL_LANES}% + 2px)` }} title={r.slot}>
                  {r.slot}
                </span>
              )}
            </div>
          ))}
        </div>
        <table className="tl-trimcheck__rows" aria-label="trim rows">
          <tbody>
            {s.report.rows.map((r, i) => (
              <tr key={r.slot} data-row={r.slot} data-state={r.state}>
                <td>
                  <span className={`tl-dot is-${r.state}`} aria-label={r.state} />
                </td>
                <td className="tl-trimcheck__slot" title={r.standard ? 'a standard slot of the spec' : 'a row of this sheet\'s own'}>
                  {r.slot}
                </td>
                <td>{r.kind}</td>
                <td>{metres(r.metres)}</td>
                <td>
                  {r.top}–{r.bottom} px
                </td>
              </tr>
            ))}
            {(s.trim.cells ?? []).length > 0 && (
              <tr data-row="cells">
                <td>
                  <span className="tl-dot is-ok" aria-label="ok" />
                </td>
                <td className="tl-trimcheck__slot">decal cells</td>
                <td>cells</td>
                <td>—</td>
                <td>{(s.trim.cells ?? []).length}</td>
              </tr>
            )}
          </tbody>
        </table>
        <div className="tl-trimcheck__checks" role="list" aria-label="trim sheet checks">
          {checks.map((c) => (
            <CheckRow key={c.id} id={c.id} state={c.state} title={c.title} detail={c.detail} />
          ))}
          <p className="tl-hint">
            {w}×{h} · {s.trim.texelDensity} px/m · gutters {s.trim.padding} px{s.imageRead ? ' · pixels read' : s.imageError !== undefined ? ` · pixels not read: ${s.imageError}` : ' · pixels not read yet (Check all)'}
          </p>
        </div>
      </div>
    </div>
  );
}
