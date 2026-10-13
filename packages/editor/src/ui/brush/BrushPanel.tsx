/**
 * The one brush panel: the settings a tool uses (`BrushUse`), in one order
 * for every editor — a preview of the cursor (where there is room), the
 * height step (sculpt tools; its own row, never called strength), size,
 * strength, opacity (paint tools), falloff, spacing, and invert with its
 * key. Its sibling `NoiseMask` edits the mask.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import { BRUSH_FALLOFFS, brushHalfRadius, type BrushFalloff } from '@thirdlight/runtime';

import { BRUSH_BOUNDS, type BrushSettings, type BrushStore, type BrushUse } from '../../session/brush';
import { Toggle } from '../editmode/controls';
import { SliderField } from './SliderField';

export interface BrushPanelProps {
  settings: BrushSettings;
  store: BrushStore;
  uses: readonly BrushUse[];
  /** Show the cursor's preview (the column has room: sculpt). */
  preview?: boolean;
  /** What inverting does ("Lower", "Erase", "Fill"); X is its key when it is erasing paint, else Ctrl held. */
  invert?: string;
}

/** The size track's ends (metres): typed sizes may go to the editor's bounds. */
const SIZE_TRACK: readonly [number, number] = [0.5, 256];
/** The smallest a size track starts at (typed sizes may go smaller, to the editor's bounds). */
const SIZE_TRACK_SMALLEST = 0.05;
const HEIGHT_TRACK: readonly [number, number] = [0.01, 10];

const FALLOFF_PATHS: Readonly<Record<BrushFalloff, string>> = {
  smooth: 'M2 4 C 10 4, 14 22, 30 22',
  linear: 'M2 4 L 30 22',
  constant: 'M2 4 L 24 4 L 26 22 L 30 22',
  curve: 'M2 4 L 12 4 C 22 4, 18 22, 30 22',
};

const FALLOFF_HINTS: Readonly<Record<BrushFalloff, string>> = {
  smooth: 'Fades softly from the centre to the edge',
  linear: 'Fades evenly from the centre to the edge',
  constant: 'Full strength to a hard edge',
  curve: 'Full strength out to the hardness, then fades softly',
};

const label = (f: string): string => f[0]!.toUpperCase() + f.slice(1);

/** The falloff choice: each a small curve of strength from the centre (left) to the edge (right). */
export function FalloffPicker({ value, onChange }: { value: BrushFalloff; onChange: (f: BrushFalloff) => void }): JSX.Element {
  return (
    <div className="tl-falloff" role="radiogroup" aria-label="brush falloff">
      {BRUSH_FALLOFFS.map((f) => (
        <button key={f} type="button" role="radio" aria-checked={f === value} className={f === value ? 'is-active' : ''} title={FALLOFF_HINTS[f]} onClick={() => onChange(f)}>
          <svg width="32" height="26" viewBox="0 0 32 26" aria-hidden="true">
            <path d="M2 22.5H30" stroke="currentColor" opacity=".25" />
            <path d={FALLOFF_PATHS[f]} fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
          <span>{label(f)}</span>
        </button>
      ))}
    </div>
  );
}

/** The cursor as the panel draws it: the outer ring (size), the dashed inner ring (half strength), the fill (strength). */
function BrushPreview({ settings }: { settings: BrushSettings }): JSX.Element {
  const inner = 34 * brushHalfRadius(settings.falloff, settings.hardness);
  const a = settings.strength * 0.75;
  return (
    <div className="tl-brush__preview" title="Size, falloff and strength as the cursor draws them">
      <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden="true">
        <defs>
          <radialGradient id="tl-brush-fill" cx="50%" cy="50%" r="50%">
            <stop offset="0" stopColor="var(--brush)" stopOpacity={a} />
            <stop offset={(inner / 34).toFixed(2)} stopColor="var(--brush)" stopOpacity={a * 0.5} />
            <stop offset="1" stopColor="var(--brush)" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="38" cy="38" r="34" fill="url(#tl-brush-fill)" />
        <circle cx="38" cy="38" r="34" fill="none" stroke="var(--brush)" strokeWidth="1.6" />
        {inner < 33.9 && <circle cx="38" cy="38" r={inner} fill="none" stroke="var(--brush)" strokeWidth="1.2" strokeDasharray="3 3" />}
        <circle cx="38" cy="38" r="1.8" fill="var(--brush)" />
      </svg>
      <div className="tl-brush__legend">
        <span>
          <i className="tl-dot tl-dot--ring" />
          Outer ring: size
        </span>
        <span>
          <i className="tl-dot tl-dot--inner" />
          Inner ring: half strength
        </span>
        <span>
          <i className="tl-dot tl-dot--fill" />
          Fill: strength
        </span>
      </div>
    </div>
  );
}

export function BrushPanel({ settings: b, store, uses, preview, invert }: BrushPanelProps): JSX.Element {
  const has = (u: BrushUse): boolean => uses.includes(u);
  const B = BRUSH_BOUNDS;
  const erase = invert === 'Erase';
  // A brush made for small things (a prop's paint) gets a track that reaches its own smallest size.
  const sizeTrack: readonly [number, number] = [Math.min(SIZE_TRACK[0], Math.max(store.bounds.size[0], SIZE_TRACK_SMALLEST)), Math.min(SIZE_TRACK[1], store.bounds.size[1])];
  return (
    <div className="tl-brush" aria-label="brush">
      {preview === true && <BrushPreview settings={b} />}
      {has('heightStep') && (
        <SliderField label="Height step" value={b.heightStep} min={HEIGHT_TRACK[0]} max={HEIGHT_TRACK[1]} log limit={store.bounds.heightStep} step={0.01} unit="m" hint="How far one dab at full strength raises or lowers the ground." onChange={(v) => store.set({ heightStep: v })} />
      )}
      {has('size') && (
        <SliderField label="Size" aria="brush size" value={b.size} min={sizeTrack[0]} max={sizeTrack[1]} log limit={store.bounds.size} step={b.size < 1 ? 0.01 : 0.1} decimals={b.size < 1 ? 2 : b.size < 10 ? 1 : 0} unit="m" accent hint="The brush's width. [ and ] change it; F then drag in the view." onChange={(v) => store.set({ size: v })} />
      )}
      {has('strength') && (
        <SliderField label="Strength" aria="brush strength" value={b.strength} min={B.strength[0]} max={B.strength[1]} step={1} scale={100} unit="%" accent hint="How much one dab does. Shift+[ and Shift+] change it; Shift+F then drag in the view." onChange={(v) => store.set({ strength: v })} />
      )}
      {has('opacity') && (
        <SliderField label="Opacity" aria="brush opacity" value={b.opacity} min={B.opacity[0]} max={B.opacity[1]} step={1} scale={100} unit="%" hint="The most one stroke can reach, however long you paint." onChange={(v) => store.set({ opacity: v })} />
      )}
      {has('falloff') && (
        <div className="tl-frow tl-frow--stack">
          <span className="tl-frow__label">Falloff</span>
          <FalloffPicker value={b.falloff} onChange={(f) => store.set({ falloff: f })} />
        </div>
      )}
      {has('falloff') && b.falloff === 'curve' && (
        <SliderField label="Hardness" aria="brush hardness" value={b.hardness} min={B.hardness[0]} max={B.hardness[1]} step={1} scale={100} unit="%" hint="How much of the brush is at full strength before it fades." onChange={(v) => store.set({ hardness: v })} />
      )}
      {has('spacing') && (
        <SliderField label="Spacing" aria="brush spacing" value={b.spacing} min={B.spacing[0]} max={B.spacing[1]} step={1} scale={100} unit="%" hint="The distance between dabs along a stroke, as a share of the size." onChange={(v) => store.set({ spacing: v })} />
      )}
      {has('invert') && invert !== undefined && (
        <div className="tl-frow">
          <Toggle label={erase ? 'Erase' : `${invert} instead (hold Ctrl)`} aria="brush invert" keyName={erase ? 'X' : 'Ctrl'} hint={`${invert} instead of ${erase ? 'painting' : 'the tool'}. X switches it; Ctrl held does it for one stroke.`} on={b.invert} onChange={(on) => store.set({ invert: on })} />
        </div>
      )}
    </div>
  );
}
