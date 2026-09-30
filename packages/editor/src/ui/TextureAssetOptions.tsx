/**
 * A texture asset's streaming setting in the asset inspector: whether the
 * game streams its mips (reads the small ones first and larger ones as its
 * size on screen asks, inside the project's texture budget), with the
 * default for its size named. Only a KTX2 mip chain can stream; a PNG or
 * JPEG streams once it is imported with a KTX2 encoding.
 */
import type { JSX } from 'react';
import { TEXTURE_STREAMING_DEFAULT_ABOVE_PX } from '@thirdlight/project-model/limits';

export interface TextureStreamingSummary {
  on: boolean;
  set: boolean;
  possible: boolean;
}

export function TextureAssetOptions(p: {
  assetId: string;
  streaming: TextureStreamingSummary;
  image?: { width: number; height: number } | undefined;
  onStreaming?: ((assetId: string, streaming: boolean | null) => void) | undefined;
}): JSX.Element {
  const s = p.streaming;
  const bySize = p.image !== undefined && Math.max(p.image.width, p.image.height) > TEXTURE_STREAMING_DEFAULT_ABOVE_PX;
  return (
    <label className="tl-field" data-testid="texture-streaming" title={s.possible ? `Stream the mips: the game reads the small ones first and larger ones as the texture's size on screen needs them, inside the project's texture budget (on by default above ${TEXTURE_STREAMING_DEFAULT_ABOVE_PX} px)` : 'Only a KTX2 texture with mip levels can stream: import the PNG/JPEG with a KTX2 encoding'}>
      <span className="tl-field__label">stream mips</span>
      <select
        className="tl-input"
        aria-label="texture streaming"
        value={s.set ? (s.on ? 'on' : 'off') : 'default'}
        disabled={p.onStreaming === undefined || !s.possible}
        onChange={(e) => p.onStreaming?.(p.assetId, e.target.value === 'default' ? null : e.target.value === 'on')}
      >
        <option value="default">default for its size ({bySize ? 'on' : 'off'})</option>
        <option value="on">on</option>
        <option value="off">off</option>
      </select>
    </label>
  );
}
