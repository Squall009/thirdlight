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
 * Above the bake, the Scene view's lighting: the quality level it previews
 * (each level's lighting tier; "as Play" is the project's level, else the
 * device's), live lighting on or held to the saved light (both view only,
 * nothing is saved), and the previewed level's lighting settings — surface
 * cache memory, live-light time, contact shadows, reflections — which are
 * the project's: an edit is `setEnvironment` on its quality levels, the
 * command Project Settings → Quality and MCP send (the engine's levels are
 * copied into the project's first, as "Customize levels" does there).
 *
 * Browser-only (React).
 */
import { useState, type JSX } from 'react';
import type { LightingBake, QualityLevelConfig } from '@thirdlight/project-model';
import { LIGHTING_TIER_SETTINGS, levelLighting } from '@thirdlight/runtime';
import { REFLECTION_QUALITIES, SURFACE_CACHE_MIB_MAX, SURFACE_CACHE_MIB_MIN, SURFACE_LIGHT_MS_MAX, SURFACE_LIGHT_MS_MIN } from '@thirdlight/project-model/limits';

import { lightingBakeSummary } from '../viewport/lighting-bake-run';
import type { SceneLightingState } from '../viewport/lighting-view';

/** A quality level's lighting fields the Lighting window sets (undefined: the tier's value). */
export type LevelLightingEdit = Partial<Pick<QualityLevelConfig, 'surfaceCacheMiB' | 'surfaceLightMs' | 'contactShadows' | 'reflections'>>;

/** What the Scene view draws now (the adapter's lighting report; null: not drawn yet). */
export interface SceneLightingNow {
  readonly level: string;
  readonly tier: string;
  readonly live: boolean;
  readonly off: string | null;
}

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
  /** The Scene view's preview (level, live) and what it draws now. */
  preview: SceneLightingState;
  onPreview: (next: SceneLightingState) => void;
  drawn: SceneLightingNow | null;
  /** The project's quality levels (the engine's when it lists none), lowest first. */
  levels: readonly QualityLevelConfig[];
  /** Set (or with undefined, clear) a level's lighting fields: `setEnvironment` on the project's levels. */
  onEditLevel: (levelId: string, edit: LevelLightingEdit) => void;
  /** The last refused edit (null: none). */
  levelError: string | null;
}

/** A number field that saves on Enter or when it loses focus (empty: the tier's value). */
function NumberField(p: { label: string; title: string; value: number | undefined; placeholder: number; min: number; max: number; step: number; onSave: (v: number | undefined) => void }): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const save = (): void => {
    if (text === null) return;
    const t = text.trim();
    setText(null);
    if (t === '') return p.onSave(undefined);
    const v = Number(t);
    if (Number.isFinite(v)) p.onSave(Math.min(p.max, Math.max(p.min, v)));
  };
  return (
    <label className="tl-field" title={p.title}>
      <span className="tl-field__label">{p.label}</span>
      <input
        className="tl-input"
        type="number"
        aria-label={p.label}
        min={p.min}
        max={p.max}
        step={p.step}
        placeholder={String(p.placeholder)}
        value={text ?? (p.value === undefined ? '' : String(p.value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
        }}
      />
    </label>
  );
}

/** The Scene view's lighting: the level previewed, live or saved, and that level's lighting settings. */
function SceneLighting(p: Props): JSX.Element {
  const shown = p.preview.level ?? p.drawn?.level ?? p.levels[p.levels.length - 1]?.id ?? null;
  const level = p.levels.find((l) => l.id === shown) ?? null;
  const lit = level === null ? null : levelLighting(level);
  const tier = lit === null ? null : LIGHTING_TIER_SETTINGS[lit.tier];
  const state = p.drawn === null ? 'not drawn yet' : p.drawn.live ? `live, ${p.drawn.tier} tier` : `saved light, ${p.drawn.tier} tier${p.drawn.off === 'no-webgpu' ? ' (WebGL 2)' : p.drawn.off === 'no-budget' && p.preview.live ? ' (no live-light time at this level)' : ''}`;
  return (
    <section className="tl-lighting__scene" aria-label="scene view lighting">
      <div className="tl-panel__subtitle">Scene view</div>
      <label className="tl-field" title="The quality level the Scene view draws at (view only). As Play: the project's starting level, else this device's.">
        <span className="tl-field__label">Preview level</span>
        <select className="tl-input" aria-label="preview quality level" value={p.preview.level ?? ''} onChange={(e) => p.onPreview({ ...p.preview, level: e.target.value === '' ? null : e.target.value })}>
          <option value="">As Play{p.drawn !== null && p.preview.level === null ? ` (${p.drawn.level})` : ''}</option>
          {p.levels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name ?? l.id} ({levelLighting(l).tier} tier)
            </option>
          ))}
        </select>
      </label>
      <label className="tl-field tl-field--check" title="Off: the Scene view draws the saved light only, as WebGL 2 and the low tier do (view only).">
        <input type="checkbox" aria-label="live lighting" checked={p.preview.live} onChange={(e) => p.onPreview({ ...p.preview, live: e.target.checked })} />
        <span>Live lighting</span>
      </label>
      <p className="tl-hint" aria-label="scene view lighting state">
        Drawing: {p.drawn === null ? state : `level ${p.drawn.level}, ${state}`}.
      </p>
      {level !== null && lit !== null && tier !== null && (
        <div className="tl-lighting__level" aria-label="level lighting" data-level={level.id}>
          <div className="tl-panel__subtitle">
            Level {level.name ?? level.id} ({lit.tier} tier)
          </div>
          <NumberField label="Surface cache (MiB)" title={`Memory the static surfaces' light may hold around the view (empty: the tier's, ${tier.surfaceCacheMiB}).`} value={level.surfaceCacheMiB} placeholder={tier.surfaceCacheMiB} min={SURFACE_CACHE_MIB_MIN} max={SURFACE_CACHE_MIB_MAX} step={16} onSave={(v) => p.onEditLevel(level.id, { surfaceCacheMiB: v })} />
          <NumberField label="Live light (ms a frame)" title={`GPU time a frame for re-lighting what changed; 0 draws the saved light only (empty: the tier's, ${tier.surfaceLightMs}).`} value={level.surfaceLightMs} placeholder={tier.surfaceLightMs} min={SURFACE_LIGHT_MS_MIN} max={SURFACE_LIGHT_MS_MAX} step={0.5} onSave={(v) => p.onEditLevel(level.id, { surfaceLightMs: v })} />
          <label className="tl-field" title="Screen-space contact shadows on the sun's light.">
            <span className="tl-field__label">Contact shadows</span>
            <select className="tl-input" aria-label="contact shadows" value={level.contactShadows === undefined ? '' : level.contactShadows ? 'on' : 'off'} onChange={(e) => p.onEditLevel(level.id, { contactShadows: e.target.value === '' ? undefined : e.target.value === 'on' })}>
              <option value="">Tier ({tier.contactShadows ? 'on' : 'off'})</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </select>
          </label>
          <label className="tl-field" title="Reflections on glossy surfaces: screen-space rays, traced through the static world where they miss.">
            <span className="tl-field__label">Reflections</span>
            <select className="tl-input" aria-label="reflections" value={level.reflections ?? ''} onChange={(e) => p.onEditLevel(level.id, { reflections: e.target.value === '' ? undefined : (e.target.value as (typeof REFLECTION_QUALITIES)[number]) })}>
              <option value="">Tier ({tier.reflections})</option>
              {REFLECTION_QUALITIES.map((q) => (
                <option key={q} value={q}>
                  {q}
                </option>
              ))}
            </select>
          </label>
          {p.levelError !== null && (
            <div className="tl-prop__error" role="alert">
              {p.levelError}
            </div>
          )}
        </div>
      )}
    </section>
  );
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
      <SceneLighting {...p} />
      <p className="tl-hint">
        Static surfaces (block layers, terrain, generated architecture, static models) keep the light of the lights and static glowing boxes set to <b>baked</b>
        (direct light and bounce) and the bounce of those set to <b>mixed</b> (their direct light stays per pixel). Baked lights then no longer light per pixel.
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
