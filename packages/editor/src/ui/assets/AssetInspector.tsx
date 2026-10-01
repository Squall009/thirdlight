/**
 * The Inspector of an asset chosen in the project window (Unity's Inspector
 * shows whatever the Project window chose last): its file and where it was
 * converted from, its address and labels, a texture's facts and streaming, an
 * audio asset's load settings and listening, a model's vertex colours,
 * materials, clips and extracted textures, a model's preview with its clips,
 * placing it in the scene and deleting it.
 *
 * Display and intent only: every change is a command through the session.
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';
import { useAssetSummaries } from '../catalog/catalog-context';
import { EntryName, TEXTURE_KINDS } from '../catalog/RefPicker';
import { LoadableFields } from '../LoadableFields';
import { TextureAssetOptions } from '../TextureAssetOptions';
import type { AssetOptionActions } from '../useAssetOptions';
import type { LoadingNameActions } from '../useLoadingNames';
import { AudioAssetSections, type AudioSectionsProps } from './AudioAssetSections';
import type { AssetPreview } from './useAssetPreview';

export interface AssetInspectorProps {
  assetId: string;
  loading?: LoadingNameActions;
  assetOptions: AssetOptionActions;
  /** The model preview (its canvas, clips, play/pause/scrub). */
  preview: AssetPreview;
  /** Placing the asset where the camera looks. */
  place: { available: boolean; message: string | null; onPlace: () => void };
  /** A model's own sections (its materials, clips, extracted textures). */
  modelExtra?: ReactNode;
  /** Listening to an audio asset (the editor's preview sound). */
  listen: Pick<AudioSectionsProps, 'status' | 'diagnostics' | 'onUnlock' | 'onListen'>;
  onDelete: (assetId: string) => void;
  /** Why the last delete of this asset was refused (the uses it names), or null. */
  deleteError: string | null;
}

const encodingName = (e: string | undefined): string => (e === 'normal' ? 'normal map' : e === 'data' ? 'data' : 'colour');

export function AssetInspector(p: AssetInspectorProps): JSX.Element | null {
  const [a] = useAssetSummaries([p.assetId]);
  if (a === undefined) return <div className="tl-inspector__empty">Reading the asset…</div>;
  return (
    <div className="tl-panel tl-inspector tl-asset-inspector" aria-label={`${a.kind} asset inspector`} data-asset-id={a.assetId}>
      <div className="tl-panel__title" title={a.assetId}>
        Inspector — {a.displayName}
      </div>
      <div className="tl-assets__preview">
        <div className="tl-assets__preview-head">{a.kind}</div>
        {a.sourcePath !== undefined && (
          <div className="tl-assets__source" title="The asset's file in the game folder (its .tlasset sidecar is next to it)">
            file: {a.sourcePath}
          </div>
        )}
        {a.convertedFrom !== undefined && (
          <div className="tl-assets__source" title={a.convertedFrom.format === 'fbx' ? 'Converted to glTF by Blender at import; the game loads the converted GLB' : 'Converted at import; the game loads the result'}>
            from {a.convertedFrom.format === 'fbx' ? 'FBX' : a.convertedFrom.format.toUpperCase()}
            {a.convertedFrom.encoding !== undefined ? ` (${encodingName(a.convertedFrom.encoding)})` : ''}
            {a.convertedFrom.sourcePath !== undefined ? `: ${a.convertedFrom.sourcePath}` : ' (uploaded)'}
          </div>
        )}
        {a.labels !== undefined && (
          <div className="tl-assets__source tl-assets__labels" data-testid="asset-labels" title="Labels a script may load this asset by, together with every other asset carrying them">
            labels: {a.labels.join(', ')}
          </div>
        )}
        {p.loading !== undefined && <LoadableFields item={{ kind: 'asset', id: a.assetId }} address={a.address ?? null} labels={a.labels ?? []} actions={p.loading} />}
        {a.packedFrom !== undefined && (
          <div className="tl-assets__source" title="Packed at import from these texture assets' channels; the game loads the KTX2">
            packed from{' '}
            {a.packedFrom.sources.map((id, i) => (
              <span key={id}>
                {i > 0 ? ', ' : ''}
                <EntryName id={id} kinds={TEXTURE_KINDS} />
              </span>
            ))}{' '}
            ({encodingName(a.packedFrom.encoding)})
          </div>
        )}
        {a.image !== undefined && (
          <div className="tl-assets__source" data-testid="texture-facts" title={a.image.format === 'ktx2' ? 'A GPU-compressed texture (Basis Universal): transcoded on the player’s GPU to its own compressed format' : 'An image the page decodes to RGBA'}>
            {a.image.format === 'ktx2'
              ? `KTX2 · ${a.image.codec === 'uastc' ? 'UASTC' : 'ETC1S'} · ${a.image.levels ?? 1} mip level${a.image.levels === 1 ? '' : 's'}${a.image.layers !== undefined ? ` · ${a.image.layers} layers` : ''}`
              : a.image.format.toUpperCase()}{' '}
            · {a.image.width}×{a.image.height}
          </div>
        )}
        {a.streaming !== undefined && <TextureAssetOptions assetId={a.assetId} streaming={a.streaming} image={a.image} onStreaming={(id, v) => void p.assetOptions.setTextureStreaming(id, v)} />}
        {a.audio !== undefined && (
          <AudioAssetSections
            assetId={a.assetId}
            name={a.displayName}
            audio={a.audio}
            {...p.listen}
            onLoadType={(id, t) => void p.assetOptions.setAudioLoadType(id, t)}
            onPreload={(id, v) => void p.assetOptions.setAudioPreload(id, v)}
          />
        )}
        {a.kind === 'model' && (
          <label className="tl-field" title="COLOR_0 as shader data (foliage bend weights and the like) or as a tint multiplied into the base colour">
            <span className="tl-field__label">vertex colour</span>
            <select className="tl-input" aria-label="vertex colour" value={a.vertexColors === 'tint' ? 'tint' : 'data'} onChange={(e) => void p.assetOptions.setVertexColors(a.assetId, e.target.value === 'tint' ? 'tint' : 'data')}>
              <option value="data">data (not colour)</option>
              <option value="tint">tint the albedo</option>
            </select>
          </label>
        )}
        {a.kind === 'model' && p.modelExtra}
        {a.kind === 'model' && (
          <section className="tl-inspector__section" aria-label="model preview">
            <canvas className="tl-assets__preview-canvas" ref={p.preview.canvasRef} />
            <button className="tl-btn tl-btn--small" onClick={() => void p.preview.load(a.assetId)} title="Realize the current version locally (play/pause/scrub)">
              load preview
            </button>
            {p.preview.view?.assetId === a.assetId && (
              <div className="tl-assets__preview-body">
                <div className="tl-assets__row">
                  <button className="tl-btn tl-btn--small" onClick={p.preview.view.playing ? p.preview.pause : p.preview.play}>
                    {p.preview.view.playing ? 'pause' : 'play'}
                  </button>
                  <span className="tl-assets__clips">
                    clip {p.preview.view.clipIndex ?? '—'}/{Math.max(0, p.preview.view.clips.length - 1)} · {p.preview.view.timeSeconds.toFixed(2)}/{p.preview.view.durationSeconds.toFixed(2)}s
                  </span>
                </div>
                <input
                  className="tl-assets__scrub"
                  type="range"
                  aria-label="preview time"
                  min={0}
                  max={Math.max(0.001, p.preview.view.durationSeconds)}
                  step={0.01}
                  value={Math.min(p.preview.view.timeSeconds, p.preview.view.durationSeconds)}
                  onChange={(e) => p.preview.scrub(Number(e.target.value))}
                />
              </div>
            )}
          </section>
        )}
        <div className="tl-assets__row">
          <button className="tl-btn tl-btn--small" disabled={!p.place.available} onClick={p.place.onPlace} title={p.place.message ?? 'Place the asset where the camera looks (a model as a whole-file model instance)'}>
            place
          </button>
          <button
            className="tl-btn tl-btn--small"
            aria-label={`delete asset ${a.displayName}`}
            onClick={() => p.onDelete(a.assetId)}
            title="Remove this asset from the project (refused while an object, prefab, material, document or script still uses it; one undo brings it back)"
          >
            delete
          </button>
        </div>
        {p.deleteError !== null && (
          <div className="tl-assets__error" role="alert" data-testid="asset-delete-error" title={p.deleteError}>
            {p.deleteError}
          </div>
        )}
      </div>
    </div>
  );
}
