/**
 * The brush's noise mask: a live swatch of the exact mask (the same function
 * the commands multiply each dab by, `brushMask`), the switch to paint
 * through it, and its scale, contrast, threshold, octaves and seed.
 *
 * The swatch spans one brush (its size, at least two of the mask's cells),
 * so it shows how the mask breaks up what one dab paints.
 *
 * Browser-only (React).
 */
import { useEffect, useRef, type JSX } from 'react';
import { brushMask } from '@thirdlight/runtime';

import { BRUSH_BOUNDS, type BrushSettings, type BrushStore } from '../../session/brush';
import { Segmented, Toggle } from '../editmode/controls';
import { SliderField } from './SliderField';

/** The swatch's pixels a side (drawn at twice its 52 px for sharp screens). */
const SWATCH_PX = 104;
const SCALE_TRACK: readonly [number, number] = [0.25, 256];
const CONTRAST_TRACK: readonly [number, number] = [0, 8];

/** Draw the mask over `side` metres into the canvas (white: paints, black: masked out). */
function drawSwatch(canvas: HTMLCanvasElement, b: BrushSettings): void {
  const g = canvas.getContext('2d');
  if (g === null) return;
  const img = g.createImageData(SWATCH_PX, SWATCH_PX);
  const side = Math.max(b.size, 2 * b.mask.scale);
  for (let y = 0; y < SWATCH_PX; y++) {
    for (let x = 0; x < SWATCH_PX; x++) {
      const v = Math.round(brushMask(b.mask, ((x + 0.5) / SWATCH_PX) * side, ((y + 0.5) / SWATCH_PX) * side) * 255);
      const i = (y * SWATCH_PX + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
}

export function NoiseMask({ settings: b, store }: { settings: BrushSettings; store: BrushStore }): JSX.Element {
  const swatch = useRef<HTMLCanvasElement | null>(null);
  const m = b.mask;
  useEffect(() => {
    if (swatch.current !== null) drawSwatch(swatch.current, b);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- drawn again only when what it shows changes
  }, [m.scale, m.contrast, m.threshold, m.octaves, m.seed, b.size]);
  const off = !m.on;
  return (
    <div className={`tl-mask${off ? ' is-off' : ''}`} aria-label="noise mask">
      <div className="tl-mask__top">
        <canvas ref={swatch} className="tl-mask__swatch" width={SWATCH_PX} height={SWATCH_PX} aria-label="noise mask swatch" title="The mask across one brush: white paints, black is held back" />
        <div className="tl-mask__meta">
          <Toggle label="Paint through noise" aria="paint through noise" hint="Each dab is multiplied by noise anchored to the ground, so tiling breaks up and strokes stay seamless." on={m.on} onChange={(on) => store.set({ mask: { on } })} />
          <span className="tl-hint">World-anchored: seamless across tiles.</span>
        </div>
      </div>
      <SliderField label="Scale" aria="mask scale" value={m.scale} min={SCALE_TRACK[0]} max={SCALE_TRACK[1]} log limit={BRUSH_BOUNDS.maskScale} step={0.1} decimals={m.scale < 10 ? 1 : 0} unit="m" hint="The size of the noise's largest blotches." onChange={(v) => store.set({ mask: { scale: v } })} />
      <SliderField label="Contrast" aria="mask contrast" value={m.contrast} min={CONTRAST_TRACK[0]} max={CONTRAST_TRACK[1]} limit={BRUSH_BOUNDS.maskContrast} step={0.1} hint="How sharply the mask turns from held back to painted." onChange={(v) => store.set({ mask: { contrast: v } })} />
      <SliderField label="Threshold" aria="mask threshold" value={m.threshold} min={0} max={1} step={0.01} hint="Higher leaves more of the ground unpainted." onChange={(v) => store.set({ mask: { threshold: v } })} />
      <div className="tl-frow">
        <span className="tl-frow__label">Octaves</span>
        <Segmented small aria="mask octaves" value={m.octaves} options={[1, 2, 3, 4, 5].map((o) => ({ id: o, label: String(o), hint: `${o} layer${o === 1 ? '' : 's'} of detail` }))} onChange={(o) => store.set({ mask: { octaves: o } })} />
      </div>
      <div className="tl-frow">
        <span className="tl-frow__label">Seed</span>
        <input
          className="tl-num"
          aria-label="mask seed"
          type="text"
          inputMode="numeric"
          value={m.seed}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isInteger(v)) store.set({ mask: { seed: v } });
          }}
        />
        <button type="button" className="tl-iconbtn" aria-label="new mask seed" title="A new seed: another pattern" onClick={() => store.set({ mask: { seed: Math.floor(Math.random() * 100_000) } })}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="3" />
            <circle cx="9" cy="9" r="1.2" fill="currentColor" />
            <circle cx="15" cy="15" r="1.2" fill="currentColor" />
            <circle cx="15" cy="9" r="1.2" fill="currentColor" />
            <circle cx="9" cy="15" r="1.2" fill="currentColor" />
          </svg>
        </button>
      </div>
    </div>
  );
}
