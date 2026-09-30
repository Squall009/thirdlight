/**
 * The Assets tab: the project window (folders, every asset, resource and
 * scene, search, moves; ui/project/ProjectWindow.tsx), the import flow's
 * job/failure/cancel status, and the chosen item's side panel (an asset's
 * preview, options and placement; a resource's or scene's file, address and
 * labels).
 *
 * Display + intent only: every action issues the typed backend command / route
 * through the session client (the sole mutation path).
 *
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { IndexEntryView } from '../session/catalog';
import type { ProjectItem } from '../session/project-items';
import type { AssetImportState } from '../session/asset-browser';
import type { TileThumbnails } from '../viewport/thumbnails';
import { useAssetSummaries, useCatalog } from './catalog/catalog-context';
import { EntryName, TEXTURE_KINDS } from './catalog/RefPicker';
import type { AnimationRoleKey } from '../session/media';
import { TexturePackForm, type PackRequest } from './TexturePackForm';
import { AudioAssetOptions } from './AudioAssetOptions';
import { TextureAssetOptions } from './TextureAssetOptions';
import type { AssetOptionActions } from './useAssetOptions';
import { LoadableFields } from './LoadableFields';
import type { LoadingNameActions } from './useLoadingNames';
import { ProjectWindow } from './project/ProjectWindow';
import type { ProjectCommands } from './project/useProjectCommands';

export interface AssetPreviewView {
  assetId: string;
  clips: readonly { index: number; name: string; durationSeconds: number }[];
  clipIndex: number | null;
  playing: boolean;
  timeSeconds: number;
  durationSeconds: number;
}

interface Props {
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
  /** The tile pictures (from the import cache). */
  thumbnails: TileThumbnails | null;
  /** The pieces of the selected model file, read when it was selected (a file with 2+ pieces expands into piece tiles). */
  pieces: { assetId: string; list: readonly { name: string }[] } | null;
  /** The asset inspector's option commands (vertex colours, audio load settings, texture streaming). */
  assetOptions: Pick<AssetOptionActions, 'setVertexColors' | 'setAudioLoadType' | 'setAudioPreload' | 'setTextureStreaming'>;
  /** An audio file's load type (null: the default for its length) and whether it is read with its scene. */
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
  /** The project window's folder (null: All assets); new items and uploads go into it. */
  folder: string | null;
  onFolder: (folder: string | null) => void;
  /** Open an item's editor (a double-click). */
  onOpenItem: (item: ProjectItem) => void;
  /** Moves, folder renames and new folders. */
  projectCommands: ProjectCommands;
}

const BUSY = new Set(['staging', 'uploading', 'inspecting', 'publishing']);

/** An index entry as the index has it now (read again whenever the index changed: labels change with commands). */
function useFreshEntry(entry: IndexEntryView): IndexEntryView {
  const { catalog, version } = useCatalog();
  const [fresh, setFresh] = useState<IndexEntryView>(entry);
  const { kind, id } = entry;
  useEffect(() => {
    if (catalog === null) return;
    let live = true;
    void catalog.entries([id], [kind]).then((list) => {
      const found = list[0];
      if (live && found !== undefined) setFresh(found);
    });
    return () => {
      live = false;
    };
  }, [catalog, version, kind, id]);
  return fresh.kind === kind && fresh.id === id ? fresh : entry;
}

/** A resource or scene chosen in the project window: its file, and its address and labels. */
function ItemSide(p: { entry: IndexEntryView; loading?: LoadingNameActions; onOpen: (item: ProjectItem) => void }): JSX.Element {
  const e = useFreshEntry(p.entry);
  return (
    <div className="tl-assets__preview" data-testid="item-side" data-item={`${e.kind}:${e.id}`}>
      <div className="tl-assets__preview-head" title={e.id}>
        {e.kind} · {e.name}
      </div>
      {e.path !== null && (
        <div className="tl-assets__source" title="Its file in the game folder">
          file: {e.path}
        </div>
      )}
      {p.loading !== undefined && e.kind !== 'scene' && <LoadableFields item={{ kind: e.kind, id: e.id }} address={e.address ?? null} labels={e.labels} actions={p.loading} />}
      <div className="tl-assets__row">
        <button className="tl-btn tl-btn--small" onClick={() => p.onOpen({ kind: e.kind, id: e.id })} title="Open its editor (or double-click it)">
          open
        </button>
      </div>
    </div>
  );
}

export function AssetBrowser(p: Props): JSX.Element {
  const importInput = useRef<HTMLInputElement | null>(null);
  const reimportInput = useRef<HTMLInputElement | null>(null);
  const catalog = useCatalog();
  const [selected] = useAssetSummaries(p.selectedAssetId !== null ? [p.selectedAssetId] : []);
  const [packing, setPacking] = useState(false);
  // A resource or scene chosen in the project window (the side panel shows it instead of the asset).
  const [focus, setFocus] = useState<IndexEntryView | null>(null);
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
        <button className="tl-btn tl-btn--small" onClick={p.onRefresh} title="Read the project index again">
          refresh
        </button>
      </div>

      <div className="tl-assets__body">
      <div className="tl-assets__main">
      <ProjectWindow
        folder={p.folder}
        onFolder={p.onFolder}
        selectedAssetId={p.selectedAssetId}
        onSelectAsset={p.onSelect}
        onFocus={setFocus}
        onOpen={p.onOpenItem}
        commands={p.projectCommands}
        {...(p.loading !== undefined ? { loading: p.loading } : {})}
        thumbnails={p.thumbnails}
        pieces={p.pieces}
        fileName={(id) => catalog.asset(id)?.displayName ?? id}
      />

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

      {packing && p.onPackTexture !== undefined && <TexturePackForm onPack={p.onPackTexture} onClose={() => setPacking(false)} />}

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
          <button className="tl-btn tl-btn--small" disabled={p.importState.phase !== 'proposed' || roleIncomplete} onClick={p.onPublish} title={roleIncomplete ? 'Choose the animation role mapping first (an animated re-import is all-or-nothing)' : 'Commit the validated proposal as one publishAsset command'}>
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
      {focus !== null && <ItemSide entry={focus} {...(p.loading !== undefined ? { loading: p.loading } : {})} onOpen={p.onOpenItem} />}
      {focus === null && selected && (
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
              packed from{' '}
              {selected.packedFrom.sources.map((id, i) => (
                <span key={id}>
                  {i > 0 ? ', ' : ''}
                  <EntryName id={id} kinds={TEXTURE_KINDS} />
                </span>
              ))} ({selected.packedFrom.encoding === 'normal' ? 'normal map' : selected.packedFrom.encoding === 'data' ? 'data' : 'colour'})
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
          {selected.streaming !== undefined && <TextureAssetOptions assetId={selected.assetId} streaming={selected.streaming} image={selected.image} onStreaming={(id, v) => void p.assetOptions.setTextureStreaming(id, v)} />}
          {selected.audio !== undefined && <AudioAssetOptions assetId={selected.assetId} audio={selected.audio} onLoadType={(id, t) => void p.assetOptions.setAudioLoadType(id, t)} onPreload={(id, v) => void p.assetOptions.setAudioPreload(id, v)} />}
          {selected.kind === 'model' && (
            <label className="tl-field" title="COLOR_0 as shader data (foliage bend weights and the like) or as a tint multiplied into the base colour">
              <span className="tl-field__label">vertex colour</span>
              <select
                className="tl-input"
                aria-label="vertex colour"
                value={selected.vertexColors === 'tint' ? 'tint' : 'data'}
                onChange={(e) => void p.assetOptions.setVertexColors(selected.assetId, e.target.value === 'tint' ? 'tint' : 'data')}
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
