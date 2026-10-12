/**
 * An object's material layers in an edit mode's settings column: the layer
 * palette of the material it draws with (its "*" mapping), with what the
 * palette edits on that material — a texture into a layer's slots (dropped
 * on a tile, or picked in the texture browser: the project window lies
 * under the mode), its normal map and ORM filled from textures named alike
 * (`texture-sets.ts`); the layer's textures, name and settings in a popover —
 * and "Set up material" when it has no material: a new layered material,
 * given to the object in the same command (one undo step). When its
 * material doesn't read layer weights (`materialReads`), painting would draw
 * nothing on it: the section says so first, with "Make it paintable" — a
 * layered material whose base layer wears the old material's maps, given
 * the same way.
 *
 * Without a layered material the palette shows the colours the object draws
 * meanwhile, named as such, and the button is the first thing in the section.
 *
 * Browser-only (React).
 */
import { useMemo, useState, type JSX } from 'react';
import { MAX_TEXTURE_LAYERS } from '@thirdlight/project-model/limits';
import type { MaterialDef } from '@thirdlight/project-model';
import { materialReads } from '@thirdlight/project-model/material-reads';

import type { Catalog } from '../../session/catalog';
import { paintableMaterial, paletteLayers, paletteSource, standInLayers, trimSheetMaterials, withLayerSetting, withSlotTexture, type LayerTextureKey, type PaletteLayer, type PaletteSource } from '../../session/layer-palette';
import { LAYERED_TEXTURES, TEMPLATE_LAYERS } from '../../session/material-graph';
import { matchingTexture, textureSetQuery } from '../../session/texture-sets';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { useAssetSummaries, useCatalog } from '../catalog/catalog-context';
import { TEXTURE_KINDS } from '../catalog/RefPicker';
import { Section } from '../editmode/controls';
import { LayerPalette, Popover } from './LayerPalette';
import { LayerFields } from './LayerSettings';
import { LayerTextures } from './LayerTextures';
import { TextureBrowser } from './TextureBrowser';

/** How many textures named like a colour map are read to find its set (the first page of matches). */
const SET_CANDIDATES = 50;

/**
 * The material after a layer took a colour texture: its normal and ORM slots
 * filled from textures named alike when the project has them (left as they
 * are when it has none).
 */
async function withTextureSet(m: MaterialDef, layer: number, albedoId: string, catalog: Catalog | null): Promise<MaterialDef> {
  if (catalog === null) return m;
  const [albedo] = await catalog.entries([albedoId], TEXTURE_KINDS);
  const stem = albedo === undefined ? null : textureSetQuery(albedo.name);
  if (albedo === undefined || stem === null) return m;
  const { entries } = await catalog.page({ kinds: TEXTURE_KINDS, text: stem }, 0, SET_CANDIDATES);
  let out = m;
  for (const key of [LAYERED_TEXTURES.normals, LAYERED_TEXTURES.orm] as const) {
    const id = matchingTexture(albedo.name, key === LAYERED_TEXTURES.normals ? 'normals' : 'orm', entries);
    if (id !== null) out = withSlotTexture(out, layer, id, key);
  }
  return out;
}

/** What the palette needs from the app. */
export interface PaletteHost {
  readonly thumbnails: TileThumbnails | null;
  readonly materials: readonly MaterialDef[];
  /** One command (true: stored). */
  run(what: string, op: string, args: Record<string, unknown>): Promise<boolean>;
  /** A free material id for a new material of this name. */
  newMaterialId(name: string): Promise<string>;
  /** Open a material in the editor window. */
  openMaterial(materialId: string): void;
}

/** An object's palette: where its layers come from and the tiles. */
export interface Palette {
  readonly source: PaletteSource;
  readonly layers: readonly PaletteLayer[];
  /** The slot textures' names (by texture id). */
  readonly names: ReadonlyMap<string, string>;
}

/** The palette of an object with this material mapping (`standIn`: the colours it draws without a layered material). */
export function usePalette(mapping: Readonly<Record<string, string>> | undefined, materials: readonly MaterialDef[], standIn: readonly string[]): Palette {
  const source = useMemo(() => paletteSource(mapping, materials), [mapping, materials]);
  const albedo = source.kind === 'none' ? undefined : (source.material.parameters ?? []).find((p) => p.key === LAYERED_TEXTURES.albedo)?.default;
  const ids = useMemo(() => (Array.isArray(albedo) ? [...new Set((albedo as string[]).filter((x) => x !== ''))] : typeof albedo === 'string' && albedo !== '' ? [albedo] : []), [albedo]);
  const summaries = useAssetSummaries(ids);
  const names = new Map<string, string>();
  ids.forEach((id, i) => {
    const s = summaries[i];
    if (s !== undefined) names.set(id, s.displayName);
  });
  const arrayLayers = typeof albedo === 'string' && albedo !== '' ? (summaries[0]?.image?.layers ?? 1) : null;
  const key = [...names].join('|');
  const layers = useMemo(
    // A material without layers: the tiles are stand-ins, though the object has a material.
    () => (source.kind === 'none' ? standInLayers(standIn, source.material === null ? 'no material' : 'stand-in') : paletteLayers(source.material, (id) => names.get(id), arrayLayers)),
    // `key` stands for the names read so far.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `names` is rebuilt each draw; `key` names its content
    [source, standIn, key, arrayLayers],
  );
  return { source, layers, names };
}

export interface MaterialLayersProps {
  entityId: string;
  entityName: string;
  palette: Palette;
  /** The picked layer (the one painted). */
  active: number;
  onPick: (index: number) => void;
  host: PaletteHost;
  disabled?: boolean;
  /** Metres per repeat the layers of a material set up here start at (absent: the template's). */
  layerTiling?: number;
}

/** The "Layers" section of a column: the palette, its material, the picked layer's settings, or "Set up material". */
export function MaterialLayers(p: MaterialLayersProps): JSX.Element {
  const { source, layers } = p.palette;
  const { catalog } = useCatalog();
  const [chooser, setChooser] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const [settings, setSettings] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (m: MaterialDef, what = 'Layer'): void => void p.host.run(what, 'setMaterial', { material: m });
  const setUp = async (): Promise<void> => {
    setBusy(true);
    try {
      const name = `${p.entityName} layers`;
      const id = await p.host.newMaterialId(name);
      let material = paintableMaterial(source.kind === 'none' ? source.material : null, id, name);
      const tiling = p.layerTiling;
      if (tiling !== undefined) for (let l = 0; l < TEMPLATE_LAYERS; l++) material = withLayerSetting(material, 'layerTiling', l, tiling);
      await p.host.run('Set up material', 'setMaterial', { material, assign: { entityId: p.entityId } });
    } finally {
      setBusy(false);
    }
  };
  if (source.kind === 'none') {
    const own = source.material;
    // A graph that mixes its own layers by the weights paints by layer number, though the palette can't show its layers.
    if (own !== null && materialReads(own, 'layerWeights', { materials: p.host.materials })) {
      return (
        <Section title="Layers" aside={<span className="tl-tag">{own.name}</span>}>
          <p className="tl-inspector__hint">"{own.name}" mixes layers of its own graph by the painted weights: paint picks its layers by number. Open it in the material editor to change them.</p>
          <LayerPalette layers={layers} active={p.active} onPick={p.onPick} thumbnails={p.host.thumbnails} keys aria="layers" />
        </Section>
      );
    }
    return (
      <Section title="Layers" aside={<span className="tl-tag">{own === null ? 'no material' : 'not paintable'}</span>}>
        <div className={`tl-palette-setup${own !== null ? ' is-warning' : ''}`} role="note" aria-label={own === null ? 'no layered material' : 'material does not read paint'}>
          <p>
            {own === null ? (
              <>{p.entityName} has no layered material yet, so it paints these stand-in colours. Set up a material, then drop a texture on each layer.</>
            ) : (
              <>
                <b>"{own.name}" doesn't read paint</b> (layer weights), so painting draws nothing on {p.entityName}.{' '}
                {own.graph === undefined && own.textures['map'] !== undefined ? `Make it paintable: a layered material whose first layer keeps "${own.name}"'s textures.` : 'Make it paintable: a layered material, then drop a texture on each layer.'}
              </>
            )}
          </p>
          <button type="button" className="tl-btn tl-btn--primary" aria-label={own === null ? 'set up material' : 'make it paintable'} disabled={busy || p.disabled === true} onClick={() => void setUp()}>
            {busy ? 'Setting up…' : own === null ? 'Set up material' : 'Make it paintable'}
          </button>
        </div>
        <LayerPalette layers={layers} active={p.active} onPick={p.onPick} thumbnails={p.host.thumbnails} keys aria="layers" />
      </Section>
    );
  }
  const m = source.material;
  const editable = source.kind === 'layered' && p.disabled !== true;
  const slotted = source.kind === 'layered' && source.slots !== 'array';
  /** A texture into a layer's slot of one array; a colour texture brings its set's other maps along (one command). */
  const put = (index: number, textureId: string, key: LayerTextureKey = LAYERED_TEXTURES.albedo): void => {
    p.onPick(index);
    void (async () => {
      // The material as the project shows it now (two quick drops both count: each command waits for the one before).
      const now = p.host.materials.find((x) => x.materialId === m.materialId) ?? m;
      const one = withSlotTexture(now, index, textureId, key);
      save(key === LAYERED_TEXTURES.albedo && textureId !== '' ? await withTextureSet(one, index, textureId, catalog) : one, 'Layer texture');
    })();
  };
  const picked = layers.find((l) => l.index === p.active);
  const chip = (
    <button type="button" className="tl-matchip" aria-label="open material" title={`Open "${m.name}" in the material editor`} onClick={() => p.host.openMaterial(source.kind === 'instance' ? source.parent : m.materialId)}>
      {m.name}
    </button>
  );
  return (
    <Section title="Layers" aside={chip}>
      <LayerPalette
        layers={layers}
        active={p.active}
        onPick={p.onPick}
        thumbnails={p.host.thumbnails}
        keys
        aria="layers"
        {...(editable && slotted ? { onDropTexture: put, onChooseTexture: (index: number, anchor: HTMLElement) => setChooser({ index, anchor }), add: layers.length < MAX_TEXTURE_LAYERS } : {})}
      />
      {source.kind === 'instance' && <p className="tl-inspector__hint">An instance of "{m.name}": its layers are its parent's. Open the parent to change them.</p>}
      {source.kind === 'layered' && source.slots === 'array' && <p className="tl-inspector__hint">Its layers are one prebuilt texture array: change its textures in the material, the names and settings here.</p>}
      <div className="tl-palette-picked" aria-label="picked layer">
        <span>
          {picked !== undefined ? <b>{picked.name}</b> : <b>Layer {p.active + 1}</b>} · layer {p.active + 1}
          {picked?.sub !== undefined ? ` · ${picked.sub}` : picked === undefined ? ' (the material has no such layer)' : ''}
        </span>
        {source.kind === 'layered' && (
          <button type="button" className="tl-btn tl-btn--small" aria-label="layer settings" aria-expanded={settings !== null} disabled={p.disabled} onClick={(e) => setSettings(settings === null ? e.currentTarget : null)}>
            Layer settings…
          </button>
        )}
      </div>
      {chooser !== null && (
        <Popover anchor={chooser.anchor} onClose={() => setChooser(null)} aria="choose layer texture" title={`Texture for layer ${chooser.index + 1}`} aside={m.name}>
          <TextureBrowser
            aria={`layer ${chooser.index + 1} texture`}
            value={null}
            thumbnails={p.host.thumbnails}
            autoFocus
            onPick={(id) => {
              put(chooser.index, id);
              setChooser(null);
            }}
          />
          <p className="tl-hint">Its normal map and ORM come along when the project has textures named alike (rock_albedo, rock_normal, rock_orm).</p>
        </Popover>
      )}
      {settings !== null && source.kind === 'layered' && (
        <Popover anchor={settings} onClose={() => setSettings(null)} aria="layer settings" title={`Layer ${p.active + 1}${picked !== undefined ? ` · ${picked.name}` : ''}`} aside={m.name}>
          {slotted && <LayerTextures material={m} layer={p.active} thumbnails={p.host.thumbnails} disabled={!editable} onPick={(key, id) => put(p.active, id, key)} />}
          <LayerFields key={p.active} material={m} layer={p.active} textureName={picked?.texture != null ? (p.palette.names.get(picked.texture) ?? null) : null} sheets={trimSheetMaterials(p.host.materials)} onSave={(x) => save(x)} />
        </Popover>
      )}
    </Section>
  );
}
