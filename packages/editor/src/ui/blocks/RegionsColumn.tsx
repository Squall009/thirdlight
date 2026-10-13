/**
 * The block editor's Regions mode: named regions of the layer (painted with
 * the Region tool, or made from the selection), each cut away in the game
 * or not (with a preview in the Scene view) and showing a theme of its own;
 * the theme over the whole layer; and the cell metadata — the metadata
 * brush (a field and its value, cells or a rectangle), the overlay that
 * colours fields in the view, and the fields every cell can carry.
 *
 * Region edits are `editBlocks` (one undo step each); a rename or delete
 * then lets the layer's cut-aways, themes and walk follow (one
 * `setComponent`). Cut-aways and themes are `setComponent`; the fields are
 * `setCellFields`.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { CellField, CellFieldType, CellMetaValue } from '@thirdlight/project-model';
import { blockKitNames } from '@thirdlight/runtime';

import { blockModeOf } from '../../session/block-mode';
import { isCutAway, themeOf, withCutaway, withRegionFollowed, withTheme } from '../../session/block-layer-edits';
import { enumColors, fieldColor, overlayLegend } from '../../session/block-overlay';
import { newBlockId } from '../../session/block-type-edits';
import { Section, Segmented, Toggle } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import type { EditModeView } from '../editmode/modes';
import { ToolGrid } from '../editmode/ToolGrid';
import { blockCommand, metaValueOf, useBlockSetup, useBlockTool, type BlockSetup } from './block-column';
import { pickedTile, toolKeysHint } from './BuildColumn';

const CELL_FIELD_TYPES: readonly { id: CellFieldType; label: string }[] = [
  { id: 'bool', label: 'Yes / no' },
  { id: 'enum', label: 'One of' },
  { id: 'int', label: 'Whole number' },
  { id: 'float', label: 'Number' },
  { id: 'string', label: 'Text' },
];

/** A change of the layer's own settings, made on the component as it is when sent. */
function store(s: BlockSetup, what: string, change: (c: BlockSetup['component']) => BlockSetup['component'] | null): Promise<boolean> {
  return s.blocks.changeLayer(what, s.entity.id, change);
}

function RegionRow({ s, regionId, boxes, themes }: { s: BlockSetup; regionId: string; boxes: number; themes: readonly string[] }): JSX.Element {
  const [rename, setRename] = useState<string | null>(null);
  const picked = s.state.region === regionId;
  const cut = isCutAway(s.component, regionId);
  const previewing = s.state.cutPreview.includes(regionId);
  const preview = (on: boolean): void => {
    s.blocks.editor?.previewCutaway(s.entity.id, regionId, on);
    s.set((st) => ({ cutPreview: on ? [...st.cutPreview, regionId] : st.cutPreview.filter((r) => r !== regionId) }));
  };
  const follow = (to: string | null): void => {
    const next = withRegionFollowed(s.component, regionId, to);
    if (previewing) preview(false);
    if (next !== null) void store(s, to === null ? 'Forget deleted region' : 'Follow renamed region', (c) => withRegionFollowed(c, regionId, to));
  };
  return (
    <li className={picked ? 'is-active' : ''}>
      {rename !== null ? (
        <input
          className="tl-input"
          aria-label={`rename region ${regionId}`}
          autoFocus
          value={rename}
          onChange={(e) => setRename(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setRename(null);
            }
            if (e.key !== 'Enter') return;
            const to = rename.trim();
            setRename(null);
            if (to === '' || to === regionId) return;
            void s.blocks.edit('Rename region', s.entity.id, [{ kind: 'region', regionId, op: 'rename', to }]).then((ok) => {
              if (!ok) return;
              if (picked) s.set({ region: to });
              follow(to);
            });
          }}
        />
      ) : (
        <button type="button" className="tl-blist__name" aria-label={`region ${regionId}`} title="Pick it for the Region tool; double-click to rename" onClick={() => s.set((st) => ({ region: regionId, tiles: { ...st.tiles, regions: 'region' } }))} onDoubleClick={() => setRename(regionId)}>
          {regionId} <small>{boxes} box{boxes === 1 ? '' : 'es'}</small>
        </button>
      )}
      <span className="tl-blist__tools">
        <label className="tl-blist__check" title="Cut away: in the game its cells fade out while the camera's target stands under it (the roof over a room)">
          <input type="checkbox" aria-label={`cut away ${regionId}`} checked={cut} onChange={(e) => {
              const on = e.target.checked;
              void store(s, on ? 'Cut away region' : 'Stop cutting region away', (c) => withCutaway(c, regionId, on)).then(() => !on && previewing && preview(false));
            }} />
          Cut away
        </label>
        {cut && (
          <button type="button" className={`tl-btn tl-btn--small${previewing ? ' is-active' : ''}`} aria-label={`preview cut-away ${regionId}`} aria-pressed={previewing} title="Show the Scene view as the game does while this region is cut away" onClick={() => preview(!previewing)}>
            Preview
          </button>
        )}
        {themes.length > 0 && (
          <select className="tl-input" aria-label={`theme ${regionId}`} title="The theme this region shows (over the layer's)" value={themeOf(s.component, regionId)} onChange={(e) => {
            const theme = e.target.value;
            void store(s, theme === '' ? 'Take region theme off' : `Region shows ${theme}`, (c) => withTheme(c, regionId, theme));
          }}>
            <option value="">Layer's theme</option>
            {themes.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="tl-icon-btn" aria-label={`rename ${regionId}`} title="Rename" onClick={() => setRename(regionId)}>
          ✎
        </button>
        <button type="button" className="tl-icon-btn" aria-label={`delete region ${regionId}`} title="Delete the region (its cells stay)" onClick={() => void s.blocks.edit('Delete region', s.entity.id, [{ kind: 'region', regionId, op: 'delete' }]).then((ok) => ok && follow(null))}>
          ✕
        </button>
      </span>
    </li>
  );
}

function RegionsSection({ s }: { s: BlockSetup }): JSX.Element {
  const regions = s.row?.regions ?? [];
  const themes = blockKitNames(s.blocks.types);
  const [draft, setDraft] = useState('');
  const sel = s.state.selection;
  const add = (): void => {
    const id = draft.trim();
    if (id === '') return;
    if (sel !== null) void s.blocks.edit('New region', s.entity.id, [{ kind: 'region', regionId: id, op: 'set', boxes: [[...sel]] }]).then((ok) => ok && setDraft(''));
    else {
      s.set((st) => ({ region: id, tiles: { ...st.tiles, regions: 'region' } }));
      setDraft('');
    }
  };
  return (
    <Section title="Regions" aside={<span className="tl-sec__note">{regions.length}</span>}>
      <Toggle label="Show their outlines" aria="show regions" on={s.state.showRegions} onChange={(on) => s.set({ showRegions: on })} />
      <ul className="tl-blist" aria-label="region list">
        {regions.map((r) => (
          <RegionRow key={r.regionId} s={s} regionId={r.regionId} boxes={r.boxes.length} themes={themes} />
        ))}
      </ul>
      <form
        className="tl-btnrow"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input className="tl-input" aria-label="new region" placeholder="Region name (zone1.start)" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="tl-btn tl-btn--small" disabled={draft.trim() === ''} title={sel !== null ? 'A new region of the selection' : 'A new region: paint it with the Region tool'}>
          + Region
        </button>
      </form>
      {sel !== null && s.state.region !== null && (
        <div className="tl-btnrow">
          <button type="button" className="tl-btn tl-btn--small" onClick={() => void s.blocks.edit('Add to region', s.entity.id, [{ kind: 'region', regionId: s.state.region!, op: 'add', boxes: [[...sel]] }])}>
            Add the selection to {s.state.region}
          </button>
          <button type="button" className="tl-btn tl-btn--small" onClick={() => void s.blocks.edit('Remove from region', s.entity.id, [{ kind: 'region', regionId: s.state.region!, op: 'remove', boxes: [[...sel]] }])}>
            Take it out
          </button>
        </div>
      )}
    </Section>
  );
}

function ThemeSection({ s }: { s: BlockSetup }): JSX.Element {
  const themes = blockKitNames(s.blocks.types);
  return (
    <Section title="Theme" aside={<span className="tl-sec__note">{themes.length === 0 ? 'none yet' : `${themes.length}`}</span>}>
      {themes.length === 0 ? (
        <p className="tl-hint">A theme draws every block as another type (winter, ruined…) without changing the cells. Give a block type a theme in its Themes section.</p>
      ) : (
        <div className="tl-frow">
          <span className="tl-frow__label">Layer shows</span>
          <select className="tl-input" aria-label="layer theme" value={themeOf(s.component, null)} onChange={(e) => {
            const theme = e.target.value;
            void store(s, theme === '' ? 'Take theme off' : `Show theme ${theme}`, (c) => withTheme(c, null, theme));
          }}>
            <option value="">The authored looks</option>
            {themes.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
      )}
    </Section>
  );
}

/** A field's value control by its type (a metadata brush value, a block type's default). */
export function MetaValueField({ field, value, onChange, aria }: { field: CellField; value: CellMetaValue | undefined; onChange: (v: CellMetaValue) => void; aria: string }): JSX.Element {
  if (field.type === 'bool') return <Segmented small aria={aria} value={value === true ? 'yes' : 'no'} options={[{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]} onChange={(v) => onChange(v === 'yes')} />;
  if (field.type === 'enum')
    return (
      <select className="tl-input" aria-label={aria} value={typeof value === 'string' ? value : (field.values?.[0] ?? '')} onChange={(e) => onChange(e.target.value)}>
        {(field.values ?? []).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  if (field.type === 'string') return <input className="tl-input" aria-label={aria} defaultValue={typeof value === 'string' ? value : ''} key={String(value)} onBlur={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
  return <input className="tl-input" type="number" aria-label={aria} step={field.type === 'int' ? 1 : 0.1} min={field.min} max={field.max} defaultValue={typeof value === 'number' ? value : 0} key={String(value)} onBlur={(e) => Number.isFinite(Number(e.target.value)) && onChange(field.type === 'int' ? Math.round(Number(e.target.value)) : Number(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />;
}

function MetadataSection({ s }: { s: BlockSetup }): JSX.Element {
  const fields = s.blocks.fields;
  const m = s.state.meta;
  const field = fields.find((f) => f.key === m.field);
  const value = metaValueOf(s);
  const shown = new Set(s.state.shown);
  const legend = overlayLegend(fields, shown);
  const setMeta = (patch: Partial<typeof m>): void => s.set((st) => ({ meta: { ...st.meta, ...patch } }));
  return (
    <Section title="Metadata" aside={<span className="tl-sec__note">{fields.length} field{fields.length === 1 ? '' : 's'}</span>}>
      {fields.length === 0 ? (
        <p className="tl-hint">No cell fields yet. A field is data every cell can carry (walkable, slippery, cost…): add one below.</p>
      ) : (
        <>
          <div className="tl-frow">
            <span className="tl-frow__label">Paint field</span>
            <select className="tl-input" aria-label="metadata field" value={m.field} onChange={(e) => setMeta({ field: e.target.value, raw: '' })}>
              <option value="">(pick a field)</option>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label ?? f.key}
                </option>
              ))}
            </select>
          </div>
          {field !== undefined && (
            <>
              <div className="tl-frow">
                <span className="tl-frow__label">Value</span>
                {m.erase ? <span className="tl-hint">cleared (the defaults show)</span> : <MetaValueField field={field} aria="metadata value" value={value.ok ? (value.value ?? undefined) : undefined} onChange={(v) => setMeta({ raw: String(v) })} />}
              </div>
              <Toggle label="Clear the value instead" aria="clear metadata" on={m.erase} onChange={(on) => setMeta({ erase: on })} />
              <div className="tl-frow">
                <span className="tl-frow__label">Shape</span>
                <Segmented small aria="metadata shape" value={m.shape} options={[{ id: 'cells', label: 'Cells' }, { id: 'rect', label: 'Rectangle' }]} onChange={(v) => setMeta({ shape: v })} />
              </div>
              <Toggle label="Only cells that hold something" aria="occupied only" on={m.occupiedOnly} onChange={(on) => setMeta({ occupiedOnly: on })} hint="Off: empty cells become metadata-only cells." />
              {!value.ok && <p className="tl-prop__error">{value.message}</p>}
            </>
          )}
          <div className="tl-sec__sub">Show in the view</div>
          <div className="tl-chips" aria-label="overlay fields">
            {fields.map((f) => (
              <button key={f.key} type="button" className={`tl-chip tl-chip--toggle${shown.has(f.key) ? ' is-active' : ''}`} aria-label={`overlay ${f.key}`} aria-pressed={shown.has(f.key)} onClick={() => s.set((st) => ({ shown: st.shown.includes(f.key) ? st.shown.filter((k) => k !== f.key) : [...st.shown, f.key] }))}>
                <span className="tl-chip__dot" style={{ background: f.type === 'enum' ? Object.values(enumColors(f))[0] : fieldColor(f) }} />
                {f.label ?? f.key}
              </button>
            ))}
          </div>
          {legend.length > 0 && (
            <div className="tl-blegend" aria-label="overlay legend">
              {legend.map((l) => (
                <div key={l.key}>
                  <b>{l.label}</b>{' '}
                  {l.entries.map((e) => (
                    <span key={e.label} className="tl-blegend__entry">
                      <span className="tl-chip__dot" style={{ background: e.color }} />
                      {e.label}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <CellFields s={s} />
    </Section>
  );
}

/** The fields every cell can carry: each one's label, type, values, default, colour and range, all editable. */
function CellFields({ s }: { s: BlockSetup }): JSX.Element {
  const fields = s.blocks.fields;
  const save = (next: readonly CellField[], what = 'Edit cell field'): void => void blockCommand(s, what, 'setCellFields', { fields: next });
  const edit = (i: number, patch: Partial<CellField>): void => {
    const f = { ...fields[i]!, ...patch } as CellField;
    for (const k of Object.keys(f) as (keyof CellField)[]) if (f[k] === undefined) delete f[k];
    // A type change keeps only what the new type reads.
    if (patch.type !== undefined) {
      delete f.default;
      if (patch.type !== 'enum') delete f.values;
      else f.values = f.values ?? ['a', 'b'];
      if (patch.type !== 'int' && patch.type !== 'float') {
        delete f.min;
        delete f.max;
      }
    }
    save(fields.map((x, j) => (j === i ? f : x)));
  };
  return (
    <details className="tl-bdetails">
      <summary>Cell fields ({fields.length})</summary>
      {fields.map((f, i) => (
        <div key={f.key} className="tl-bfield" aria-label={`cell field ${f.key}`}>
          <div className="tl-frow">
            <span className="tl-frow__label">{f.key}</span>
            <input className="tl-input" aria-label={`field ${f.key} label`} placeholder="Label" defaultValue={f.label ?? ''} key={f.label ?? ''} onBlur={(e) => e.target.value !== (f.label ?? '') && edit(i, { label: e.target.value === '' ? undefined : e.target.value })} />
            <input type="color" aria-label={`field ${f.key} colour`} value={f.color ?? fieldColor(f)} onChange={(e) => edit(i, { color: e.target.value })} title="Its colour in the overlay" />
            <button type="button" className="tl-icon-btn" aria-label={`delete field ${f.key}`} title="Delete the field (cells lose its values)" onClick={() => save(fields.filter((_x, j) => j !== i), 'Delete cell field')}>
              ✕
            </button>
          </div>
          <div className="tl-frow">
            <span className="tl-frow__label">Type</span>
            <select className="tl-input" aria-label={`field ${f.key} type`} value={f.type} onChange={(e) => edit(i, { type: e.target.value as CellFieldType })}>
              {CELL_FIELD_TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          {f.type === 'enum' && (
            <div className="tl-frow">
              <span className="tl-frow__label">Values</span>
              <input className="tl-input" aria-label={`field ${f.key} values`} placeholder="grass, stone, water" defaultValue={(f.values ?? []).join(', ')} key={(f.values ?? []).join(',')} onBlur={(e) => edit(i, { values: e.target.value.split(',').map((v) => v.trim()).filter((v) => v !== '') })} />
            </div>
          )}
          {(f.type === 'int' || f.type === 'float') && (
            <div className="tl-frow">
              <span className="tl-frow__label">Range</span>
              <input className="tl-input" type="number" aria-label={`field ${f.key} min`} placeholder="min" defaultValue={f.min ?? ''} key={`min${f.min ?? ''}`} onBlur={(e) => edit(i, { min: e.target.value === '' ? undefined : Number(e.target.value) })} />
              <input className="tl-input" type="number" aria-label={`field ${f.key} max`} placeholder="max" defaultValue={f.max ?? ''} key={`max${f.max ?? ''}`} onBlur={(e) => edit(i, { max: e.target.value === '' ? undefined : Number(e.target.value) })} />
            </div>
          )}
          <div className="tl-frow">
            <span className="tl-frow__label">Default</span>
            <MetaValueField field={f} aria={`field ${f.key} default`} value={f.default} onChange={(v) => edit(i, { default: v })} />
          </div>
        </div>
      ))}
      <button type="button" className="tl-btn tl-btn--small" onClick={() => save([...fields, { key: newBlockId('field', fields.map((f) => f.key)).replace(/-/g, '_'), type: 'bool' }], 'New cell field')}>
        + Cell field
      </button>
    </details>
  );
}

export function RegionsColumn({ entity, host }: EditModeView): JSX.Element {
  const s = useBlockSetup(entity, host);
  const tile = pickedTile(s, 'regions');
  useBlockTool(s, tile.tool);
  const mode = blockModeOf('regions');
  useEditStatus({
    tool: tile.label,
    text: tile.tool === 'region' ? (s.state.region === null ? 'Pick or make a region below, then drag rectangles to add to it.' : `Drag a rectangle to add it to ${s.state.region} (Ctrl held: take it out).`) : metaValueOf(s).ok ? tile.hint : 'Pick a field to paint below.',
    keys: [...toolKeysHint(mode.tiles), ...(tile.tool === 'region' ? [{ keys: ['Ctrl'], label: 'Take out' }] : [])],
    right: s.state.hover,
  });
  return (
    <div className="tl-bcol" aria-label="block region tools">
      <Section title="Tool">
        <ToolGrid tools={mode.tiles} active={tile.id} onPick={(id) => s.set((st) => ({ tiles: { ...st.tiles, regions: id } }))} aria="region tool" cols={4} disabled={s.locked} />
        <p className="tl-hint">{tile.hint}</p>
      </Section>
      <RegionsSection s={s} />
      <ThemeSection s={s} />
      <MetadataSection s={s} />
    </div>
  );
}
