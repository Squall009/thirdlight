/**
 * Phase 9.4/9.5: the Environment window — sky, fog, post-processing, quality
 * and the global wind. The Scene view previews it with game lighting (the
 * same renderer Play and export use). Each control commits on release as one
 * `setEnvironment` (one undo).
 *
 * Phase 14.4: with `level` it edits that level's look instead (the Game flow
 * window's "Level look…"): each part (sky, fog, post, wind) switched on for
 * the level replaces the project's while the level plays (post merges per
 * effect); every change is one `setFlow`.
 *
 * Browser-only (React).
 */
import { useEffect, useState, type JSX } from 'react';
import type { EnvironmentConfig, FogConfig, LevelEnvironment, PostConfig, SkyConfig, WindConfig } from '@thirdlight/project-model';
import { DEFAULT_WIND } from '../session/material-schema';

interface Props {
  environment: EnvironmentConfig | null;
  textures: readonly { assetId: string; displayName: string }[];
  onSave: (environment: EnvironmentConfig) => void;
  error: string | null;
  /** Phase 14.4: edit this level's look (over the project environment) instead of the project environment. */
  level?: { id: string; name: string; environment: LevelEnvironment | null; onSave: (environment: LevelEnvironment | null) => void; onBack: () => void };
}

type LevelPart = 'sky' | 'fog' | 'post' | 'wind';
const PART_LABEL: Record<LevelPart, string> = { sky: 'sky', fog: 'fog', post: 'post-processing', wind: 'wind' };

const round = (v: number, d = 3): number => Number(v.toFixed(d));

/** A slider committed on release (with its value shown). */
function Slider(props: { label: string; name: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void }): JSX.Element {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <span className="tl-param__number">
        <input
          type="range"
          aria-label={props.name}
          min={props.min}
          max={props.max}
          step={props.step}
          value={v}
          onChange={(e) => setV(Number(e.target.value))}
          onPointerUp={() => v !== props.value && props.onCommit(v)}
          onKeyUp={() => v !== props.value && props.onCommit(v)}
        />
        <span className="tl-param__value">{v.toFixed(props.step < 0.01 ? 3 : props.step < 1 ? 2 : 0)}</span>
      </span>
    </label>
  );
}

function Colour(props: { label: string; name: string; value: string; onCommit: (v: string) => void }): JSX.Element {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <input type="color" aria-label={props.name} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== props.value && props.onCommit(v)} />
    </label>
  );
}

function Choice<T extends string>(props: { label: string; name: string; value: T; options: readonly (readonly [T, string])[]; onCommit: (v: T) => void }): JSX.Element {
  return (
    <label className="tl-field">
      <span className="tl-field__label">{props.label}</span>
      <select className="tl-input" aria-label={props.name} value={props.value} onChange={(e) => props.onCommit(e.target.value as T)}>
        {props.options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle(props: { label: string; name: string; value: boolean; onCommit: (v: boolean) => void }): JSX.Element {
  const [v, setV] = useState(props.value);
  useEffect(() => setV(props.value), [props.value]);
  return (
    <label className="tl-flag">
      <input
        type="checkbox"
        aria-label={props.name}
        checked={v}
        onChange={(e) => {
          setV(e.target.checked);
          props.onCommit(e.target.checked);
        }}
      />
      {props.label}
    </label>
  );
}

export function EnvironmentPanel(p: Props): JSX.Element {
  const lv = p.level;
  const project: EnvironmentConfig = p.environment ?? {};
  const override: LevelEnvironment = lv?.environment ?? {};
  // What the level plays with: the project's parts, the level's own laid over them (post per effect).
  const env: EnvironmentConfig =
    lv === undefined ? project : { ...project, ...override, ...(override.post !== undefined ? { post: { ...(project.post ?? {}), ...override.post } } : {}) };
  const saveLevel = (next: LevelEnvironment): void => {
    const clean = Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== undefined && k !== 'quality')) as LevelEnvironment;
    lv!.onSave(Object.keys(clean).length > 0 ? clean : null);
  };
  const save = (patch: Partial<EnvironmentConfig>): void => (lv !== undefined ? saveLevel({ ...override, ...patch }) : p.onSave({ ...env, ...patch }));
  /** In level mode a part is edited only when the level has its own; the project's parts are always edited. */
  const own = (k: LevelPart): boolean => lv === undefined || override[k] !== undefined;
  const ownToggle = (k: LevelPart, fallback: () => unknown): JSX.Element | null =>
    lv === undefined ? null : (
      <>
        <Toggle
          label={`this level has its own ${PART_LABEL[k]}`}
          name={`level own ${k}`}
          value={override[k] !== undefined}
          onCommit={(on) => {
            const next: Record<string, unknown> = { ...override };
            if (on) next[k] = JSON.parse(JSON.stringify(env[k] ?? fallback()));
            else delete next[k];
            saveLevel(next as LevelEnvironment);
          }}
        />
        {override[k] === undefined && <p className="tl-hint">uses the project's {PART_LABEL[k]}</p>}
      </>
    );
  const sky: SkyConfig = env.sky ?? { mode: 'procedural' };
  const setSky = (patch: Partial<SkyConfig>): void => save({ sky: { ...sky, ...patch } });
  const fog: FogConfig = env.fog ?? { mode: 'none', color: '#c8d8e8' };
  const setFog = (patch: Partial<FogConfig>): void => save({ fog: { ...fog, ...patch } });
  const post: PostConfig = env.post ?? {};
  const setPost = (patch: Partial<PostConfig>): void => save({ post: { ...post, ...patch } });
  const wind: WindConfig = env.wind ?? { ...DEFAULT_WIND, direction: [...DEFAULT_WIND.direction] as [number, number] };
  const setWind = (patch: Partial<WindConfig>): void => save({ wind: { ...wind, ...patch } });
  const angle = Math.round((Math.atan2(wind.direction[1], wind.direction[0]) * 180) / Math.PI);
  const textureOptions = [['', '— none —'] as const, ...p.textures.map((t) => [t.assetId, t.displayName] as const)];

  return (
    <div className="tl-panel tl-environment">
      <div className="tl-panel__title">
        <img className="tl-row__icon" src="./icons/sky.png" alt="" aria-hidden="true" /> Environment
      </div>
      {lv === undefined ? (
        <p className="tl-inspector__hint">The Scene view shows this with game lighting (toolbar “light: game”); Play and the export use the same.</p>
      ) : (
        <div className="tl-animator__row" aria-label="level look">
          <strong>Level look: {lv.name}</strong>
          <span className="tl-inspector__hint">Each part this level has its own replaces the project's while it plays (post-processing per effect). The Scene view shows it with “level look” on.</span>
          <button type="button" className="tl-button" onClick={lv.onBack}>
            project environment
          </button>
        </div>
      )}
      <div className="tl-environment__grid">
        <section className="tl-inspector__section" aria-label="sky">
          <div className="tl-subhead">Sky</div>
          {ownToggle('sky', () => ({ mode: 'procedural' }))}
          {own('sky') && (
            <Choice
              label="sky"
              name="sky mode"
              value={env.sky === undefined ? ('' as 'procedural') : sky.mode}
              options={[...(lv === undefined ? [['' as 'procedural', '— none (plain background) —'] as const] : []), ['procedural', 'physical (sun + atmosphere)'], ['gradient', 'gradient'], ['texture', 'image'], ['color', 'solid colour']]}
              onCommit={(mode) => ((mode as string) === '' ? save({ sky: undefined as unknown as SkyConfig }) : setSky({ mode }))}
            />
          )}
          {own('sky') && env.sky !== undefined && sky.mode === 'procedural' && (
            <>
              <Toggle label="sun from the directional light" name="sun from light" value={sky.sunFromLight !== false} onCommit={(v) => setSky({ sunFromLight: v })} />
              {sky.sunFromLight === false && (
                <>
                  <Slider label="sun elevation" name="sun elevation" value={sky.sunElevation ?? 35} min={-10} max={90} step={1} onCommit={(v) => setSky({ sunElevation: v })} />
                  <Slider label="sun azimuth" name="sun azimuth" value={sky.sunAzimuth ?? 160} min={-180} max={180} step={1} onCommit={(v) => setSky({ sunAzimuth: v })} />
                </>
              )}
              <Slider label="haze (turbidity)" name="sky turbidity" value={sky.turbidity ?? 6} min={1} max={20} step={0.1} onCommit={(v) => setSky({ turbidity: v })} />
              <Slider label="blue scatter" name="sky rayleigh" value={sky.rayleigh ?? 1.5} min={0} max={4} step={0.05} onCommit={(v) => setSky({ rayleigh: v })} />
              <Slider label="sun glow" name="sky mie" value={sky.mieCoefficient ?? 0.005} min={0} max={0.1} step={0.001} onCommit={(v) => setSky({ mieCoefficient: v })} />
            </>
          )}
          {own('sky') && env.sky !== undefined && sky.mode === 'gradient' && (
            <>
              <Colour label="top" name="sky top colour" value={sky.topColor ?? '#3d7cd6'} onCommit={(v) => setSky({ topColor: v })} />
              <Colour label="horizon" name="sky horizon colour" value={sky.horizonColor ?? '#bfe3ff'} onCommit={(v) => setSky({ horizonColor: v })} />
              <Colour label="below" name="sky bottom colour" value={sky.bottomColor ?? '#6b7b5a'} onCommit={(v) => setSky({ bottomColor: v })} />
            </>
          )}
          {own('sky') && env.sky !== undefined && sky.mode === 'color' && <Colour label="colour" name="sky colour" value={sky.color ?? '#7ec8ff'} onCommit={(v) => setSky({ color: v })} />}
          {own('sky') && env.sky !== undefined && sky.mode === 'texture' && (
            <Choice label="panorama (equirect)" name="sky texture" value={sky.texture ?? ''} options={textureOptions} onCommit={(v) => setSky(v === '' ? { texture: undefined } : { texture: v })} />
          )}
          {own('sky') && env.sky !== undefined && (
            <>
              <Slider label="background brightness" name="sky intensity" value={sky.intensity ?? 1} min={0} max={4} step={0.05} onCommit={(v) => setSky({ intensity: v })} />
              <Slider label="sky lighting (IBL)" name="sky environment intensity" value={sky.environmentIntensity ?? 1} min={0} max={4} step={0.05} onCommit={(v) => setSky({ environmentIntensity: v })} />
            </>
          )}
        </section>

        <section className="tl-inspector__section" aria-label="fog">
          <div className="tl-subhead">Fog (fog volumes: GameObject → Fog volume)</div>
          {ownToggle('fog', () => ({ mode: 'none', color: '#c8d8e8' }))}
          {own('fog') && <Choice label="fog" name="fog mode" value={fog.mode} options={[['none', 'none'], ['linear', 'linear (near → far)'], ['exp2', 'exponential']]} onCommit={(mode) => setFog({ mode })} />}
          {own('fog') && fog.mode !== 'none' && <Colour label="colour" name="fog colour" value={fog.color} onCommit={(v) => setFog({ color: v })} />}
          {own('fog') && fog.mode === 'linear' && (
            <>
              <Slider label="starts at (m)" name="fog near" value={fog.near ?? 10} min={0} max={500} step={1} onCommit={(v) => setFog({ near: v })} />
              <Slider label="full at (m)" name="fog far" value={fog.far ?? 120} min={1} max={2000} step={1} onCommit={(v) => setFog({ far: v })} />
            </>
          )}
          {own('fog') && fog.mode === 'exp2' && <Slider label="density" name="fog density" value={fog.density ?? 0.01} min={0} max={0.2} step={0.001} onCommit={(v) => setFog({ density: v })} />}
        </section>

        <section className="tl-inspector__section" aria-label="post-processing">
          <div className="tl-subhead">Post-processing</div>
          {ownToggle('post', () => ({}))}
          {own('post') && (
          <>
          <Choice label="tone mapping" name="tone mapping" value={post.toneMapping ?? 'agx'} options={[['agx', 'AgX'], ['aces', 'ACES filmic'], ['neutral', 'neutral'], ['none', 'none']]} onCommit={(v) => setPost({ toneMapping: v })} />
          <Slider label="exposure" name="exposure" value={post.exposure ?? 1} min={0} max={4} step={0.05} onCommit={(v) => setPost({ exposure: v })} />
          <Toggle label="bloom" name="bloom" value={post.bloom?.enabled === true} onCommit={(v) => setPost({ bloom: { ...(post.bloom ?? {}), enabled: v } })} />
          {post.bloom?.enabled === true && (
            <>
              <Slider label="bloom strength" name="bloom strength" value={post.bloom.strength ?? 0.6} min={0} max={3} step={0.05} onCommit={(v) => setPost({ bloom: { ...post.bloom!, strength: v } })} />
              <Slider label="bloom threshold" name="bloom threshold" value={post.bloom.threshold ?? 0.85} min={0} max={2} step={0.01} onCommit={(v) => setPost({ bloom: { ...post.bloom!, threshold: v } })} />
              <Slider label="bloom radius" name="bloom radius" value={post.bloom.radius ?? 0.4} min={0} max={1} step={0.01} onCommit={(v) => setPost({ bloom: { ...post.bloom!, radius: v } })} />
            </>
          )}
          <Slider label="brightness" name="grading brightness" value={post.grading?.brightness ?? 0} min={-1} max={1} step={0.01} onCommit={(v) => setPost({ grading: { ...(post.grading ?? {}), brightness: v } })} />
          <Slider label="contrast" name="grading contrast" value={post.grading?.contrast ?? 0} min={-1} max={1} step={0.01} onCommit={(v) => setPost({ grading: { ...(post.grading ?? {}), contrast: v } })} />
          <Slider label="saturation" name="grading saturation" value={post.grading?.saturation ?? 0} min={-1} max={1} step={0.01} onCommit={(v) => setPost({ grading: { ...(post.grading ?? {}), saturation: v } })} />
          <Slider label="lift (blacks)" name="grading lift" value={post.grading?.lift ?? 0} min={-0.5} max={0.5} step={0.01} onCommit={(v) => setPost({ grading: { ...(post.grading ?? {}), lift: v } })} />
          <Slider label="gamma (mid-tones)" name="grading gamma" value={post.grading?.gamma ?? 1} min={0.2} max={5} step={0.01} onCommit={(v) => setPost({ grading: { ...(post.grading ?? {}), gamma: v } })} />
          <Slider label="gain (whites)" name="grading gain" value={post.grading?.gain ?? 1} min={0} max={4} step={0.01} onCommit={(v) => setPost({ grading: { ...(post.grading ?? {}), gain: v } })} />
          <Colour label="tint" name="grading tint" value={post.grading?.tint ?? '#ffffff'} onCommit={(v) => setPost({ grading: { ...(post.grading ?? {}), tint: v } })} />
          <Choice label="LUT (strip image)" name="grading lut" value={post.grading?.lut ?? ''} options={textureOptions} onCommit={(v) => setPost({ grading: { ...(post.grading ?? {}), lut: v === '' ? undefined : v } })} />
          <Toggle label="vignette" name="vignette" value={post.vignette?.enabled === true} onCommit={(v) => setPost({ vignette: { ...(post.vignette ?? {}), enabled: v } })} />
          {post.vignette?.enabled === true && <Slider label="vignette darkness" name="vignette darkness" value={post.vignette.darkness ?? 0.5} min={0} max={1} step={0.01} onCommit={(v) => setPost({ vignette: { ...post.vignette!, darkness: v } })} />}
          <Toggle label="ambient occlusion (high quality)" name="ssao" value={post.ssao?.enabled === true} onCommit={(v) => setPost({ ssao: { ...(post.ssao ?? {}), enabled: v } })} />
          <Toggle label="depth of field (high quality)" name="depth of field" value={post.dof?.enabled === true} onCommit={(v) => setPost({ dof: { ...(post.dof ?? {}), enabled: v } })} />
          {post.dof?.enabled === true && <Slider label="focus distance (m)" name="dof focus" value={post.dof.focus ?? 10} min={0.5} max={100} step={0.5} onCommit={(v) => setPost({ dof: { ...post.dof!, focus: v } })} />}
          <Choice label="anti-aliasing" name="antialias" value={post.antialias ?? 'none'} options={[['none', 'none (MSAA only)'], ['fxaa', 'FXAA'], ['smaa', 'SMAA']]} onCommit={(v) => setPost({ antialias: v })} />
          </>
          )}
          {lv === undefined && <Choice label="quality (default)" name="quality" value={env.quality ?? 'high'} options={[['low', 'low'], ['medium', 'medium'], ['high', 'high']]} onCommit={(v) => save({ quality: v })} />}
        </section>

        <section className="tl-inspector__section" aria-label="wind">
          <div className="tl-subhead">Wind (bends foliage materials by their vertex colour)</div>
          {ownToggle('wind', () => ({ ...DEFAULT_WIND, direction: [...DEFAULT_WIND.direction] }))}
          {own('wind') && (
          <>
          <Slider
            label="direction (°)"
            name="wind direction"
            value={angle}
            min={-180}
            max={180}
            step={5}
            onCommit={(deg) => {
              const a = (deg * Math.PI) / 180;
              setWind({ direction: [round(Math.cos(a)), round(Math.sin(a))] });
            }}
          />
          <Slider label="strength" name="wind strength" value={wind.strength} min={0} max={10} step={0.05} onCommit={(v) => setWind({ strength: v })} />
          <Slider label="gusts" name="wind gust" value={wind.gust} min={0} max={10} step={0.05} onCommit={(v) => setWind({ gust: v })} />
          <Slider label="gusts per second" name="wind gustFrequency" value={wind.gustFrequency} min={0} max={10} step={0.05} onCommit={(v) => setWind({ gustFrequency: v })} />
          <Slider label="turbulence" name="wind turbulence" value={wind.turbulence} min={0} max={1} step={0.01} onCommit={(v) => setWind({ turbulence: v })} />
          </>
          )}
        </section>
      </div>
      {p.error !== null && <div className="tl-assets__error" role="alert">{p.error}</div>}
    </div>
  );
}
