/**
 * Phase 25.21: "Pack texture" — a KTX2 texture made from the project's
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

import type { AssetView } from '../session/content-projection';

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

export function TexturePackForm(p: { textures: readonly AssetView[]; onPack: (req: PackRequest) => Promise<string | null>; onClose: () => void }): JSX.Element {
  // Only PNG/JPEG textures can be unpacked into channels.
  const sources = p.textures.filter((a) => a.kind === 'texture' && (a.image === undefined || a.image.format === 'png' || a.image.format === 'jpeg'));
  const first = sources[0];
  const whole = (id: string): PackChannel[] => CHANNELS.map((channel) => ({ assetId: id, channel }));
  const [name, setName] = useState('Packed texture');
  const [encoding, setEncoding] = useState<'color' | 'normal' | 'data'>('color');
  const [layers, setLayers] = useState<PackChannel[][]>(() => [first !== undefined ? whole(first.assetId) : [...EMPTY]]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setLayer = (i: number, l: PackChannel[]): void => setLayers((ls) => ls.map((x, j) => (j === i ? l : x)));
  const size = (id: string): string => {
    const img = sources.find((s) => s.assetId === id)?.image;
    return img !== undefined ? ` (${img.width}×${img.height})` : '';
  };
  const options = (
    <>
      <option value="=0">0</option>
      <option value="=128">128</option>
      <option value="=255">255</option>
      {sources.map((s) =>
        CHANNELS.map((c) => (
          <option key={`${s.assetId}:${c}`} value={`${s.assetId}:${c}`}>
            {s.displayName} {c.toUpperCase()}
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
          <select
            className="tl-input tl-input--small"
            aria-label={`layer ${i + 1} from`}
            title="Take all four channels of one texture"
            value=""
            onChange={(e) => e.target.value !== '' && setLayer(i, whole(e.target.value))}
          >
            <option value="">RGBA of…</option>
            {sources.map((s) => (
              <option key={s.assetId} value={s.assetId}>
                {s.displayName}
                {size(s.assetId)}
              </option>
            ))}
          </select>
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
        <button className="tl-btn tl-btn--small" aria-label="add layer" onClick={() => setLayers((ls) => [...ls, first !== undefined ? whole(first.assetId) : [...EMPTY]])} disabled={layers.length >= MAX_TEXTURE_LAYERS}>
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
