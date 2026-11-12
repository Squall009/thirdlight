/**
 * The voxel world's fine bake in its Inspector section: how far the far
 * cache has baked the levels the scenes ask (per level, region columns
 * done of the world's), whether it is baking now, stale (not done and not
 * running) or paused, with Pause and Resume. The bake itself runs in the
 * backend from the moment a scene asks another bake level; this only shows
 * it and stops or restarts it. The editor keeps working meanwhile: a world
 * not baked yet draws as a 2 m world plus the columns baked so far.
 */
import { useEffect, useState, type JSX } from 'react';

/** The bake's state as the far info answers it (null: the world asks no fine level, or its far cache is still being built). */
export type FineBakeState = { bakeLevel: number; baking: boolean; paused: boolean; levels: Array<{ level: number; done: number; total: number }> } | null;

/** ms between reads of the bake's state while it bakes (or the far cache it waits for is built). */
const POLL_MS = 1000;

/** The metres of a cell at a far level (level 0: 0.5 m). */
const levelMetres = (level: number): number => 0.5 * 2 ** level;

export function VoxelBakeStatus(props: { world: string; bakeLevelM: number; read: (world: string, run?: boolean) => Promise<FineBakeState> }): JSX.Element | null {
  const { world, bakeLevelM, read } = props;
  const [state, setState] = useState<FineBakeState | 'unknown'>('unknown');
  const [tick, setTick] = useState(0);
  const asked = bakeLevelM < 2;
  useEffect(() => {
    if (!asked) return;
    let live = true;
    read(world).then(
      (s) => live && setState(s),
      () => live && setState(null),
    );
    return () => {
      live = false;
    };
  }, [world, bakeLevelM, tick, asked, read]);
  const busy = state === 'unknown' || state === null || state.baking;
  useEffect(() => {
    if (!asked || !busy) return;
    const t = setTimeout(() => setTick((n) => n + 1), POLL_MS);
    return () => clearTimeout(t);
  }, [asked, busy, tick]);
  if (!asked) return null;
  if (state === 'unknown' || state === null) return <p className="tl-inspector__hint" data-fine-bake="waiting">Fine bake to {bakeLevelM} m: waiting for the far cache to be built…</p>;
  const done = state.levels.every((l) => l.done === l.total);
  const status = done ? 'baked' : state.paused ? 'paused' : state.baking ? 'baking' : 'stale';
  const control = (run: boolean): void => {
    read(world, run).then(
      (s) => setState(s),
      () => undefined,
    );
  };
  return (
    <div className="tl-inspector__hint" data-fine-bake={status} data-fine-done={state.levels.map((l) => `${l.level}:${l.done}/${l.total}`).join(' ')}>
      <p>
        Fine bake to {bakeLevelM} m: {status}
        {done ? '' : ' (the world draws its 2 m far field plus the regions baked so far meanwhile)'}
      </p>
      {state.levels.map((l) => (
        <p key={l.level}>
          {levelMetres(l.level)} m: {l.done} / {l.total} region columns
          <progress max={l.total} value={l.done} />
        </p>
      ))}
      {!done &&
        (state.paused ? (
          <button className="tl-btn tl-btn--small" title="Go on baking from the region columns baked so far" onClick={() => control(true)}>
            Resume bake
          </button>
        ) : (
          <button className="tl-btn tl-btn--small" title="Stop baking; the region columns baked so far stay" onClick={() => control(false)}>
            Pause bake
          </button>
        ))}
    </div>
  );
}
