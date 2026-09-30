/**
 * Asset/content browser panel (React).
 *
 * Display + intent only: every action issues the typed backend command / route
 * through the session client (the sole mutation path). The panel shows the
 * bounded query page, the import flow's job/failure/cancel status, the local
 * clip preview controls and the placement availability. No decorative or graph
 * UI (decision 0001 scope guard).
 *
 * Browser-only (React).
 */
import { Fragment, useRef, useState, type DragEvent, type JSX, type ReactNode } from 'react';
import type { AssetView } from '../session/content-projection';
import { ASSET_DRAG_TYPE } from '../session/placement';
import type { AssetImportState, AssetQueryState } from '../session/asset-browser';
import type { AnimationRoleKey } from '../session/media';
import { TexturePackForm, type PackRequest } from './TexturePackForm';
import { AudioAssetOptions } from './AudioAssetOptions';
import { LabelsBar, LoadableFields } from './LoadableFields';
import type { LoadingNameActions } from './useLoadingNames';

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
  /** The animated-reimport mapping for a pending model
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
  /** An audio file's load type (null: the default for its length) and whether it is read with its scene. */
  onAudioLoadType?: (assetId: string, loadType: 'decode-on-load' | 'decode-while-playing' | 'stream' | null) => void;
  onAudioPreload?: (assetId: string, preload: boolean) => void;
  /** How an imported PNG/JPEG texture is stored — as is, or encoded to KTX2 (colour: ETC1S, normal map: UASTC; data, UASTC linear). */
  textureEncoding?: 'none' | 'color' | 'normal' | 'data';
  onTextureEncoding?: (v: 'none' | 'color' | 'normal' | 'data') => void;
  /** Pack a KTX2 texture (array) from texture assets; resolves to an error message or null. */
  onPackTexture?: (req: PackRequest) => Promise<string | null>;
  /** Extra sections for the selected asset (its default materials). */
  sideExtra?: ReactNode;
  /** Create a UI document and open its tab. */
  onNewUiDocument?: () => void;
  /** Delete the selected asset (`deleteAsset`; refused while anything uses it). */
  onDelete?: (assetId: string) => void;
  /** Why the last delete was refused (the uses it names), or null. */
  deleteError?: string | null;
  /** The folder controls (where uploads land, folder import) below the import buttons. */
  importExtra?: ReactNode;
  /** Addresses and labels: the selected asset's in its side panel, labels on a multi-selection. */
  loading?: LoadingNameActions;
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
  const [packing, setPacking] = useState(false);
  // The multi-selection (Ctrl/Cmd-click adds or removes one, Shift-click a range): labels go to all of it at once.
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const choose = (ev: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, assetId: string): void => {
    if (ev.shiftKey && anchor !== null) {
      const ids = p.assets.map((a) => a.assetId);
      const [i, j] = [ids.indexOf(anchor), ids.indexOf(assetId)].sort((x, y) => x - y);
      if (i! >= 0) setChosen(new Set([...chosen, ...ids.slice(i, j! + 1)]));
    } else if (ev.ctrlKey || ev.metaKey) {
      const next = new Set(chosen);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      setChosen(next);
      setAnchor(assetId);
    } else {
      setChosen(new Set([assetId]));
      setAnchor(assetId);
    }
    p.onSelect(assetId);
  };
  const chosenItems = p.assets.filter((a) => chosen.has(a.assetId)).map((a) => ({ kind: 'asset', id: a.assetId }));
  const dragStart = (ev: DragEvent<HTMLLIElement>, assetId: string, piece: string | null): void => {
    ev.dataTransfer.setData(ASSET_DRAG_TYPE, JSON.stringify(piece === null ? { assetId } : { assetId, piece }));
    ev.dataTransfer.effectAllowed = 'copy';
  };
  // The publish is disabled until the role mapping is
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
      {p.loading !== undefined && chosenItems.length > 1 && <LabelsBar items={chosenItems} actions={p.loading} onClear={() => setChosen(new Set())} />}
      <ul className="tl-assets__list tl-tiles">
        {p.assets.map((a) => {
          const pieces = p.pieces.get(a.assetId) ?? [];
          const multi = a.kind === 'model' && pieces.length >= 2;
          const open = multi && expanded.has(a.assetId);
          const thumb = p.thumbnails.get(thumbnailKey(a.assetId, null));
          return (
            <Fragment key={a.assetId}>
              <li
                className={a.assetId === p.selectedAssetId || (chosen.size > 1 && chosen.has(a.assetId)) ? 'tl-tile is-selected' : 'tl-tile'}
                aria-selected={chosen.has(a.assetId) || a.assetId === p.selectedAssetId}
                onClick={(ev) => choose(ev, a.assetId)}
                title={a.kind === 'model' ? `${a.displayName} — drag into the scene or hierarchy` : a.assetId}
                data-asset-id={a.assetId}
                draggable={a.kind === 'model' || a.kind === 'texture'}
                onDragStart={a.kind === 'model' || a.kind === 'texture' ? (ev) => dragStart(ev, a.assetId, null) : undefined}
              >
                <span className={`tl-tile__icon tl-tile__icon--${a.kind}`} aria-hidden="true">
                  <img className={thumb !== undefined ? 'tl-tile__img tl-tile__img--thumb' : 'tl-tile__img'} src={thumb ?? `./icons/${a.kind === 'audio' ? 'audio' : a.kind === 'texture' || a.kind === 'font' ? 'empty' : 'model'}.png`} alt="" draggable={false} />
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
          accept=".glb,.fbx,.wav,.png,.jpg,.jpeg,.webp,.ktx2,.ogg,.oga,.opus,.mp3,.flac,.ttf,.otf,.woff2,.woff,model/gltf-binary,audio/wav,image/png,image/jpeg,image/webp,audio/ogg,audio/mpeg,audio/flac,font/ttf,font/otf,font/woff2,font/woff"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) p.onImport(f);
            e.target.value = '';
          }}
        />
        <button className="tl-btn" disabled={BUSY.has(p.importState.phase)} onClick={() => importInput.current?.click()} title="Stage + inspect + publish a new model (.glb, or .fbx converted by Blender), audio of any length (.wav/.ogg/.opus/.mp3/.flac), texture (.png/.jpg/.webp) or font (.ttf/.otf/.woff2/.woff) asset">
          import…
        </button>
        <input
          ref={reimportInput}
          className="tl-assets__file"
          type="file"
          accept=".glb,.fbx,.wav,.png,.jpg,.jpeg,.webp,.ktx2,.ogg,.oga,.opus,.mp3,.flac,.ttf,.otf,.woff2,.woff,model/gltf-binary,audio/wav,image/png,image/jpeg,image/webp,audio/ogg,audio/mpeg,audio/flac,font/ttf,font/otf,font/woff2,font/woff"
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
          title="Import other bytes for the selected asset: its file in the game folder is replaced (one undo puts it back)"
        >
          reimport…
        </button>
        {p.onTextureEncoding !== undefined && (
          <label className="tl-field tl-field--inline" title="How a PNG or JPEG texture is imported: as is, or encoded to KTX2 with mipmaps — colour art as ETC1S (small), normal maps as UASTC (precise, linear). A KTX2 stays compressed on the GPU.">
            <span className="tl-field__label">textures</span>
            <select className="tl-input tl-input--small" aria-label="texture import encoding" value={p.textureEncoding ?? 'none'} onChange={(e) => p.onTextureEncoding?.(e.target.value as 'none' | 'color' | 'normal' | 'data')}>
              <option value="none">keep the image</option>
              <option value="color">KTX2 colour (ETC1S)</option>
              <option value="normal">KTX2 normal map (UASTC)</option>
              <option value="data">KTX2 data (UASTC, linear)</option>
            </select>
          </label>
        )}
        {p.onPackTexture !== undefined && (
          <button className="tl-btn" aria-pressed={packing} onClick={() => setPacking((v) => !v)} title="Pack channels of PNG/JPEG textures into one KTX2 texture — several layers make a texture array (a painted terrain's layers)">
            pack texture…
          </button>
        )}
        {p.onNewUiDocument !== undefined && (
          <button className="tl-btn" onClick={p.onNewUiDocument} title="Create a UI document (a HUD, menu or screen) and open its editor tab; the UI tab lists them">
            new UI document
          </button>
        )}
        {p.folderImport && (
          <>
            <button className="tl-btn" disabled={BUSY.has(p.importState.phase)} onClick={p.onImportFromFolder} title="Pick a .glb/.fbx/.wav/.png/.jpg/.webp/.ogg/.mp3 in the game folder; files are referenced where they are, an .fbx is converted to glTF">
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

      {p.importExtra}

      {packing && p.onPackTexture !== undefined && <TexturePackForm textures={p.assets} onPack={p.onPackTexture} onClose={() => setPacking(false)} />}

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
            <div className="tl-assets__source" title="The asset's file in the game folder (its .tlasset sidecar is next to it)">
              file: {selected.sourcePath}
            </div>
          )}
          {selected.convertedFrom !== undefined && (
            <div
              className="tl-assets__source"
              title={selected.convertedFrom.format === 'fbx' ? 'Converted to glTF by Blender at import; the game loads the converted GLB' : 'Encoded to KTX2 at import; the game loads the KTX2'}
            >
              from {selected.convertedFrom.format === 'fbx' ? 'FBX' : selected.convertedFrom.format.toUpperCase()}
              {selected.convertedFrom.encoding !== undefined ? ` (${selected.convertedFrom.encoding === 'normal' ? 'normal map' : selected.convertedFrom.encoding === 'data' ? 'data' : 'colour'})` : ''}
              {selected.convertedFrom.sourcePath !== undefined ? `: ${selected.convertedFrom.sourcePath}` : ' (uploaded)'}
            </div>
          )}
          {selected.labels !== undefined && (
            <div className="tl-assets__source tl-assets__labels" data-testid="asset-labels" title="Labels a script may load this asset by, together with every other asset carrying them">
              labels: {selected.labels.join(', ')}
            </div>
          )}
          {p.loading !== undefined && <LoadableFields item={{ kind: 'asset', id: selected.assetId }} address={selected.address ?? null} labels={selected.labels ?? []} actions={p.loading} />}
          {selected.packedFrom !== undefined && (
            <div className="tl-assets__source" title="Packed at import from these texture assets' channels; the game loads the KTX2">
              packed from {selected.packedFrom.sources.map((id) => p.assets.find((a) => a.assetId === id)?.displayName ?? id).join(', ')} ({selected.packedFrom.encoding === 'normal' ? 'normal map' : selected.packedFrom.encoding === 'data' ? 'data' : 'colour'})
            </div>
          )}
          {selected.image !== undefined && (
            <div className="tl-assets__source" data-testid="texture-facts" title={selected.image.format === 'ktx2' ? 'A GPU-compressed texture (Basis Universal): transcoded on the player’s GPU to its own compressed format' : 'An image the page decodes to RGBA'}>
              {selected.image.format === 'ktx2'
                ? `KTX2 · ${selected.image.codec === 'uastc' ? 'UASTC' : 'ETC1S'} · ${selected.image.levels ?? 1} mip level${selected.image.levels === 1 ? '' : 's'}${selected.image.layers !== undefined ? ` · ${selected.image.layers} layers` : ''}`
                : selected.image.format.toUpperCase()}{' '}
              · {selected.image.width}×{selected.image.height}
            </div>
          )}
          {selected.audio !== undefined && <AudioAssetOptions assetId={selected.assetId} audio={selected.audio} onLoadType={p.onAudioLoadType} onPreload={p.onAudioPreload} />}
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
          {p.onDelete !== undefined && (
            <div className="tl-assets__row">
              <button
                className="tl-btn tl-btn--small"
                aria-label={`delete asset ${selected.displayName}`}
                onClick={() => p.onDelete?.(selected.assetId)}
                title="Remove this asset from the project (refused while an object, prefab, material, document or script still uses it; one undo brings it back)"
              >
                delete
              </button>
            </div>
          )}
          {p.deleteError != null && (
            <div className="tl-assets__error" role="alert" data-testid="asset-delete-error" title={p.deleteError}>
              {p.deleteError}
            </div>
          )}
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
