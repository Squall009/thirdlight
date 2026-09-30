/**
 * "Pack texture" — a KTX2 texture made from the project's
 * PNG/JPEG texture assets channel by channel; several layers make a texture
 * array (graph materials read a layer: Sample texture, Normal map and
 * Triplanar have a `layer` input). Typical packing for a painted terrain's
 * four layers: albedo RGB + height in A (colour), normal maps (normal map),
 * occlusion / roughness / metalness (data).
 *
 * Display + intent only: the backend packs and encodes (the pack route), the
 * editor publishes the result with one `publishAsset` (the session client).
 *
 * Browser-only (React).
 */
import { MAX_TEXTURE_LAYERS } from '@thirdlight/project-model/limits';
import { useState, type JSX } from 'react';

import { useAssetSummaries } from './catalog/catalog-context';
import { PICKER_SELECT_MAX, RefPicker, TEXTURE_KINDS, useEntryNames } from './catalog/RefPicker';
import { useIndexList } from './catalog/useIndexList';

export type PackChannel = { assetId: string; channel: 'r' | 'g' | 'b' | 'a' } | { value: number };
export interface PackRequest {
  layers: PackChannel[][];
  encoding: 'color' | 'normal' | 'data';
  displayName: string;
}

const CHANNELS = ['r', 'g', 'b', 'a'] as const;
/** A channel choice as a select value: `<assetId>:<channel>` or `=<value>`. */
const keyOf = (c: PackChannel): string => ('value' in c ? `=${c.value}` : `${c.assetId}:${c.channel}`);
const channelOf = (v: string): PackChannel => (v.startsWith('=') ? { value: Number(v.slice(1)) } : { assetId: v.slice(0, v.lastIndexOf(':')), channel: v.slice(v.lastIndexOf(':') + 1) as 'r' | 'g' | 'b' | 'a' });
/** An empty layer: black, opaque. */
const EMPTY: PackChannel[] = [{ value: 0 }, { value: 0 }, { value: 0 }, { value: 255 }];

export function TexturePackForm(p: { onPack: (req: PackRequest) => Promise<string | null>; onClose: () => void }): JSX.Element {
  // The channels offered: every texture when they all fit one picker list, else only those picked
  // with "add a source" or "RGBA of…" (searchable pickers) — never a silent first page. Plus any the
  // form uses; KTX2 textures cannot be unpacked into channels.
  const page = useIndexList({ kinds: TEXTURE_KINDS });
  const listed: string[] = [];
  for (let i = 0; page.total !== null && page.total <= PICKER_SELECT_MAX && i < page.total; i++) {
    const e = page.entry(i);
    if (e !== undefined) listed.push(e.id);
  }
  const whole = (id: string): PackChannel[] => CHANNELS.map((channel) => ({ assetId: id, channel }));
  const [name, setName] = useState('Packed texture');
  const [encoding, setEncoding] = useState<'color' | 'normal' | 'data'>('color');
  const [layers, setLayers] = useState<PackChannel[][]>(() => [[...EMPTY]]);
  const [added, setAdded] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setLayer = (i: number, l: PackChannel[]): void => setLayers((ls) => ls.map((x, j) => (j === i ? l : x)));
  const used = layers.flatMap((l) => l.flatMap((c) => ('assetId' in c ? [c.assetId] : [])));
  const candidates = [...new Set([...listed, ...added, ...used])];
  const summaries = useAssetSummaries(candidates);
  const sources = candidates.filter((_, i) => summaries[i] === undefined || summaries[i]!.image === undefined || summaries[i]!.image!.format === 'png' || summaries[i]!.image!.format === 'jpeg');
  const first = sources[0];
  const names = useEntryNames(sources, TEXTURE_KINDS);
  const options = (
    <>
      <option value="=0">0</option>
      <option value="=128">128</option>
      <option value="=255">255</option>
      {sources.map((id) =>
        CHANNELS.map((c) => (
          <option key={`${id}:${c}`} value={`${id}:${c}`}>
            {names.get(id) ?? id} {c.toUpperCase()}
          </option>
        )),
      )}
    </>
  );
  const pack = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const err = await p.onPack({ layers, encoding, displayName: name.trim() === '' ? 'Packed texture' : name.trim() });
    setBusy(false);
    if (err !== null) setError(err);
    else p.onClose();
  };
  return (
    <div className="tl-assets__pack" aria-label="pack texture">
      <div className="tl-subhead">Pack texture{layers.length > 1 ? ` array (${layers.length} layers)` : ''}</div>
      <p className="tl-note">
        Channels of PNG/JPEG textures (one size) packed into one KTX2; each layer is one image of a texture array that graph materials sample by layer. The encoder takes at most 12 Mpix across the layers (4 layers of 1024²).
      </p>
      <label className="tl-field">
        <span className="tl-field__label">name</span>
        <input className="tl-input" aria-label="packed texture name" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="tl-field" title="colour: ETC1S, sRGB (albedo; alpha stays linear — a height fits there). normal map: UASTC, linear, renormalized mips. data: UASTC, linear, channels kept apart (masks, occlusion/roughness/metalness).">
        <span className="tl-field__label">encoding</span>
        <select className="tl-input" aria-label="packed texture encoding" value={encoding} onChange={(e) => setEncoding(e.target.value as 'color' | 'normal' | 'data')}>
          <option value="color">colour (ETC1S, sRGB)</option>
          <option value="normal">normal map (UASTC)</option>
          <option value="data">data (UASTC, linear)</option>
        </select>
      </label>
      {layers.map((l, i) => (
        <div className="tl-assets__pack-layer" key={i} data-layer={i}>
          <span className="tl-field__label">layer {i + 1}</span>
          <RefPicker aria={`layer ${i + 1} from`} kinds={TEXTURE_KINDS} className="tl-input tl-input--small" title="Take all four channels of one texture" value="" none="RGBA of…" onPick={(id) => id !== '' && setLayer(i, whole(id))} />
          {CHANNELS.map((c, k) => (
            <label key={c} className="tl-field--inline">
              {c.toUpperCase()}{' '}
              <select className="tl-input tl-input--small" aria-label={`layer ${i + 1} ${c.toUpperCase()}`} value={keyOf(l[k]!)} onChange={(e) => setLayer(i, l.map((x, j) => (j === k ? channelOf(e.target.value) : x)))}>
                {options}
              </select>
            </label>
          ))}
          {layers.length > 1 && (
            <button className="tl-btn tl-btn--small" aria-label={`remove layer ${i + 1}`} onClick={() => setLayers((ls) => ls.filter((_, j) => j !== i))}>
              −
            </button>
          )}
        </div>
      ))}
      <div className="tl-assets__row">
        <RefPicker aria="pack source" kinds={TEXTURE_KINDS} className="tl-input tl-input--small" title="Offer another texture's channels in the layers' channel choices" value="" none="add a source…" onPick={(id) => id !== '' && setAdded((a) => (a.includes(id) ? a : [...a, id]))} />
        <button className="tl-btn tl-btn--small" aria-label="add layer" onClick={() => setLayers((ls) => [...ls, first !== undefined ? whole(first) : [...EMPTY]])} disabled={layers.length >= MAX_TEXTURE_LAYERS}>
          + layer
        </button>
        <button className="tl-btn tl-btn--small" aria-label="pack" disabled={busy || sources.length === 0} onClick={() => void pack()} title="Pack and encode on the server, then add the texture to the project (one undo)">
          {busy ? 'packing…' : 'pack'}
        </button>
        <button className="tl-btn tl-btn--small" onClick={p.onClose}>
          close
        </button>
      </div>
      {sources.length === 0 && <p className="tl-note">Import the PNG or JPEG images to pack first (keep the image, no KTX2 encoding).</p>}
      {error !== null && (
        <div className="tl-assets__error" role="alert" data-testid="pack-error" title={error}>
          {error}
        </div>
      )}
    </div>
  );
}
