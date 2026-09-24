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
import { Fragment, useRef, useState, type DragEvent, type JSX, type ReactNode } from 'react';
import type { AssetView } from '../session/content-projection';
import { ASSET_DRAG_TYPE } from '../session/placement';
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
  /** A folder project: files can be imported from the game folder in place. */
  folderImport: boolean;
  onImportFromFolder: () => void;
  onReimportFromFolder: () => void;
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
  /** Rendered tile previews: key `${assetId}|${piece ?? ''}` → image URL. */
  thumbnails: ReadonlyMap<string, string>;
  /** The pieces of each loaded model file (a file with 2+ pieces expands into piece tiles). */
  pieces: ReadonlyMap<string, readonly { name: string }[]>;
  onVertexColors: (assetId: string, mode: 'data' | 'tint') => void;
  /** Phase 9.4: extra sections for the selected asset (its default materials). */
  sideExtra?: ReactNode;
}

/** The tile-preview key of an asset (or one of its pieces). */
export function thumbnailKey(assetId: string, piece: string | null): string {
  return `${assetId}|${piece ?? ''}`;
}

const BUSY = new Set(['staging', 'uploading', 'inspecting', 'publishing']);

export function AssetBrowser(p: Props): JSX.Element {
  const importInput = useRef<HTMLInputElement | null>(null);
  const reimportInput = useRef<HTMLInputElement | null>(null);
  const selected = p.assets.find((a) => a.assetId === p.selectedAssetId) ?? null;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const dragStart = (ev: DragEvent<HTMLLIElement>, assetId: string, piece: string | null): void => {
    ev.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(piece === null ? { assetId } : { assetId, piece }));
    ev.dataTransfer.effectAllowed = 'copy';
  };
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
        {p.assets.map((a) => {
          const pieces = p.pieces.get(a.assetId) ?? [];
          const multi = a.kind === 'model' && pieces.length >= 2;
          const open = multi && expanded.has(a.assetId);
          const thumb = p.thumbnails.get(thumbnailKey(a.assetId, null));
          return (
            <Fragment key={a.assetId}>
              <li
                className={a.assetId === p.selectedAssetId ? 'tl-tile is-selected' : 'tl-tile'}
                onClick={() => p.onSelect(a.assetId)}
                title={a.kind === 'model' ? `${a.displayName} — drag into the scene or hierarchy` : a.assetId}
                data-asset-id={a.assetId}
                draggable={a.kind === 'model' || a.kind === 'texture'}
                onDragStart={a.kind === 'model' || a.kind === 'texture' ? (ev) => dragStart(ev, a.assetId, null) : undefined}
              >
                <span className={`tl-tile__icon tl-tile__icon--${a.kind}`} aria-hidden="true">
                  <img className={thumb !== undefined ? 'tl-tile__img tl-tile__img--thumb' : 'tl-tile__img'} src={thumb ?? `./icons/${a.kind === 'audio' ? 'audio' : a.kind === 'texture' ? 'empty' : 'model'}.png`} alt="" draggable={false} />
                </span>
                <span className="tl-tile__name">{a.displayName}</span>
                <span className="tl-tile__meta" title={`${a.versionCount} version(s)${a.sourcePath !== undefined ? ` · ${a.sourcePath}` : ''}`}>
                  {a.kind} · v{a.currentVersion}
                  {multi && (
                    <button
                      className="tl-tile__pieces"
                      aria-expanded={open}
                      aria-label={`${open ? 'hide' : 'show'} the ${pieces.length} pieces of ${a.displayName}`}
                      title={`${pieces.length} pieces — each can be dragged on its own`}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(a.assetId)) next.delete(a.assetId);
                          else next.add(a.assetId);
                          return next;
                        });
                      }}
                    >
                      {open ? '▾' : '▸'} {pieces.length}
                    </button>
                  )}
                </span>
              </li>
              {open &&
                pieces.map((pc) => {
                  const pt = p.thumbnails.get(thumbnailKey(a.assetId, pc.name));
                  return (
                    <li
                      key={`${a.assetId}|${pc.name}`}
                      className="tl-tile tl-tile--piece"
                      title={`${pc.name} (piece of ${a.displayName}) — drag into the scene or hierarchy`}
                      data-asset-id={a.assetId}
                      data-piece={pc.name}
                      draggable
                      onClick={() => p.onSelect(a.assetId)}
                      onDragStart={(ev) => dragStart(ev, a.assetId, pc.name)}
                    >
                      <span className="tl-tile__icon tl-tile__icon--model" aria-hidden="true">
                        <img className={pt !== undefined ? 'tl-tile__img tl-tile__img--thumb' : 'tl-tile__img'} src={pt ?? './icons/model.png'} alt="" draggable={false} />
                      </span>
                      <span className="tl-tile__name">{pc.name}</span>
                      <span className="tl-tile__meta">piece</span>
                    </li>
                  );
                })}
            </Fragment>
          );
        })}
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
          accept=".glb,.fbx,.wav,.png,.jpg,.jpeg,.webp,model/gltf-binary,audio/wav,image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) p.onImport(f);
            e.target.value = '';
          }}
        />
        <button className="tl-btn" disabled={BUSY.has(p.importState.phase)} onClick={() => importInput.current?.click()} title="Stage + inspect + publish a new model (.glb, or .fbx converted by Blender), audio (.wav) or texture (.png/.jpg/.webp) asset">
          import…
        </button>
        <input
          ref={reimportInput}
          className="tl-assets__file"
          type="file"
          accept=".glb,.fbx,.wav,.png,.jpg,.jpeg,.webp,model/gltf-binary,audio/wav,image/png,image/jpeg,image/webp"
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
        {p.folderImport && (
          <>
            <button className="tl-btn" disabled={BUSY.has(p.importState.phase)} onClick={p.onImportFromFolder} title="Pick a .glb/.fbx/.wav/.png/.jpg/.webp in the game folder; files are referenced where they are, an .fbx is converted to glTF">
              from project folder…
            </button>
            <button
              className="tl-btn"
              disabled={!selected || BUSY.has(p.importState.phase)}
              onClick={p.onReimportFromFolder}
              title="Record a file in the game folder as a new version of the selected asset"
            >
              reimport from folder…
            </button>
          </>
        )}
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
          {selected.sourcePath !== undefined && (
            <div className="tl-assets__source" title="Referenced in place in the game folder (not copied)">
              file: {selected.sourcePath}
            </div>
          )}
          {selected.convertedFrom !== undefined && (
            <div className="tl-assets__source" title="Converted to glTF by Blender at import; the game loads the converted GLB">
              from FBX{selected.convertedFrom.sourcePath !== undefined ? `: ${selected.convertedFrom.sourcePath}` : ' (uploaded)'}
            </div>
          )}
          {selected.kind === 'model' && (
            <label className="tl-field" title="COLOR_0 as shader data (foliage bend weights and the like) or as a tint multiplied into the base colour">
              <span className="tl-field__label">vertex colour</span>
              <select
                className="tl-input"
                aria-label="vertex colour"
                value={selected.vertexColors === 'tint' ? 'tint' : 'data'}
                onChange={(e) => p.onVertexColors(selected.assetId, e.target.value === 'tint' ? 'tint' : 'data')}
              >
                <option value="data">data (not colour)</option>
                <option value="tint">tint the albedo</option>
              </select>
            </label>
          )}
          {p.sideExtra}
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
