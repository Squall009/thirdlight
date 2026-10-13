/**
 * The decal atlas: a drawer along the decal editor's Scene view showing the
 * decal pages Play and the export will use (the backend plans them as the
 * build does): how many and how large, the share of their area no image
 * uses, their GPU memory, the images that set every page's size (with what
 * shrinking them gives), and each page with every decal image's rectangle —
 * hovering one names it, a click selects the decals that use it.
 *
 * Rebuild pages composes them now; the Scene view then draws the decals from
 * them, as Play does ("Scene view draws from the pages"), until an edit
 * changes what the pages hold.
 *
 * Browser-only (React).
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import type { DecalComponent, DecalPageReportPage, DecalPageReportRect } from '@thirdlight/project-model';

import { formatBytes, formatShare, offenderText } from '../../session/decal-atlas';
import type { DecalPaletteEntry } from '../../session/decal-editor';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { Toggle } from '../editmode/controls';
import { Glyph } from '../editmode/glyphs';
import type { SceneModeView } from '../editmode/modes';
import { cropStyle, useLayerThumb } from '../palette/LayerPalette';

export function AtlasDrawer({ host }: SceneModeView): JSX.Element {
  const atlas = host.decalAtlas;
  const tools = host.decals;
  const { setShown } = atlas;
  // The pages are read while the drawer shows.
  useEffect(() => {
    setShown(true);
    return () => setShown(false);
  }, [setShown]);
  const view = atlas.view;
  const report = view?.report ?? null;
  const names = useMemo(() => new Map(tools.materials.map((m) => [m.materialId, m.name])), [tools.materials]);
  const nameOf = (id: string): string => names.get(id) ?? id;
  const entryOf = useMemo(() => new Map(tools.palette.filter((e) => e.material !== null).map((e) => [e.material!, e])), [tools.palette]);
  // The decals each material is drawn on, and the selection's materials.
  const decalsOf = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const e of host.entities) {
      const m = (e.components['decal'] as DecalComponent | undefined)?.material;
      if (m !== undefined) out.set(m, [...(out.get(m) ?? []), e.id]);
    }
    return out;
  }, [host.entities]);
  const selectedMaterials = useMemo(() => new Set(tools.selected(host.entities).map((s) => s.decal.material)), [tools, host.entities]);
  const offender = report === null ? null : offenderText(report, nameOf);
  const offenders = new Set(report?.offender?.materials ?? []);
  const composed = view?.composed ?? null;
  const status = atlas.busy === 'composing' ? 'Composing the pages…' : composed !== null ? `Made in ${composed.ms} ms${composed.stats !== null ? ` (${composed.stats.composed} composed, ${composed.stats.cached + composed.stats.asStored} reused)` : ''}${atlas.drawFromPages ? ' · the Scene view draws from them' : ''}` : report !== null && report.pages.length > 0 ? 'Not composed: the Scene view draws each decal’s own textures' : '';
  const mark = report === null ? undefined : JSON.stringify({ size: report.size, pages: report.pages.length, images: report.images, materials: report.materials, unused: report.unused, gpuBytes: report.gpuBytes, composed: composed !== null, drawn: atlas.drawn !== null });

  return (
    <section className={`tl-atlas${atlas.open ? ' is-open' : ''}`} aria-label="decal atlas" data-atlas={mark}>
      <div className="tl-atlas__head">
        <span className="tl-atlas__title">
          <Glyph name="tiles" size={16} /> Decal atlas
        </span>
        <span className="tl-hint">What Play and the export use</span>
        <span className="tl-atlas__status" role="status">
          {status}
        </span>
        <Toggle label="Scene view draws from the pages" aria="scene view draws from the pages" on={atlas.drawFromPages} onChange={atlas.setDrawFromPages} hint="Draw the decals from the composed pages, as Play does (off: each decal material's own textures)" />
        <button type="button" className="tl-btn tl-btn--small tl-btn--primary" disabled={atlas.busy === 'composing' || report === null || report.pages.length === 0} onClick={() => void atlas.rebuild()} title="Compose the pages now (the next Play finds them made)">
          Rebuild pages
        </button>
        <button type="button" className="tl-iconbtn" aria-label={atlas.open ? 'close the decal atlas' : 'open the decal atlas'} aria-expanded={atlas.open} onClick={() => atlas.setOpen(!atlas.open)}>
          <Glyph name={atlas.open ? 'down' : 'up'} size={16} />
        </button>
      </div>
      {atlas.open && (
        <div className="tl-atlas__body">
          {atlas.error !== null && (
            <p className="tl-atlas__error" role="alert">
              {atlas.error}
            </p>
          )}
          {report === null ? (
            <p className="tl-hint">{atlas.error === null ? 'Reading the decal pages…' : ''}</p>
          ) : report.pages.length === 0 ? (
            <p className="tl-hint">No decal images to place: Play needs no decal pages.</p>
          ) : (
            <>
              <div className="tl-atlas__stats">
                <Stat label="Pages" value={String(report.pages.length)} sub={`${report.size}² each`} />
                <Stat label="Decals" value={`${report.images} image${report.images === 1 ? '' : 's'}`} sub={`${report.materials} material${report.materials === 1 ? '' : 's'}`} />
                <Stat label="Unused" value={formatShare(report.unused)} sub="of page area" />
                <Stat label="GPU memory" value={formatBytes(report.gpuBytes)} sub={`${report.maps} map${report.maps === 1 ? '' : 's'} · compressed`} />
                {offender !== null && (
                  <div className="tl-check tl-check--warn tl-atlas__check" role="note" aria-label="page size warning">
                    <Glyph name="warn" size={16} />
                    <div>
                      <b>{offender.title}</b>
                      <p>{offender.detail}</p>
                    </div>
                  </div>
                )}
                {report.notes.map((n) => (
                  <p key={n} className="tl-atlas__note">
                    {n}
                  </p>
                ))}
              </div>
              <div className="tl-atlas__pages" role="list" aria-label="decal pages">
                {report.pages.map((p) => (
                  <Page
                    key={p.page}
                    page={p}
                    size={report.size}
                    nameOf={nameOf}
                    entryOf={entryOf}
                    thumbnails={host.palette.thumbnails}
                    selected={selectedMaterials}
                    offenders={offenders}
                    onPick={(r) => {
                      const ids = r.materials.flatMap((m) => decalsOf.get(m) ?? []);
                      tools.select(ids, ids[0] ?? null);
                    }}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }): JSX.Element {
  return (
    <div className="tl-atlas__stat" aria-label={`atlas ${label.toLowerCase()}`}>
      <span>{label}</span>
      <b>{value}</b>
      <small>{sub}</small>
    </div>
  );
}

function Page(p: {
  page: DecalPageReportPage;
  size: number;
  nameOf: (id: string) => string;
  entryOf: ReadonlyMap<string, DecalPaletteEntry>;
  thumbnails: TileThumbnails | null;
  selected: ReadonlySet<string>;
  offenders: ReadonlySet<string>;
  onPick: (r: DecalPageReportRect) => void;
}): JSX.Element {
  const [hover, setHover] = useState<DecalPageReportRect | null>(null);
  const pct = (v: number): string => `${(v / p.size) * 100}%`;
  const label = (r: DecalPageReportRect): string => r.materials.map(p.nameOf).join(', ');
  return (
    <div className="tl-atlas__page" role="listitem" aria-label={`decal page ${p.page.page + 1}`}>
      <div className="tl-atlas__sheet">
        {p.page.rects.map((r) => {
          const state = r.materials.some((m) => p.selected.has(m)) ? ' is-selected' : r.materials.some((m) => p.offenders.has(m)) ? ' is-offender' : '';
          return (
            <button
              key={`${r.rect.join(',')}`}
              type="button"
              className={`tl-atlas__rect${state}`}
              style={{ left: pct(r.rect[0]), top: pct(r.rect[1]), width: pct(r.rect[2]), height: pct(r.rect[3]) }}
              title={`${label(r)} · ${r.source[0]} × ${r.source[1]} px · click to select its decals`}
              aria-label={`decal image ${label(r)}`}
              onMouseEnter={() => setHover(r)}
              onMouseLeave={() => setHover((h) => (h === r ? null : h))}
              onClick={() => p.onPick(r)}
            >
              <RectThumb entry={p.entryOf.get(r.materials[0]!) ?? null} thumbnails={p.thumbnails} />
            </button>
          );
        })}
      </div>
      <span className="tl-atlas__caption">{hover !== null ? `${label(hover)} · ${hover.source[0]} × ${hover.source[1]}` : `Page ${p.page.page + 1} · ${p.size}² · ${formatShare(p.page.unused)} unused`}</span>
    </div>
  );
}

/** A rectangle's picture: its material's palette picture (a cell as its part of the sheet). */
function RectThumb({ entry, thumbnails }: { entry: DecalPaletteEntry | null; thumbnails: TileThumbnails | null }): JSX.Element | null {
  const thumb = useLayerThumb(entry?.texture ?? null, thumbnails);
  if (thumb.url === null) return null;
  return entry?.crop !== undefined ? <span className="tl-atlas__img" style={cropStyle(thumb.url, entry.crop)} /> : <img className="tl-atlas__img" src={thumb.url} alt="" />;
}
