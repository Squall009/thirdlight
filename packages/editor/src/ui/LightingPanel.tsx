/**
 * The Lighting window's panel — bake the active scene's lighting (the
 * window names the scene).
 *
 * "Bake lighting" runs the Scene view's live lighting (WebGPU) until it
 * settles and saves it as the scene's bake: what WebGL 2, the low quality
 * level and exports draw, and what live levels start from. The lights'
 * modes decide what is saved: a baked light's direct light and bounce, a
 * mixed light's bounce, a realtime light nothing. A bake whose static
 * objects, baked or mixed lights or sky turn changed since is marked stale
 * (it is still drawn until it is baked again or cleared); a bake of the
 * earlier bakers (lightmaps, probe grids) draws until then and reads as
 * stale. Clear removes the scene's bake.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { LightingBake } from '@thirdlight/project-model';

import { lightingBakeSummary } from '../viewport/lighting-bake-run';

interface Props {
  bake: LightingBake | null;
  busy: { text: string; fraction: number } | null;
  message: string | null;
  onCancel: () => void;
  onClear: () => void;
  /** "Bake lighting": the live lighting run to settled and saved (WebGPU). */
  onBakeLighting: () => void;
  /** Why lighting cannot be baked here (null = it can). */
  lightingUnavailable: string | null;
  /** The saved lighting no longer matches the scene. */
  lightingStale: boolean;
}

/** A bake of the earlier bakers, in words. */
function oldBakeOf(b: LightingBake): string {
  const parts = [
    ...(b.entries.length > 0 ? [`${b.entries.length} object${b.entries.length === 1 ? '' : 's'} in ${b.atlases.length} lightmap${b.atlases.length === 1 ? '' : 's'}`] : []),
    ...(b.probes !== undefined ? [`${b.probes.probes} probes`] : []),
  ];
  return `This scene's bake (${parts.join(', ')}) was made by the earlier bakers: stale; it draws until the scene is baked again.`;
}

export function LightingPanel(p: Props): JSX.Element {
  return (
    <div className="tl-panel tl-lighting" aria-label="lighting">
      <p className="tl-hint">
        Static surfaces (block layers, generated architecture, static models) keep the light of the lights set to <b>baked</b> (direct light and bounce) and the
        bounce of those set to <b>mixed</b> (their direct light stays per pixel). Baked lights then no longer light per pixel.
      </p>
      <div className="tl-lighting__status" aria-label="lighting status">
        {p.bake?.surface === undefined ? (
          <span>{p.bake === null ? 'No saved lighting for this scene.' : oldBakeOf(p.bake)}</span>
        ) : (
          <span>
            Saved lighting from {p.bake.surface.createdAt.replace('T', ' ').slice(0, 16)}. {lightingBakeSummary(p.bake.surface)}
            {p.lightingStale && <b className="tl-lighting__stale"> — stale: static objects, baked or mixed lights or the sky's rotation changed; bake again</b>}
          </span>
        )}
      </div>
      <div className="tl-lighting__actions">
        <button type="button" className="tl-button" disabled={p.busy !== null || p.lightingUnavailable !== null} title={p.lightingUnavailable ?? 'Run the live lighting until it settles and save it: what WebGL 2, the low quality level and exports draw (WebGPU, in this browser)'} onClick={p.onBakeLighting}>
          Bake lighting
        </button>
        {p.busy !== null && (
          <button type="button" className="tl-button" onClick={p.onCancel}>
            Cancel
          </button>
        )}
        <button type="button" className="tl-button" disabled={p.busy !== null || p.bake === null} onClick={p.onClear}>
          Clear bake
        </button>
      </div>
      {p.busy !== null && (
        <div className="tl-lighting__progress" role="progressbar" aria-label="bake progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.busy.fraction * 100)}>
          <div className="tl-lighting__bar" style={{ width: `${Math.round(p.busy.fraction * 100)}%` }} />
          <span>{p.busy.text}</span>
        </div>
      )}
      {p.lightingUnavailable !== null && (
        <p className="tl-hint" aria-label="lighting bake unavailable">
          Lighting: {p.lightingUnavailable}.
        </p>
      )}
      {p.message !== null && (
        <p className="tl-lighting__message" role="status">
          {p.message}
        </p>
      )}
    </div>
  );
}
