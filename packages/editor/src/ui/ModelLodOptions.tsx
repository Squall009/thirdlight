/**
 * A model asset's LOD group settings in the asset inspector (its import
 * settings): the screen sizes where each coarser `_LOD<n>` level takes over
 * and the size below which the model is not drawn, in percent of the screen
 * height. Empty fields are the engine's defaults; each change is one
 * `setAssetOptions` command.
 */
import { useEffect, useRef, useState, type FocusEvent, type JSX } from 'react';
import { LOD_SCREEN_SIZES_DEFAULT } from '@thirdlight/project-model/limits';

export interface ModelLodSummary {
  screenSizes?: number[];
  cullSize?: number;
}

/** A fraction as a percent for a field (no float noise: 0.012 → "1.2"). */
const percent = (v: number): string => String(Math.round(v * 1e6) / 1e4);

export function ModelLodOptions(p: { assetId: string; lod: ModelLodSummary | undefined; onLod?: ((assetId: string, lod: ModelLodSummary | null) => void) | undefined }): JSX.Element {
  const sizesText = p.lod?.screenSizes?.map(percent).join(', ') ?? '';
  const cullText = p.lod?.cullSize !== undefined ? percent(p.lod.cullSize) : '';
  const [sizes, setSizes] = useState(sizesText);
  const [cull, setCull] = useState(cullText);
  useEffect(() => setSizes(sizesText), [sizesText]);
  useEffect(() => setCull(cullText), [cullText]);
  // What was sent last (a blur right after Enter would send it again before the change comes back).
  const sent = useRef(`${sizesText}|${cullText}`);
  useEffect(() => {
    sent.current = `${sizesText}|${cullText}`;
  }, [sizesText, cullText]);
  const commit = (nextSizes: string, nextCull: string): void => {
    if (`${nextSizes}|${nextCull}` === sent.current) return;
    sent.current = `${nextSizes}|${nextCull}`;
    const list = nextSizes.split(/[,\s]+/).filter((t) => t !== '').map((t) => Number(t) / 100);
    const c = nextCull.trim() === '' ? undefined : Number(nextCull) / 100;
    const lod: ModelLodSummary = { ...(list.length > 0 ? { screenSizes: list } : {}), ...(c !== undefined && c > 0 ? { cullSize: c } : {}) };
    p.onLod?.(p.assetId, lod.screenSizes === undefined && lod.cullSize === undefined ? null : lod);
  };
  const disabled = p.onLod === undefined;
  // Moving between the two fields commits nothing yet: both go in one command when leaving them (or on Enter).
  const leave = (e: FocusEvent<HTMLInputElement>): void => {
    if ((e.relatedTarget as HTMLElement | null)?.dataset['lodField'] === p.assetId) return;
    commit(sizes, cull);
  };
  return (
    <>
      <label className="tl-field" title="Where each coarser level (_LOD1, _LOD2, …) takes over: the share of the screen height the model covers, in %, largest first. Empty: the engine's defaults. The project's LOD bias scales them.">
        <span className="tl-field__label">LOD switch %</span>
        <input
          className="tl-input"
          aria-label="lod switch points"
          placeholder={`${LOD_SCREEN_SIZES_DEFAULT.map(percent).join(', ')} (default)`}
          value={sizes}
          disabled={disabled}
          onChange={(e) => setSizes(e.target.value)}
          data-lod-field={p.assetId}
          onBlur={leave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(sizes, cull);
          }}
        />
      </label>
      <label className="tl-field" title="Below this share of the screen height (%) the model is not drawn at all. Empty: always drawn. Block layers never cull a model.">
        <span className="tl-field__label">cull below %</span>
        <input
          className="tl-input"
          aria-label="lod cull size"
          placeholder="never (default)"
          value={cull}
          disabled={disabled}
          onChange={(e) => setCull(e.target.value)}
          data-lod-field={p.assetId}
          onBlur={leave}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(sizes, cull);
          }}
        />
      </label>
    </>
  );
}
