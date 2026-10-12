/**
 * The terrain editor's Settings: the tile size (samples a side and the
 * metres between them), the height range its samples span, the detail
 * distance and the far ground's macro texture, collision. Each change is one
 * `setComponent terrain`.
 *
 * The tile size is fixed once a tile holds data (the samples would no longer
 * line up); the height range can change any time, but the samples keep
 * their 16-bit steps, so every height scales with it — said beside it.
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import { TERRAIN_HEIGHT_LIMIT, TERRAIN_LOD_DISTANCE_LIMITS, TERRAIN_MACRO_DISTANCE_LIMITS, TERRAIN_SPACING_LIMITS, TERRAIN_TILE_SAMPLES, terrainTileSize, type TerrainComponent } from '@thirdlight/runtime';

import { RangeField } from '../brush/RangeField';
import { useSettledEdits } from '../brush/settle';
import { SliderField } from '../brush/SliderField';
import { Section, Toggle } from '../editmode/controls';
import { useEditStatus } from '../editmode/edit-status';
import { useTerrainTool, type TerrainColumnProps } from './terrain-column';

/** The settings set with a slider (stored once it rests). */
const SLIDER_KEYS = ['spacing', 'lodDistance', 'macroDistance'] as const;
type SliderKey = (typeof SLIDER_KEYS)[number];

/** Cached per component, so the settled edits see one stored value until the component changes. */
const sliderCache = new WeakMap<TerrainComponent, Partial<Record<SliderKey, number>>>();
function sliderValues(c: TerrainComponent): Partial<Record<SliderKey, number>> {
  let v = sliderCache.get(c);
  if (v === undefined) {
    v = { spacing: c.spacing, ...(c.lodDistance !== undefined ? { lodDistance: c.lodDistance } : {}), ...(c.macroDistance !== undefined ? { macroDistance: c.macroDistance } : {}) };
    sliderCache.set(c, v);
  }
  return v;
}

/** Metres the detail and macro distances start at when switched on. */
const DETAIL_START = 256;
const MACRO_START = 400;

export function SettingsColumn(p: TerrainColumnProps): JSX.Element {
  useTerrainTool(p, null);
  const c = p.component;
  const set = (what: string, value: Partial<Record<keyof TerrainComponent, unknown>>): void => void p.run(what, 'setComponent', { entityId: p.entityId, component: 'terrain', value });
  // The sliders' fields wait and are stored together, each only when it differs from what the project holds.
  const edits = useSettledEdits<Partial<Record<SliderKey, number>>>(sliderValues(c), (next, what) => {
    const now = sliderValues(p.component);
    const changed = Object.fromEntries(SLIDER_KEYS.filter((k) => next[k] !== now[k]).map((k) => [k, next[k]]));
    return Object.keys(changed).length === 0 ? true : p.run(what, 'setComponent', { entityId: p.entityId, component: 'terrain', value: changed });
  });
  const slide = (key: SliderKey, what: string) => (v: number): void => edits.edit(key, what, (x) => ({ ...x, [key]: v }));
  const shownSliders = edits.value;
  const hasData = c.tiles.some((t) => t.data !== undefined);
  const off = p.locked;
  const [range, setRange] = useState<[number, number] | null>(null);
  const shown = range ?? [c.heightRange[0], c.heightRange[1]];
  // The track reaches well past the stored range (from it, not the draft, so it holds still while dragged); typing goes to the limit.
  const track = Math.max(1000, 10 ** Math.ceil(Math.log10(2 * Math.max(Math.abs(c.heightRange[0]), Math.abs(c.heightRange[1]), 1))));
  useEditStatus({ tool: 'Settings', text: 'The terrain\'s tile size, height range, detail and collision.', right: `${c.tiles.length} tiles of ${terrainTileSize(c)} m` });
  return (
    <div className="tl-terrain" aria-label="terrain tools">
      <Section title="Tile size" aside={`${terrainTileSize(c)} m a tile`}>
        <div className="tl-frow" title="Samples along a tile side (2^n + 1): more is finer ground and more memory.">
          <span className="tl-frow__label">Samples a side</span>
          <select className="tl-input" aria-label="tile samples" value={c.tileSamples} disabled={off || hasData} onChange={(e) => set('Tile samples', { tileSamples: Number(e.target.value) })}>
            {TERRAIN_TILE_SAMPLES.map((n) => (
              <option key={n} value={n}>
                {n} ({Math.round((n - 1) * c.spacing)} m a tile)
              </option>
            ))}
          </select>
        </div>
        <SliderField label="Spacing" aria="sample spacing" value={shownSliders.spacing ?? c.spacing} min={TERRAIN_SPACING_LIMITS.min} max={8} log limit={[TERRAIN_SPACING_LIMITS.min, TERRAIN_SPACING_LIMITS.max]} step={0.05} unit="m" hint="Metres between samples." disabled={off || hasData} onChange={slide('spacing', 'Sample spacing')} />
        {hasData && <p className="tl-hint">Fixed now that tiles hold ground: the samples would no longer line up.</p>}
      </Section>
      <Section title="Heights">
        <RangeField
          label="Range"
          aria="height range"
          closed
          value={{ min: shown[0], max: shown[1] }}
          min={-track}
          max={track}
          limit={[-TERRAIN_HEIGHT_LIMIT, TERRAIN_HEIGHT_LIMIT]}
          step={1}
          unit="m"
          hint="The lowest and highest height a sample can hold, metres above the terrain object (a narrower range is finer)."
          disabled={off}
          onChange={(v) => setRange([v.min ?? shown[0], v.max ?? shown[1]])}
        />
        <div className="tl-frow">
          <span className="tl-frow__label" />
          <button
            type="button"
            className="tl-btn tl-btn--small"
            aria-label="set height range"
            disabled={off || range === null || !(range[0] < range[1]) || Math.abs(range[0]) > TERRAIN_HEIGHT_LIMIT || Math.abs(range[1]) > TERRAIN_HEIGHT_LIMIT}
            onClick={() => {
              if (range !== null) set('Height range', { heightRange: range });
              setRange(null);
            }}
          >
            Set the range
          </button>
        </div>
        <p className="tl-hint">{hasData ? 'Heights are stored as steps of this range: changing it scales every height with it.' : `Steps of ${(((shown[1] - shown[0]) / 65535) * 1000).toFixed(1)} mm.`}</p>
      </Section>
      <Section title="Detail">
        <Toggle label="Own detail distance" aria="detail distance on" hint="How far the finest level of detail reaches (off: the nearest the tile size allows)." disabled={off} on={c.lodDistance !== undefined} onChange={(on) => set('Detail distance', { lodDistance: on ? DETAIL_START : null })} />
        {c.lodDistance !== undefined && <SliderField label="Finest within" aria="detail distance" value={shownSliders.lodDistance ?? c.lodDistance} min={16} max={4096} log limit={[TERRAIN_LOD_DISTANCE_LIMITS.min, TERRAIN_LOD_DISTANCE_LIMITS.max]} step={1} unit="m" hint="Each coarser level reaches twice as far." disabled={off} onChange={slide('lodDistance', 'Detail distance')} />}
        <Toggle label="Far ground from a baked texture" aria="macro distance on" hint="Past a distance each tile draws its look baked from above: two texture reads instead of its layers." disabled={off} on={c.macroDistance !== undefined} onChange={(on) => set('Macro distance', { macroDistance: on ? MACRO_START : null })} />
        {c.macroDistance !== undefined && <SliderField label="Past" aria="macro distance" value={shownSliders.macroDistance ?? c.macroDistance} min={50} max={8000} log limit={[TERRAIN_MACRO_DISTANCE_LIMITS.min, TERRAIN_MACRO_DISTANCE_LIMITS.max]} step={10} unit="m" disabled={off} onChange={slide('macroDistance', 'Macro distance')} />}
      </Section>
      <Section title="Collision">
        <Toggle label="The ground collides" aria="terrain collision" hint="The tiles are heightfield colliders in a 3D game; off for scenery the player never reaches." disabled={off} on={c.collision !== false} onChange={(on) => set('Collision', { collision: on ? null : false })} />
      </Section>
    </div>
  );
}
