/**
 * A terrain's edit layers in its tools: the stack its heights are combined
 * from, top first, with the hand-made ground (what the sculpt tools edit)
 * at the bottom. Each layer can be switched off, weighed (strength), moved
 * up or down and deleted; stamps layers list their stamps (each removable),
 * an erosion layer says how many tiles it changed, a blocks layer (the
 * ground meeting the scene's block layers) takes its mode, blend and whether
 * the blocks' paint carries across. Every change is one
 * `setComponent terrain` of the layer list: the backend combines the ground
 * again where the change reaches (one undo step).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import { TERRAIN_BLOCKS_BLEND_DEFAULT, TERRAIN_BLOCKS_BLEND_LIMITS, terrainLayerOrder, type TerrainBlocksLayer, type TerrainComponent, type TerrainLayer } from '@thirdlight/runtime';
import { freeLayerId } from '../session/terrain-brush';

interface Props {
  entityId: string;
  component: TerrainComponent;
  disabled: boolean;
  run: (what: string, op: string, args: Record<string, unknown>) => Promise<boolean>;
}

const KIND_LABEL: Record<TerrainLayer['kind'], string> = { stamps: 'Stamps', erosion: 'Erosion', splines: 'Splines', blocks: 'Blocks' };

const clamp01 = (v: number, fallback: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : fallback);

export function TerrainLayersPanel(p: Props): JSX.Element {
  const [busy, setBusy] = useState(false);
  // The stack as it applies (the splines on top when the list names none), drawn top first.
  const order = terrainLayerOrder(p.component);
  const listed = p.component.layers ?? [];
  const apply = async (what: string, next: TerrainLayer[]): Promise<void> => {
    setBusy(true);
    try {
      // The splines' place is stored only once it differs from "on top" or carries a setting.
      const last = next[next.length - 1];
      const plain = last !== undefined && last.kind === 'splines' && last.enabled !== false && (last.strength ?? 1) === 1 && last.name === undefined && !listed.some((l) => l.kind === 'splines');
      const value = plain ? next.slice(0, -1) : next;
      await p.run(what, 'setComponent', { entityId: p.entityId, component: 'terrain', value: { layers: value.length > 0 ? value : null } });
    } finally {
      setBusy(false);
    }
  };
  const update = (id: string, patch: (l: TerrainLayer) => TerrainLayer | null, what: string): void => {
    const next = order.map((l) => (l.id === id ? patch(l) : l)).filter((l): l is TerrainLayer => l !== null);
    void apply(what, next);
  };
  const move = (i: number, by: -1 | 1): void => {
    const j = i + by;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j]!, next[i]!];
    void apply('Move layer', next);
  };
  const add = (kind: 'stamps' | 'erosion' | 'blocks'): void => {
    // The ground meets the block layers over everything else (a road's end included); other new layers go under the splines.
    if (kind === 'blocks') {
      void apply('Add blocks layer', [...order, { id: freeLayerId(order, 'blocks'), kind }]);
      return;
    }
    const made: TerrainLayer = kind === 'stamps' ? { id: freeLayerId(order, 'stamps'), kind, stamps: [] } : { id: freeLayerId(order, 'erosion'), kind };
    const at = order.findIndex((l) => l.kind === 'splines');
    void apply('Add layer', at < 0 ? [...order, made] : [...order.slice(0, at), made, ...order.slice(at)]);
  };
  const setBlocks = (id: string, patch: Partial<TerrainBlocksLayer>, what: string): void => update(id, (x) => (x.kind === 'blocks' ? ({ ...x, ...patch } as TerrainLayer) : x), what);
  const off = p.disabled || busy;
  return (
    <div className="tl-blocks__form" role="group" aria-label="terrain layers">
      <div className="tl-panel__title">Layers</div>
      <ol className="tl-terrain-layers" reversed>
        {[...order].reverse().map((l) => {
          const i = order.indexOf(l);
          return (
            <li key={l.id} className="tl-terrain-layers__row" aria-label={`layer ${l.id}`}>
              <label title="Switch the layer on or off (off: it changes nothing)">
                <input type="checkbox" aria-label={`layer ${l.id} on`} disabled={off} checked={l.enabled !== false} onChange={(e) => update(l.id, (x) => ({ ...x, ...(e.target.checked ? { enabled: undefined } : { enabled: false }) }) as TerrainLayer, e.target.checked ? 'Layer on' : 'Layer off')} />{' '}
                {KIND_LABEL[l.kind]} <span className="tl-inspector__hint">{l.id}</span>
              </label>
              <label title="The share of the layer's change kept (0-1)">
                Strength{' '}
                <input
                  aria-label={`layer ${l.id} strength`}
                  type="number"
                  className="tl-blocks__num"
                  min={0}
                  max={1}
                  step={0.1}
                  disabled={off}
                  defaultValue={l.strength ?? 1}
                  key={`${l.id}:${l.strength ?? 1}`}
                  onBlur={(e) => {
                    const v = clamp01(Number(e.target.value), l.strength ?? 1);
                    if (v !== (l.strength ?? 1)) update(l.id, (x) => ({ ...x, strength: v === 1 ? undefined : v }) as TerrainLayer, 'Layer strength');
                  }}
                />
              </label>
              <button className="tl-btn tl-btn--small" aria-label={`layer ${l.id} up`} title="Apply after the layer above" disabled={off || i === order.length - 1} onClick={() => move(i, 1)}>
                ▲
              </button>
              <button className="tl-btn tl-btn--small" aria-label={`layer ${l.id} down`} title="Apply before the layer below" disabled={off || i === 0} onClick={() => move(i, -1)}>
                ▼
              </button>
              {l.kind !== 'splines' && (
                <button className="tl-btn tl-btn--small" aria-label={`delete layer ${l.id}`} title="Delete the layer (its stamps or erosion go; undo brings them back)" disabled={off} onClick={() => update(l.id, () => null, 'Delete layer')}>
                  ✕
                </button>
              )}
              {l.kind === 'stamps' && (
                <ul className="tl-terrain-layers__stamps">
                  {l.stamps.map((s, k) => (
                    <li key={k}>
                      <span className="tl-inspector__hint">
                        {s.asset} at {s.at[0].toFixed(1)}, {s.at[1].toFixed(1)} · {s.size} m · {s.height} m{s.mode !== undefined && s.mode !== 'add' ? ` · ${s.mode}` : ''}
                      </span>{' '}
                      <button className="tl-btn tl-btn--small" aria-label={`remove stamp ${k} of ${l.id}`} disabled={off} onClick={() => update(l.id, (x) => (x.kind === 'stamps' ? { ...x, stamps: x.stamps.filter((_s, j) => j !== k) } : x), 'Remove stamp')}>
                        ✕
                      </button>
                    </li>
                  ))}
                  {l.stamps.length === 0 && <li className="tl-inspector__hint">No stamps yet: the Stamp tool places them.</li>}
                </ul>
              )}
              {l.kind === 'blocks' && (
                <span className="tl-terrain-layers__blocks">
                  <label title="Under the blocks the ground is cut away (no hidden ground, no collider there) or flattened just below them (whole ground: scenery, or a stand-in where a streamed block area is not drawn)">
                    Under{' '}
                    <select aria-label={`layer ${l.id} mode`} disabled={off} value={l.mode ?? 'cut'} onChange={(e) => setBlocks(l.id, { mode: e.target.value === 'cut' ? undefined : 'flatten' }, 'Blocks layer mode')}>
                      <option value="cut">cut away</option>
                      <option value="flatten">flatten</option>
                    </select>
                  </label>{' '}
                  <label title="Metres over which the ground round the blocks fades from their border's height and paint to its own">
                    Blend{' '}
                    <input
                      aria-label={`layer ${l.id} blend`}
                      type="number"
                      className="tl-blocks__num"
                      min={TERRAIN_BLOCKS_BLEND_LIMITS.min}
                      max={TERRAIN_BLOCKS_BLEND_LIMITS.max}
                      step={1}
                      disabled={off}
                      defaultValue={l.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT}
                      key={`${l.id}:${l.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT}`}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        const now = l.blend ?? TERRAIN_BLOCKS_BLEND_DEFAULT;
                        if (!Number.isFinite(v) || v === now) return;
                        const clamped = Math.max(TERRAIN_BLOCKS_BLEND_LIMITS.min, Math.min(TERRAIN_BLOCKS_BLEND_LIMITS.max, v));
                        setBlocks(l.id, { blend: clamped === TERRAIN_BLOCKS_BLEND_DEFAULT ? undefined : clamped }, 'Blocks layer blend');
                      }}
                    />{' '}
                    m
                  </label>{' '}
                  <label title="The blocks' paint carries across the border onto the ground round them">
                    <input type="checkbox" aria-label={`layer ${l.id} paint`} disabled={off} checked={l.paint !== false} onChange={(e) => setBlocks(l.id, { paint: e.target.checked ? undefined : false }, 'Blocks layer paint')} /> paint
                  </label>{' '}
                  <span className="tl-inspector__hint">{l.blockLayers === undefined ? 'every block layer' : l.blockLayers.join(', ')}</span>
                </span>
              )}
              {l.kind === 'erosion' && <span className="tl-inspector__hint">{(l.tiles?.length ?? 0) === 0 ? 'Nothing eroded yet: the Erode tool runs it.' : `${l.tiles!.length} tile${l.tiles!.length === 1 ? '' : 's'} eroded`}</span>}
            </li>
          );
        })}
        <li className="tl-terrain-layers__row" aria-label="layer base">
          <span>Base</span> <span className="tl-inspector__hint">the ground as sculpted and painted by hand</span>
        </li>
      </ol>
      <div className="tl-inspector__modes">
        <button className="tl-btn tl-btn--small" aria-label="add stamps layer" disabled={off} onClick={() => add('stamps')}>
          Add stamps layer
        </button>
        <button className="tl-btn tl-btn--small" aria-label="add erosion layer" disabled={off} onClick={() => add('erosion')}>
          Add erosion layer
        </button>
        <button className="tl-btn tl-btn--small" aria-label="add blocks layer" title="The ground meets the scene's block layers: their border followed, cut away or flattened under them, their paint carried across" disabled={off || order.some((l) => l.kind === 'blocks')} onClick={() => add('blocks')}>
          Add blocks layer
        </button>
      </div>
    </div>
  );
}
