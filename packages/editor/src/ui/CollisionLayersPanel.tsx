/**
 * The project's named collision layers (3D physics), next to the
 * tags. "default" is implicit (every collider that lists no layers); up to 15
 * more names. A collider lists the layers it is in (the Inspector's
 * Collision layers field); script queries filter by layer
 * (`ctx.physics.raycast3d(..., { layers })`, `pickAtPointer`). A layer a
 * collider still lists cannot be removed. Every edit is one
 * `setCollisionLayers` command (the whole list), issued by the app.
 */
import { useState, type JSX } from 'react';
import { MAX_COLLISION_LAYERS as MAX_LAYERS } from '@thirdlight/project-model/limits';

interface Props {
  layers: readonly string[];
  /** How many colliders list each layer. */
  usage: ReadonlyMap<string, number>;
  /** The project's physics dimension (layers are a 3D feature). */
  dimension: 2 | 3;
  error: string | null;
  onSetLayers: (layers: string[]) => void;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

export function CollisionLayersPanel({ layers, usage, dimension, error, onSetLayers }: Props): JSX.Element {
  const [draft, setDraft] = useState('');
  const problem = (name: string): string | null => {
    if (!NAME_RE.test(name)) return 'a letter or _, then letters, digits or _ (up to 32)';
    if (name === 'default') return '"default" is always there';
    if (layers.includes(name)) return 'that name is taken';
    return null;
  };
  const add = (): void => {
    const name = draft.trim();
    if (problem(name) !== null || layers.length >= MAX_LAYERS) return;
    onSetLayers([...layers, name]);
    setDraft('');
  };
  const draftProblem = draft.trim() === '' ? null : problem(draft.trim());
  return (
    <div className="tl-panel tl-tags" aria-label="collision layers">
      <div className="tl-panel__title">Collision layers — {layers.length} / {MAX_LAYERS}</div>
      <p className="tl-tags__hint">
        {dimension === 3 ? '' : 'A 3D project feature (physics_dimension 3). '}Colliders are in &quot;default&quot; unless they list layers; script queries see only the layers they name (<code>ctx.physics.raycast3d</code>, <code>pickAtPointer</code>).
      </p>
      <ul className="tl-tags__list">
        <li className="tl-tags__row" data-layer="default">
          <span className="tl-tags__name">default</span>
          <span className="tl-tags__used">{(usage.get('default') ?? 0) === 0 ? 'no collider' : `${usage.get('default')} collider${usage.get('default') === 1 ? '' : 's'}`}</span>
        </li>
        {layers.map((name) => {
          const used = usage.get(name) ?? 0;
          return (
            <li key={name} className="tl-tags__row" data-layer={name}>
              <span className="tl-tags__name">{name}</span>
              <span className="tl-tags__used">{used === 0 ? 'unused' : `${used} collider${used === 1 ? '' : 's'}`}</span>
              <button
                className="tl-btn"
                aria-label={`remove collision layer ${name}`}
                disabled={used > 0}
                title={used > 0 ? 'remove it from every collider first' : 'remove this layer'}
                onClick={() => onSetLayers(layers.filter((x) => x !== name))}
              >
                remove
              </button>
            </li>
          );
        })}
      </ul>
      <div className="tl-tags__add">
        <input
          aria-label="new collision layer name"
          placeholder="new layer…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button className="tl-btn" onClick={add} disabled={draft.trim() === '' || draftProblem !== null || layers.length >= MAX_LAYERS}>
          add layer
        </button>
        {draftProblem !== null && <span className="tl-prop__error">{draftProblem}</span>}
      </div>
      {error !== null && <div className="tl-prop__error">{error}</div>}
    </div>
  );
}
