/**
 * The Scene settings window's panel: the scene's default plane. A collider
 * or controller of the scene without a plane of its own is held to it in the
 * game (a side-view level), the gizmo moves such objects in it, and the Scene
 * view's "side view" button looks along its normal. Each change is one
 * `setScenePlane` (one undo); "none" leaves the scene free in 3D.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { PlaneLock } from '@thirdlight/project-model';

interface Props {
  /** The scene's default plane now (null: none). */
  plane: PlaneLock | null;
  /** Store a new plane (null: none); resolves to why it was refused (null: stored). */
  onSet: (plane: PlaneLock | null) => Promise<string | null>;
}

export function ScenePlanePanel({ plane, onSet }: Props): JSX.Element {
  const [origin, setOrigin] = useState(String(plane?.origin ?? 0));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setOrigin(String(plane?.origin ?? 0)), [plane?.origin]);
  const send = (next: PlaneLock | null): void => {
    void onSet(next).then(setError);
  };
  const commitOrigin = (): void => {
    const v = Number(origin);
    if (plane === null || !Number.isFinite(v) || v === plane.origin) {
      setOrigin(String(plane?.origin ?? 0));
      return;
    }
    send({ axis: plane.axis, origin: v });
  };
  return (
    <div className="tl-panel tl-scene-settings">
      <section className="tl-inspector__section" aria-label="default plane">
        <div className="tl-subhead">Default plane</div>
        <p className="tl-inspector__hint">
          Bodies (colliders and the player controller) without a plane of their own are held to it in the game: a side-view level. The gizmo moves them in the plane; the Scene view&apos;s side view looks across it.
        </p>
        <label className="tl-field">
          <span>axis</span>
          <select
            className="tl-input"
            aria-label="scene plane axis"
            value={plane?.axis ?? 'none'}
            onChange={(e) => {
              const axis = e.target.value;
              send(axis === 'x' || axis === 'z' ? { axis, origin: plane?.origin ?? 0 } : null);
            }}
          >
            <option value="none">none (free in 3D)</option>
            <option value="z">Z (the level runs along X)</option>
            <option value="x">X (the level runs along Z)</option>
          </select>
        </label>
        {plane !== null && (
          <label className="tl-field">
            <span>origin (m along {plane.axis.toUpperCase()})</span>
            <input
              className="tl-input"
              aria-label="scene plane origin"
              type="number"
              step={0.1}
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              onBlur={commitOrigin}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitOrigin();
              }}
            />
          </label>
        )}
        {error !== null && (
          <p className="tl-inspector__error" role="alert">
            {error}
          </p>
        )}
      </section>
    </div>
  );
}
