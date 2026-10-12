/**
 * An object's material layers in an edit mode's settings column: the layer
 * palette of the material it draws with (its "*" mapping), with what the
 * palette edits on that material — a texture into a layer's slot (dropped
 * from the project window or picked), the layer's name and settings in a
 * popover — and "Set up material" when it has no layered material: a new
 * material from the Height-blended layers template, given to the object in
 * the same command (one undo step).
 *
 * Without a layered material the palette shows the colours the object draws
 * meanwhile, named as such, and the button is the first thing in the section.
 *
 * Browser-only (React).
 */
import { useMemo, useState, type JSX } from 'react';
import { MAX_TEXTURE_LAYERS } from '@thirdlight/project-model/limits';
import type { MaterialDef } from '@thirdlight/project-model';

import { paletteLayers, paletteSource, standInLayers, withSlotTexture, type PaletteLayer, type PaletteSource } from '../../session/layer-palette';
import { LAYERED_TEXTURES, templateMaterial } from '../../session/material-graph';
import type { TileThumbnails } from '../../viewport/thumbnails';
import { useAssetSummaries } from '../catalog/catalog-context';
import { RefPicker, TEXTURE_KINDS } from '../catalog/RefPicker';
import { Section } from '../editmode/controls';
import { LayerPalette, Popover } from './LayerPalette';
import { LayerFields } from './LayerSettings';

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
    () => (source.kind === 'none' ? standInLayers(standIn) : paletteLayers(source.material, (id) => names.get(id), arrayLayers)),
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
}

/** The "Layers" section of a column: the palette, its material, the picked layer's settings, or "Set up material". */
export function MaterialLayers(p: MaterialLayersProps): JSX.Element {
  const { source, layers } = p.palette;
  const [chooser, setChooser] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const [settings, setSettings] = useState<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const save = (m: MaterialDef, what = 'Layer'): void => void p.host.run(what, 'setMaterial', { material: m });
  const setUp = async (): Promise<void> => {
    setBusy(true);
    try {
      const name = `${p.entityName} layers`;
      const id = await p.host.newMaterialId(name);
      await p.host.run('Set up material', 'setMaterial', { material: templateMaterial('layers', id, name), assign: { entityId: p.entityId } });
    } finally {
      setBusy(false);
    }
  };
  if (source.kind === 'none') {
    return (
      <Section title="Layers" aside={<span className="tl-tag">no material</span>}>
        <div className="tl-palette-setup" role="note" aria-label="no layered material">
          <p>
            {source.material === null
              ? `${p.entityName} has no layered material yet, so it paints these stand-in colours.`
              : `${p.entityName} draws with "${source.material.name}", which has no layers, so it paints these stand-in colours.`}{' '}
            Set up a material, then drop a texture on each layer.
          </p>
          <button type="button" className="tl-btn tl-btn--primary" aria-label="set up material" disabled={busy || p.disabled === true} onClick={() => void setUp()}>
            {busy ? 'Setting up…' : 'Set up material'}
          </button>
        </div>
        <LayerPalette layers={layers} active={p.active} onPick={p.onPick} thumbnails={p.host.thumbnails} keys aria="layers" />
      </Section>
    );
  }
  const m = source.material;
  const editable = source.kind === 'layered' && p.disabled !== true;
  const slotted = source.kind === 'layered' && source.slots !== 'array';
  const put = (index: number, textureId: string): void => {
    // The material as the project shows it now (two quick drops both count: each command waits for the one before).
    const now = p.host.materials.find((x) => x.materialId === m.materialId) ?? m;
    save(withSlotTexture(now, index, textureId), 'Layer texture');
    p.onPick(index);
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
          <RefPicker
            aria={`layer ${chooser.index + 1} texture`}
            kinds={TEXTURE_KINDS}
            value=""
            none="(choose a texture)"
            onPick={(id) => {
              if (id !== '') put(chooser.index, id);
              setChooser(null);
            }}
          />
          <p className="tl-inspector__hint">Or drag a texture from the project window onto the layer.</p>
        </Popover>
      )}
      {settings !== null && source.kind === 'layered' && (
        <Popover anchor={settings} onClose={() => setSettings(null)} aria="layer settings" title={`Layer ${p.active + 1}${picked !== undefined ? ` · ${picked.name}` : ''}`} aside={m.name}>
          <LayerFields key={p.active} material={m} layer={p.active} textureName={picked?.texture != null ? (p.palette.names.get(picked.texture) ?? null) : null} onSave={(x) => save(x)} />
        </Popover>
      )}
    </Section>
  );
}
