/**
 * M3 media / lighting / animation authoring panel (packet 57; authoring.md
 * §A8 rows 5/11/13/14/15/16/17).
 *
 * Display + intent only: every action runs the pure planning layer
 * (`session/media.ts`) and issues the accepted backend command through the
 * session client (the sole mutation path — the backend projection stays
 * authoritative). Five tabs: the cue pickers (row 5 — `setGameConfig` partial
 * edit with the `cues` field replacing whole), the checkpoint activation
 * appearance (row 11 — the `setComponent(gameZone, {activation})` partial
 * edit), the light panel (rows 13/14 — one directional + one ambient, the
 * §23.10 scene limit), the material panel (rows 15/16 — the `surface` values
 * + the three built-in presets via `applySurfacePreset`) and the animation
 * panel (row 17 — the `modelAnimation` version + role bindings). The cue
 * PREVIEW plays committed bytes through the injected preview-audio owner
 * (explicit local gesture; the authoring token stays the session credential
 * of the content read, never a resource).
 */
import { useEffect, useState, type JSX } from 'react';
import type { ProjectedEntity } from '../session/projection';
import type { AssetView } from '../session/content-projection';
import type { GameConfigLike } from '../session/gameplay';
import {
  CUE_SLOTS,
  SURFACE_PRESETS,
  SURFACE_PRESET_NAMES,
  planCueEdit,
  planSetLight,
  planSetSurface,
  planSetModelAnimation,
  planSetActivation,
  validateActivationCue,
  lightCounts,
  type CueSlot,
  type LightView,
  type SurfaceView,
  type SurfacePresetName,
  type AnimationRoleKey,
  type AnimationRoleBinding,
} from '../session/media';
import type { PreviewAudioStatus, PreviewAudioDiagnostic } from '../session/preview-audio';

export interface MediaBackendError {
  code: string;
  message: string;
}

interface Props {
  entities: readonly ProjectedEntity[];
  selected: ProjectedEntity | null;
  gameConfig: GameConfigLike | null;
  gameConfigLoaded: boolean;
  assets: readonly AssetView[];
  /** The clip names of the selected model asset's last inspected version
   * (when the editor still holds them — a just-imported version); `null`
   * otherwise (the bindings are free-form, the backend validates). */
  clipNames: readonly string[] | null;
  backendError: MediaBackendError | null;
  onDismissError: () => void;
  onSaveCues: (args: { cues: Record<CueSlot, string | null> }) => void;
  onAddLight: (type: 'directional' | 'ambient') => void;
  onSaveLight: (entityId: string, value: Partial<LightView>) => void;
  onSaveSurface: (entityId: string, value: Partial<SurfaceView>) => void;
  onApplyPreset: (entityId: string, preset: SurfacePresetName) => void;
  onSaveAnimation: (entityId: string, value: { assetId: string; version: number; roles: Record<AnimationRoleKey, AnimationRoleBinding> }) => void;
  onSaveActivation: (entityId: string, value: { activation: { emissive: string; emissiveIntensity: number; cueAssetId: string | null } }) => void;
  previewStatus: PreviewAudioStatus;
  previewDiagnostics: readonly PreviewAudioDiagnostic[];
  onUnlockPreview: () => void;
  onPreviewCue: (assetId: string) => void;
}

function ErrorList({ errors, onDismiss }: { errors: string[]; onDismiss: () => void }): JSX.Element | null {
  if (errors.length === 0) return null;
  return (
    <div className="tl-media__errors" role="alert">
      <ul>
        {errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
      <button className="tl-btn tl-btn--small" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  );
}

function AudioOptions({ assets }: { assets: readonly AssetView[] }): JSX.Element[] {
  const audio = assets.filter((a) => a.kind === 'audio');
  return audio.map((a) => (
    <option key={a.assetId} value={a.assetId}>
      {a.displayName} (v{a.currentVersion})
    </option>
  ));
}

// ---------------------------------------------------------------------------
// Cues tab (row 5) — the `setGameConfig` partial edit with the `cues` field
// ---------------------------------------------------------------------------

function CuesTab({
  gameConfig,
  gameConfigLoaded,
  assets,
  onSaveCues,
  onPreviewCue,
  previewStatus,
  onUnlockPreview,
  previewDiagnostics,
}: {
  gameConfig: GameConfigLike | null;
  gameConfigLoaded: boolean;
  assets: readonly AssetView[];
  onSaveCues: (args: { cues: Record<CueSlot, string | null> }) => void;
  onPreviewCue: (assetId: string) => void;
  previewStatus: PreviewAudioStatus;
  onUnlockPreview: () => void;
  previewDiagnostics: readonly PreviewAudioDiagnostic[];
}): JSX.Element {
  const current = gameConfig?.cues ?? { start: null, jump: null, checkpoint: null, death: null, goal: null };
  const [picks, setPicks] = useState<Record<CueSlot, string>>(() => {
    const p = {} as Record<CueSlot, string>;
    for (const s of CUE_SLOTS) p[s] = current[s] ?? '';
    return p;
  });
  const [errors, setErrors] = useState<string[]>([]);
  // Re-sync the picks when the backend block changes (MCP edit / undo).
  const configKey = CUE_SLOTS.map((s) => `${s}=${current[s] ?? ''}`).join('|');
  useEffect(() => {
    const p = {} as Record<CueSlot, string>;
    for (const s of CUE_SLOTS) p[s] = current[s] ?? '';
    setPicks(p);
    setErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configKey]);

  const save = (): void => {
    const errs: string[] = [];
    const picksClean: Partial<Record<CueSlot, string | null>> = {};
    for (const s of CUE_SLOTS) {
      const v = picks[s];
      if (v !== '') picksClean[s] = v;
      else picksClean[s] = null;
    }
    const plan = planCueEdit(gameConfig, picksClean);
    if (plan.kind === 'noop') {
      errs.push('nothing changed — a cue slot only sends when it differs from the stored block');
    } else {
      // The reference preflight: every non-null pick must be an audio asset.
      for (const s of CUE_SLOTS) {
        const v = picksClean[s];
        if (v === null) continue;
        const rec = assets.find((a) => a.assetId === v);
        if (rec === undefined) errs.push(`${s}: "${v}" resolves to no catalog record`);
        else if (rec.kind !== 'audio') errs.push(`${s}: "${v}" is kind ${rec.kind} — a cue reference must be kind "audio"`);
      }
    }
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    if (plan.kind === 'noop') return;
    setErrors([]);
    onSaveCues(plan.args);
  };

  return (
    <div>
      <p className="tl-note">
        Cue slots reference committed audio assets (or are empty). Saving sends one <code>setGameConfig</code> with the full merged <code>cues</code> block; the run uses a slot's asset, or nothing when it is null.
      </p>
      <div className="tl-media__cues">
        {CUE_SLOTS.map((s) => (
          <div className="tl-media__cue-row" key={s}>
            <span className="tl-media__cue-label">{s}</span>
            <select className="tl-input" value={picks[s]} onChange={(e) => setPicks((p) => ({ ...p, [s]: e.target.value }))}>
              <option value="">— none —</option>
              <AudioOptions assets={assets} />
            </select>
            <button
              className="tl-btn tl-btn--small"
              disabled={picks[s] === ''}
              onClick={() => onPreviewCue(picks[s])}
              title="Play the cue through the preview owner (the Enable button below unlocks it)"
            >
              ▶
            </button>
          </div>
        ))}
      </div>
      <div className="tl-gameplay__actions">
        <button className="tl-btn" onClick={save}>
          save cues
        </button>
      </div>
      <div className="tl-subhead">Preview sound</div>
      <p className="tl-note">
        Status: <code>{previewStatus.state}{previewStatus.state === 'ready' ? (previewStatus.muted ? ' (muted)' : '') : ''}</code>. The context is created by the real gesture below only (no autoplay); the cue bytes come from the editor's content read (the token is that read's credential, never a resource).
      </p>
      {previewStatus.state === 'blocked' && (
        <button className="tl-btn" onClick={onUnlockPreview}>
          enable preview sound
        </button>
      )}
      {previewDiagnostics.length > 0 && (
        <div className="tl-media__diag">
          {previewDiagnostics.slice(-4).map((d, i) => (
            <div key={i} className="tl-media__diag-line">
              <code>{d.code}</code> {d.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checkpoint activation appearance (row 11)
// ---------------------------------------------------------------------------

function CheckpointTab({
  entities,
  selected,
  assets,
  onSaveActivation,
}: {
  entities: readonly ProjectedEntity[];
  selected: ProjectedEntity | null;
  assets: readonly AssetView[];
  onSaveActivation: (entityId: string, value: { activation: { emissive: string; emissiveIntensity: number; cueAssetId: string | null } }) => void;
}): JSX.Element {
  const checkpoint = selected?.gameZone?.role === 'checkpoint' ? selected : null;
  const audioAssets = assets.filter((a) => a.kind === 'audio');
  const act = checkpoint?.gameZone?.activation;
  const [emissive, setEmissive] = useState('#1bc8ff');
  const [intensity, setIntensity] = useState('1.2');
  const [cueAssetId, setCueAssetId] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const cpKey = checkpoint?.id ?? null;
  useEffect(() => {
    if (checkpoint?.gameZone) {
      const a = checkpoint.gameZone.activation;
      setEmissive(a?.emissive ?? '#1bc8ff');
      setIntensity(String(a?.emissiveIntensity ?? 1.2));
      setCueAssetId(a?.cueAssetId ?? '');
    }
    setErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cpKey]);

  if (checkpoint === null) {
    return <p className="tl-note">Select the checkpoint zone in the Hierarchy (or the viewport) to edit its activation appearance.</p>;
  }
  const save = (): void => {
    const errs: string[] = [];
    const form = { emissive, emissiveIntensity: intensity, cueAssetId };
    const plan = planSetActivation(checkpoint.id, act ?? null, form);
    const cueErrs = validateActivationCue(plan.kind === 'noop' ? null : (form.cueAssetId.trim() === '' ? null : form.cueAssetId.trim()), audioAssets);
    errs.push(...cueErrs);
    if (plan.kind === 'noop' && errs.length === 0) errs.push('nothing changed');
    if (errs.length > 0) {
      setErrors(errs);
      return;
    }
    if (plan.kind === 'noop') return;
    setErrors([]);
    onSaveActivation(checkpoint.id, plan.args.value);
  };
  return (
    <div>
      <p className="tl-note">
        The activation appearance is the checkpoint's look + its cue reference. An empty cue reference uses the run's <code>content.game.cues.checkpoint</code> (the Cues tab). Select: <code>{checkpoint.id}</code>
      </p>
      <label className="tl-field">
        <span className="tl-field__label">emissive (#rrggbb)</span>
        <input className="tl-input" value={emissive} maxLength={7} onChange={(e) => setEmissive(e.target.value)} />
      </label>
      <label className="tl-field">
        <span className="tl-field__label">emissive intensity (0–4)</span>
        <input className="tl-input tl-input--num" value={intensity} onChange={(e) => setIntensity(e.target.value)} />
      </label>
      <label className="tl-field">
        <span className="tl-field__label">cue asset (empty = the game's checkpoint cue)</span>
        <select className="tl-input" value={cueAssetId} onChange={(e) => setCueAssetId(e.target.value)}>
          <option value="">— the game's checkpoint cue —</option>
          <AudioOptions assets={assets} />
        </select>
      </label>
      <div className="tl-gameplay__actions">
        <button className="tl-btn" onClick={save}>
          save activation
        </button>
      </div>
    </div>
  );
}
// ---------------------------------------------------------------------------
// Lights tab (rows 13/14) — one directional + one ambient (§23.10 limit)
// ---------------------------------------------------------------------------

function LightsTab({
  entities,
  selected,
  onAddLight,
  onSaveLight,
}: {
  entities: readonly ProjectedEntity[];
  selected: ProjectedEntity | null;
  onAddLight: (type: 'directional' | 'ambient') => void;
  onSaveLight: (entityId: string, value: Partial<LightView>) => void;
}): JSX.Element {
  const counts = lightCounts(entities);
  // Phase 9.5: point, spot and hemisphere lights are edited in the Inspector.
  const lightEntity = selected !== null && (selected.light?.type === 'directional' || selected.light?.type === 'ambient') ? selected : null;
  const light = (lightEntity?.light ?? null) as (LightView & { type: 'directional' | 'ambient' }) | null;
  const [color, setColor] = useState('#ffffff');
  const [intensity, setIntensity] = useState('2');
  const [dx, setDx] = useState('0.35');
  const [dy, setDy] = useState('-1');
  const [dz, setDz] = useState('0.55');
  const [castShadow, setCastShadow] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const lightKey = `${lightEntity?.id ?? ''}:${light?.type ?? ''}`;
  useEffect(() => {
    if (lightEntity?.light) {
      const l = lightEntity.light;
      setColor(l.color);
      setIntensity(String(l.intensity));
      setDx(String(l.direction?.[0] ?? 0.35));
      setDy(String(l.direction?.[1] ?? -1));
      setDz(String(l.direction?.[2] ?? 0.55));
      setCastShadow(l.castShadow ?? false);
    }
    setErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lightKey]);

  if (lightEntity === null || light === null) {
    return (
      <div>
        <p className="tl-note">
          The scene limit is <b>one directional (key) + one ambient (fill)</b> light (§23.10). The directional light carries the derived shadow camera (presentation.md §41.1); its <code>castShadow</code> is the author's shadow switch.
        </p>
        <div className="tl-gameplay__actions">
          <button className="tl-btn" disabled={counts.directional >= 1} onClick={() => onAddLight('directional')} title={counts.directional >= 1 ? 'the scene already carries a directional light' : 'Create the key light (derived entity id light-NNNN)'}>
            + key light ({counts.directional}/1)
          </button>
          <button className="tl-btn" disabled={counts.ambient >= 1} onClick={() => onAddLight('ambient')} title={counts.ambient >= 1 ? 'the scene already carries an ambient light' : 'Create the fill light (derived entity id light-NNNN)'}>
            + fill light ({counts.ambient}/1)
          </button>
        </div>
        <p className="tl-note">Select a light entity in the Hierarchy to edit its values.</p>
      </div>
    );
  }
  const isDir = light.type === 'directional';
  const save = (): void => {
    const form = { type: light.type, color, intensity, directionX: dx, directionY: dy, directionZ: dz, castShadow };
    const plan = planSetLight(lightEntity.id, light, form);
    if (plan.kind === 'noop') {
      setErrors(['nothing changed (values outside 0–8 or a zero/oversized direction are refused here and by the backend)']);
      return;
    }
    setErrors([]);
    onSaveLight(lightEntity.id, plan.args.value);
  };
  return (
    <div>
      <p className="tl-note">
        Select: <code>{lightEntity.id}</code> · type <b>{light.type}</b> (the type is fixed at creation — the directional-only fields appear/disappear with it).
      </p>
      <label className="tl-field">
        <span className="tl-field__label">color (#rrggbb)</span>
        <input className="tl-input" value={color} maxLength={7} onChange={(e) => setColor(e.target.value)} />
      </label>
      <label className="tl-field">
        <span className="tl-field__label">intensity (0–8)</span>
        <input className="tl-input tl-input--num" value={intensity} onChange={(e) => setIntensity(e.target.value)} />
      </label>
      {isDir && light.direction !== undefined && (
        <>
          <div className="tl-gameplay__grid">
            <label className="tl-field">
              <span className="tl-field__label">direction x (|v| ≤ 1)</span>
              <input className="tl-input tl-input--num" value={dx} onChange={(e) => setDx(e.target.value)} />
            </label>
            <label className="tl-field">
              <span className="tl-field__label">direction y</span>
              <input className="tl-input tl-input--num" value={dy} onChange={(e) => setDy(e.target.value)} />
            </label>
            <label className="tl-field">
              <span className="tl-field__label">direction z</span>
              <input className="tl-input tl-input--num" value={dz} onChange={(e) => setDz(e.target.value)} />
            </label>
            <label className="tl-field">
              <span className="tl-field__label">cast shadow</span>
              <input type="checkbox" checked={castShadow} onChange={(e) => setCastShadow(e.target.checked)} />
            </label>
          </div>
          <p className="tl-note">The direction must have norm ≥ 1e-6 (each component |v| ≤ 1); the shadow camera derives from it (the author never sets the camera).</p>
        </>
      )}
      <div className="tl-gameplay__actions">
        <button className="tl-btn" onClick={save}>
          save light
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Material tab (rows 15/16) — the `surface` values + the three presets
// ---------------------------------------------------------------------------

function MaterialTab({
  selected,
  onApplyPreset,
  onSaveSurface,
}: {
  selected: ProjectedEntity | null;
  onApplyPreset: (entityId: string, preset: SurfacePresetName) => void;
  onSaveSurface: (entityId: string, value: Partial<SurfaceView>) => void;
}): JSX.Element {
  const target = selected !== null && (selected.kind === 'box' || selected.kind === 'model') ? selected : null;
  const cur: SurfaceView =
    target?.surface ?? { color: '#b0b0b0', roughness: 0.9, metalness: 0, emissive: '#000000', emissiveIntensity: 0 };
  const [color, setColor] = useState(cur.color);
  const [roughness, setRoughness] = useState(String(cur.roughness));
  const [metalness, setMetalness] = useState(String(cur.metalness));
  const [emissive, setEmissive] = useState(cur.emissive);
  const [emissiveIntensity, setEmissiveIntensity] = useState(String(cur.emissiveIntensity));
  const [errors, setErrors] = useState<string[]>([]);
  const targetKey = target?.id ?? null;
  useEffect(() => {
    if (target) {
      const c: SurfaceView = target.surface ?? { color: '#b0b0b0', roughness: 0.9, metalness: 0, emissive: '#000000', emissiveIntensity: 0 };
      setColor(c.color);
      setRoughness(String(c.roughness));
      setMetalness(String(c.metalness));
      setEmissive(c.emissive);
      setEmissiveIntensity(String(c.emissiveIntensity));
    }
    setErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  if (target === null) {
    return <p className="tl-note">Select a box or model entity to edit its copied surface values (the `surface` component sits only on box/model entities).</p>;
  }
  const save = (): void => {
    const plan = planSetSurface(target.id, target.surface ?? null, { color, roughness, metalness, emissive, emissiveIntensity });
    if (plan.kind === 'noop') {
      setErrors(['nothing changed (values outside 0–1 / 0–4 or non-#hex colors are refused here and by the backend)']);
      return;
    }
    setErrors([]);
    onSaveSurface(target.id, plan.args.value);
  };
  return (
    <div>
      <p className="tl-note">
        Select: <code>{target.id}</code>. The values are COPIED onto the entity (never a linked resource); the play renderer realizes them as one standard material.
      </p>
      <div className="tl-gameplay__grid">
        <label className="tl-field">
          <span className="tl-field__label">color (#rrggbb)</span>
          <input className="tl-input" value={color} maxLength={7} onChange={(e) => setColor(e.target.value)} />
        </label>
        <label className="tl-field">
          <span className="tl-field__label">roughness (0–1)</span>
          <input className="tl-input tl-input--num" value={roughness} onChange={(e) => setRoughness(e.target.value)} />
        </label>
        <label className="tl-field">
          <span className="tl-field__label">metalness (0–1)</span>
          <input className="tl-input tl-input--num" value={metalness} onChange={(e) => setMetalness(e.target.value)} />
        </label>
        <label className="tl-field">
          <span className="tl-field__label">emissive (#rrggbb)</span>
          <input className="tl-input" value={emissive} maxLength={7} onChange={(e) => setEmissive(e.target.value)} />
        </label>
        <label className="tl-field">
          <span className="tl-field__label">emissive intensity (0–4)</span>
          <input className="tl-input tl-input--num" value={emissiveIntensity} onChange={(e) => setEmissiveIntensity(e.target.value)} />
        </label>
      </div>
      <div className="tl-gameplay__actions">
        <button className="tl-btn" onClick={save}>
          save surface
        </button>
      </div>
      <div className="tl-subhead">Presets (applySurfacePreset — one undoable edit)</div>
      {SURFACE_PRESET_NAMES.map((name) => (
        <div className="tl-media__preset-row" key={name}>
          <button className="tl-btn" onClick={() => onApplyPreset(target.id, name)} title={`Copy the built-in "${name}" row onto ${target.id} (the exact inverse restores the previous values)`}>
            {name}
          </button>
          <span className="tl-media__preset-desc">
            {SURFACE_PRESETS[name].color} · r{SURFACE_PRESETS[name].roughness} · m{SURFACE_PRESETS[name].metalness} · e{SURFACE_PRESETS[name].emissive}×{SURFACE_PRESETS[name].emissiveIntensity}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animation tab (row 17) — the `modelAnimation` version + role bindings
// ---------------------------------------------------------------------------

const EMPTY_ROLES: Record<AnimationRoleKey, { clipIndex: string; clipName: string }> = {
  idle: { clipIndex: '0', clipName: '' },
  run: { clipIndex: '1', clipName: '' },
  airborne: { clipIndex: '2', clipName: '' },
};

function AnimationTab({
  selected,
  assets,
  clipNames,
  onSaveAnimation,
}: {
  selected: ProjectedEntity | null;
  assets: readonly AssetView[];
  clipNames: readonly string[] | null;
  onSaveAnimation: (entityId: string, value: { assetId: string; version: number; roles: Record<AnimationRoleKey, AnimationRoleBinding> }) => void;
}): JSX.Element {
  const target = selected !== null && selected.kind === 'model' ? selected : null;
  const asset = target?.assetId !== undefined ? assets.find((a) => a.assetId === target.assetId) ?? null : null;
  const maxVersion = asset?.currentVersion ?? 1;
  const [version, setVersion] = useState('1');
  const [roles, setRoles] = useState<Record<AnimationRoleKey, { clipIndex: string; clipName: string }>>(EMPTY_ROLES);
  const [errors, setErrors] = useState<string[]>([]);
  const targetKey = target?.id ?? null;
  useEffect(() => {
    if (target) {
      const anim = target.modelAnimation;
      setVersion(String(anim?.version ?? maxVersion));
      const r = { ...EMPTY_ROLES };
      if (anim) {
        for (const k of ['idle', 'run', 'airborne'] as AnimationRoleKey[]) {
          const b = anim.roles[k] as { clipIndex?: unknown; clipName?: unknown };
          r[k] = { clipIndex: String(typeof b.clipIndex === 'number' ? b.clipIndex : 0), clipName: typeof b.clipName === 'string' ? b.clipName : '' };
        }
      }
      setRoles(r);
    }
    setErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  if (target === null) {
    return <p className="tl-note">Select the model entity to edit its animation profile (the `modelAnimation` component sits only on model entities and its assetId is fixed to the entity's model asset).</p>;
  }
  const save = (): void => {
    const plan = planSetModelAnimation(target.id, target, { version, roles }, maxVersion);
    if (plan.kind === 'noop') {
      setErrors(['nothing changed (clipIndex must be a non-negative integer, each clipName non-empty, version within 1–' + maxVersion + ')']);
      return;
    }
    setErrors([]);
    onSaveAnimation(target.id, plan.args.value);
  };
  return (
    <div>
      <p className="tl-note">
        Select: <code>{target.id}</code> · asset <code>{target.assetId}</code> (v{maxVersion}). The runtime resolves the bindings against the version's real clip list (a mismatch refuses with the stage-3/5 reason at play time — presentation.md §41.3.2); the editor preflights the shape only.
      </p>
      {clipNames !== null && clipNames.length > 0 && (
        <p className="tl-note">
          The just-imported version's clips: {clipNames.map((n) => <code key={n}>{n}</code>)} (index = order in this list).
        </p>
      )}
      <label className="tl-field">
        <span className="tl-field__label">model version (1–{maxVersion})</span>
        <select className="tl-input" value={version} onChange={(e) => setVersion(e.target.value)}>
          {Array.from({ length: maxVersion }, (_, i) => i + 1).map((v) => (
            <option key={v} value={String(v)}>
              v{v}
            </option>
          ))}
        </select>
      </label>
      {(['idle', 'run', 'airborne'] as AnimationRoleKey[]).map((k) => (
        <div className="tl-media__role-row" key={k}>
          <span className="tl-media__cue-label">{k}</span>
          <input
            className="tl-input tl-input--num"
            value={roles[k].clipIndex}
            onChange={(e) => setRoles((r) => ({ ...r, [k]: { ...r[k], clipIndex: e.target.value } }))}
            title="clipIndex — the clip's index in the version's stored clip list"
          />
          <input
            className="tl-input"
            value={roles[k].clipName}
            onChange={(e) => setRoles((r) => ({ ...r, [k]: { ...r[k], clipName: e.target.value } }))}
            placeholder="clipName (the stored clip name)"
            title="clipName — must equal the stored name of clipIndex at play time (stage 5)"
          />
        </div>
      ))}
      <div className="tl-gameplay__actions">
        <button className="tl-btn" onClick={save}>
          save animation profile
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The panel shell
// ---------------------------------------------------------------------------

const TABS = ['cues', 'checkpoint', 'lights', 'material', 'animation'] as const;
type Tab = (typeof TABS)[number];

export function MediaPanel(props: Props): JSX.Element {
  const [tab, setTab] = useState<Tab>('cues');
  return (
    <div className="tl-panel tl-media">
      <div className="tl-panel__title">Media</div>
      <div className="tl-media__tabs">
        {TABS.map((t) => (
          <button key={t} className={`tl-btn tl-media__tab-btn${tab === t ? ' is-active' : ''}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div className="tl-media__tab">
        {props.backendError !== null && (
          <div className="tl-gameplay__errors" role="alert">
            <div className="tl-gameplay__errors-title">{props.backendError.code}</div>
            <ul>
              <li>{props.backendError.message}</li>
            </ul>
            <button className="tl-btn tl-btn--small" onClick={props.onDismissError}>
              dismiss
            </button>
          </div>
        )}
        {tab === 'cues' && (
          <CuesTab
            gameConfig={props.gameConfig}
            gameConfigLoaded={props.gameConfigLoaded}
            assets={props.assets}
            onSaveCues={props.onSaveCues}
            onPreviewCue={props.onPreviewCue}
            previewStatus={props.previewStatus}
            onUnlockPreview={props.onUnlockPreview}
            previewDiagnostics={props.previewDiagnostics}
          />
        )}
        {tab === 'checkpoint' && <CheckpointTab entities={props.entities} selected={props.selected} assets={props.assets} onSaveActivation={props.onSaveActivation} />}
        {tab === 'lights' && <LightsTab entities={props.entities} selected={props.selected} onAddLight={props.onAddLight} onSaveLight={props.onSaveLight} />}
        {tab === 'material' && <MaterialTab selected={props.selected} onApplyPreset={props.onApplyPreset} onSaveSurface={props.onSaveSurface} />}
        {tab === 'animation' && <AnimationTab selected={props.selected} assets={props.assets} clipNames={props.clipNames} onSaveAnimation={props.onSaveAnimation} />}
      </div>
    </div>
  );
}
