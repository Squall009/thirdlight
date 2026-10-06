/**
 * The names of the light layers (project settings). Objects and lights hold
 * bit masks (the Inspector's Light layers / Light mask / Shadow caster mask
 * checkboxes), so the names are labels only: renaming or clearing one never
 * touches a mask, and there is always a row per layer. A name commits on
 * Enter or when its field loses focus; every edit is one `setLightLayers`
 * command (the whole list, trailing unnamed layers left off), issued by the
 * app.
 */
import { useState, type JSX } from 'react';
import { LIGHT_LAYER_COUNT, MAX_LIGHT_LAYER_NAME } from '@thirdlight/project-model/limits';

interface Props {
  /** The names by layer number (index n names layer n + 1; "" or missing: unnamed). */
  names: readonly string[];
  error: string | null;
  onSetNames: (names: string[]) => void;
}

/** The list a command stores: one entry per layer up to the last named one. */
export function lightLayerNameList(names: readonly string[]): string[] {
  const out = Array.from({ length: LIGHT_LAYER_COUNT }, (_, i) => names[i] ?? '');
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

export function LightLayersPanel({ names, error, onSetNames }: Props): JSX.Element {
  // Only the rows being typed in; the others show the stored names.
  const [drafts, setDrafts] = useState<ReadonlyMap<number, string>>(new Map());
  const commit = (bit: number): void => {
    const draft = drafts.get(bit);
    if (draft === undefined) return;
    const rest = new Map(drafts);
    rest.delete(bit);
    setDrafts(rest);
    const edited = Array.from({ length: LIGHT_LAYER_COUNT }, (_, i) => (i === bit ? draft.trim() : (names[i] ?? '')));
    const next = lightLayerNameList(edited);
    const current = lightLayerNameList(names);
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) onSetNames(next);
  };
  const cancel = (bit: number): void => {
    const rest = new Map(drafts);
    rest.delete(bit);
    setDrafts(rest);
  };
  return (
    <div className="tl-panel tl-tags" aria-label="light layers">
      <div className="tl-panel__title">Light layers — {LIGHT_LAYER_COUNT}</div>
      <p className="tl-tags__hint">
        Objects are in some light layers; a light lights only the objects in its light mask, and only those in its shadow caster mask cast its shadow (Inspector). The names label the layers in the editor; scripts use the masks (bit n is layer n + 1).
      </p>
      <ul className="tl-tags__list">
        {Array.from({ length: LIGHT_LAYER_COUNT }, (_, bit) => (
          <li key={bit} className="tl-tags__row" data-light-layer={bit + 1}>
            <span className="tl-tags__name">Layer {bit + 1}</span>
            <input
              className="tl-tags__name-input"
              aria-label={`Layer ${bit + 1} name`}
              placeholder="unnamed"
              maxLength={MAX_LIGHT_LAYER_NAME}
              value={drafts.get(bit) ?? names[bit] ?? ''}
              onChange={(e) => setDrafts(new Map(drafts).set(bit, e.target.value))}
              onBlur={() => commit(bit)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(bit);
                if (e.key === 'Escape') cancel(bit);
              }}
            />
          </li>
        ))}
      </ul>
      {error !== null && <div className="tl-prop__error">{error}</div>}
    </div>
  );
}
