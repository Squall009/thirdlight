/**
 * Asset/content browser panel (React, decision 0001 §10; packet 27).
 *
 * Display + intent only: every action issues the typed backend command / route
 * through the session client (the sole mutation path). The panel shows the
 * bounded query page, the import flow's job/failure/cancel status, the local
 * clip preview controls and the placement availability. No decorative or graph
 * UI (decision 0001 §10 scope guard).
 *
 * Browser-only (React).
 */
import { useRef, type JSX } from 'react';
import type { AssetView } from '../session/content-projection';
import type { AssetImportState, AssetQueryState } from '../session/asset-browser';
import type { AnimationRoleKey } from '../session/media';

export interface AssetPreviewView {
  assetId: string;
  clips: readonly { index: number; name: string; durationSeconds: number }[];
  clipIndex: number | null;
  playing: boolean;
  timeSeconds: number;
  durationSeconds: number;
}

interface Props {
  assets: AssetView[];
  query: AssetQueryState;
  importState: AssetImportState;
  selectedAssetId: string | null;
  placementAvailable: boolean;
  placementMessage: string | null;
  preview: AssetPreviewView | null;
  onRefresh: () => void;
  onSelect: (assetId: string) => void;
  onImport: (file: File) => void;
  onReimport: (file: File) => void;
  onPublish: () => void;
  onCancel: () => void;
  onDiscard: () => void;
  onPreview: (assetId: string) => void;
  /** Mounts/unmounts the isolated preview canvas. */
  previewCanvasRef: (canvas: HTMLCanvasElement | null) => void;
  onPreviewPlay: () => void;
  onPreviewPause: () => void;
  onPreviewScrub: (seconds: number) => void;
  onPlace: () => void;
  /** M3 (packet 57): the §8.5.1 animated-reimport mapping for a pending model
   * reimport (`null` when the pending publish has no obligation). */
  roleMapping: { clipNames: string[]; referencingEntityIds: string[] } | null;
  roleEntity: string;
  roleDraft: Record<AnimationRoleKey, string>;
  onRoleEntityChange: (id: string) => void;
  onRoleDraftChange: (roles: Record<AnimationRoleKey, string>) => void;
}

const BUSY = new Set(['staging', 'uploading', 'inspecting', 'publishing']);

export function AssetBrowser(p: Props): JSX.Element {
  const importInput = useRef<HTMLInputElement | null>(null);
  const reimportInput = useRef<HTMLInputElement | null>(null);
  const selected = p.assets.find((a) => a.assetId === p.selectedAssetId) ?? null;
  // M3 (packet 57): the publish is disabled until the §8.5.1 role mapping is
  // complete (every role bound + the entity chosen) — the command would be
  // `field_missing` / stage-3 refused otherwise.
  const roleIncomplete =
    p.roleMapping !== null &&
    ((['idle', 'run', 'airborne'] as AnimationRoleKey[]).some((k) => p.roleDraft[k].trim() === '') ||
      !p.roleMapping.referencingEntityIds.includes(p.roleEntity));
  const roleMapping = p.roleMapping !== null && p.importState.phase === 'proposed' ? p.roleMapping : null;

  return (
    <div className="tl-panel tl-assets">
      <div className="tl-panel__title">
        Assets
        <button className="tl-btn tl-btn--small" onClick={p.onRefresh} title="Re-run the bounded queryAssets page">
          refresh
        </button>
      </div>

      <div className="tl-assets__body">
      <div className="tl-assets__main">
      <ul className="tl-assets__list tl-tiles">
        {p.assets.map((a) => (
          <li
            key={a.assetId}
            className={a.assetId === p.selectedAssetId ? 'tl-tile is-selected' : 'tl-tile'}
            onClick={() => p.onSelect(a.assetId)}
            title={a.assetId}
          >
            <span className={`tl-tile__icon tl-tile__icon--${a.kind}`} aria-hidden="true">{a.kind === 'audio' ? '♪' : '⬡'}</span>
            <span className="tl-tile__name">{a.displayName}</span>
            <span className="tl-tile__meta" title={`${a.versionCount} version(s)`}>
              {a.kind} · v{a.currentVersion}
            </span>
          </li>
        ))}
        {p.assets.length === 0 && <li className="tl-row tl-row--empty">no assets</li>}
      </ul>
      <div className="tl-assets__paging">
        {p.query.total} asset(s) · offset {p.query.offset}
        {p.query.hasMore ? ' · more' : ''}
      </div>

      <div className="tl-assets__actions">
        <input
          ref={importInput}
          className="tl-assets__file"
          type="file"
          accept=".glb,.wav,model/gltf-binary,audio/wav"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) p.onImport(f);
            e.target.value = '';
          }}
        />
        <button className="tl-btn" disabled={BUSY.has(p.importState.phase)} onClick={() => importInput.current?.click()} title="Stage + inspect + publish a new model (.glb) or audio (.wav) asset">
          import…
        </button>
        <input
          ref={reimportInput}
          className="tl-assets__file"
          type="file"
          accept=".glb,.wav,model/gltf-binary,audio/wav"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) p.onReimport(f);
            e.target.value = '';
          }}
        />
        <button
          className="tl-btn"
          disabled={!selected || BUSY.has(p.importState.phase)}
          onClick={() => reimportInput.current?.click()}
          title="Append a new immutable version under the same assetId (model or audio bytes)"
        >
          reimport…
        </button>
      </div>

      <div className={`tl-assets__status tl-assets__status--${p.importState.phase}`}>
        <span>import: {p.importState.phase}</span>
        {p.importState.phase === 'uploading' && (
          <span>
            {' '}
            {p.importState.bytesSent}/{p.importState.totalBytes} B
          </span>
        )}
        {p.importState.job && <span> job: {p.importState.job.state}</span>}
        {p.importState.error && (
          <div className="tl-assets__error" title={p.importState.error.message}>
            {p.importState.error.code}
          </div>
        )}
        <div className="tl-assets__row">
          <button className="tl-btn tl-btn--small" disabled={p.importState.phase !== 'proposed' || roleIncomplete} onClick={p.onPublish} title={roleIncomplete ? 'Choose the animation role mapping first (the §8.5.1 reimport is all-or-nothing)' : 'Commit the validated proposal as one publishAsset command'}>
            publish
          </button>
          <button className="tl-btn tl-btn--small" disabled={!BUSY.has(p.importState.phase)} onClick={p.onCancel} title="Cancel: no command is sent">
            cancel
          </button>
          <button className="tl-btn tl-btn--small" onClick={p.onDiscard} title="Discard the staged bytes">
            discard
          </button>
        </div>
        {roleMapping !== null && (
          <div className="tl-asset__roles">
            <div className="tl-subhead">Animation mapping (required — the reimport is all-or-nothing)</div>
            <p className="tl-note">
              {roleMapping.referencingEntityIds.length} entit{roleMapping.referencingEntityIds.length === 1 ? 'y' : 'ies'} reference this asset's animation. The publish moves the selected entity's full profile to the NEW version with these bindings (one undo restores both); a rejected reimport keeps the old version AND the old component.
            </p>
            <label className="tl-field">
              <span className="tl-field__label">entity to re-map</span>
              <select className="tl-input" value={p.roleEntity} onChange={(e) => p.onRoleEntityChange(e.target.value)}>
                {roleMapping.referencingEntityIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            {(['idle', 'run', 'airborne'] as AnimationRoleKey[]).map((k) => (
              <label className="tl-field" key={k}>
                <span className="tl-field__label">{k}</span>
                <select className="tl-input" value={p.roleDraft[k]} onChange={(e) => p.onRoleDraftChange({ ...p.roleDraft, [k]: e.target.value })}>
                  <option value="">— choose the clip (required) —</option>
                  {roleMapping.clipNames.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <p className="tl-note">Clip names come from the just-inspected bytes (clipIndex = their index in that list — the play-time range/mismatch checks then pass by construction).</p>
          </div>
        )}
      </div>
      </div>

      <div className="tl-assets__side">
      {selected && (
        <div className="tl-assets__preview">
          <div className="tl-assets__preview-head" title={selected.assetId}>
            preview · {selected.displayName}
          </div>
          <canvas className="tl-assets__preview-canvas" ref={p.previewCanvasRef} />
          <button className="tl-btn tl-btn--small" onClick={() => p.onPreview(selected.assetId)} title="Realize the current version locally (play/pause/scrub)">
            load preview
          </button>
          {p.preview?.assetId === selected.assetId && (
            <div className="tl-assets__preview-body">
              <div className="tl-assets__row">
                <button className="tl-btn tl-btn--small" onClick={p.preview.playing ? p.onPreviewPause : p.onPreviewPlay}>
                  {p.preview.playing ? 'pause' : 'play'}
                </button>
                <span className="tl-assets__clips">
                  clip {p.preview.clipIndex ?? '—'}/{Math.max(0, p.preview.clips.length - 1)} ·{' '}
                  {p.preview.timeSeconds.toFixed(2)}/{p.preview.durationSeconds.toFixed(2)}s
                </span>
              </div>
              <input
                className="tl-assets__scrub"
                type="range"
                min={0}
                max={Math.max(0.001, p.preview.durationSeconds)}
                step={0.01}
                value={Math.min(p.preview.timeSeconds, p.preview.durationSeconds)}
                onChange={(e) => p.onPreviewScrub(Number(e.target.value))}
              />
            </div>
          )}
        </div>
      )}

      <div className="tl-assets__place">
        <button
          className="tl-btn tl-btn--small"
          disabled={!selected || !p.placementAvailable}
          onClick={p.onPlace}
          title={p.placementMessage ?? 'Place the asset as a whole-GLB model instance'}
        >
          place
        </button>
        {!p.placementAvailable && <span className="tl-assets__hint">select an asset to place</span>}
      </div>
      </div>
      </div>
    </div>
  );
}
