/**
 * The Inspector of an audio asset chosen in the project window: its facts,
 * how the game holds it (load type, preload) and listening to it (sound
 * starts only after the explicit "enable preview sound", never on its own).
 * Unity's Inspector likewise shows an audio clip's import settings with a
 * play button.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { AudioSummary } from '@thirdlight/project-model';
import type { PreviewAudioDiagnostic, PreviewAudioStatus } from '../../session/preview-audio';
import { AudioAssetOptions } from '../AudioAssetOptions';
import { useAssetSummaries } from '../catalog/catalog-context';

interface Props {
  assetId: string;
  status: PreviewAudioStatus;
  diagnostics: readonly PreviewAudioDiagnostic[];
  onUnlock: () => void;
  onListen: (assetId: string) => void;
  onLoadType: (assetId: string, loadType: AudioSummary['loadType'] | null) => void;
  onPreload: (assetId: string, preload: boolean) => void;
}

/** The asset's summary, or null once it is gone or is not audio (the Inspector then shows the selection). */
export function useAudioAsset(assetId: string | null): { assetId: string; name: string; audio: AudioSummary } | null {
  const [a] = useAssetSummaries(assetId !== null ? [assetId] : []);
  if (assetId === null || a === undefined || a.audio === undefined) return null;
  return { assetId, name: a.displayName, audio: a.audio };
}

export function AudioAssetInspector(p: Props): JSX.Element | null {
  const asset = useAudioAsset(p.assetId);
  if (asset === null) return null;
  const status = p.status;
  return (
    <div className="tl-panel tl-inspector" aria-label="audio asset inspector" data-asset-id={asset.assetId}>
      <div className="tl-panel__title" title={asset.assetId}>
        Inspector — {asset.name}
      </div>
      <AudioAssetOptions assetId={asset.assetId} audio={asset.audio} onLoadType={p.onLoadType} onPreload={p.onPreload} />
      <section className="tl-inspector__section" aria-label="listen">
        <div className="tl-subhead">Listen</div>
        <div className="tl-inspector__modes">
          <button className="tl-btn" aria-label={`listen to ${asset.name}`} title="Play the sound in this browser (enable preview sound first)" disabled={status.state !== 'ready'} onClick={() => p.onListen(asset.assetId)}>
            ▶ play
          </button>
          {status.state === 'blocked' && (
            <button className="tl-btn" onClick={p.onUnlock}>
              enable preview sound
            </button>
          )}
        </div>
        <p className="tl-inspector__hint" data-preview-state={status.state}>
          Preview sound: <code>{status.state}{status.state === 'ready' && status.muted ? ' (muted)' : ''}</code>. Sound starts only after “enable preview sound” (no autoplay).
        </p>
        {p.diagnostics.length > 0 && (
          <div className="tl-media__diag">
            {p.diagnostics.slice(-4).map((d, i) => (
              <div key={i} className="tl-media__diag-line">
                <code>{d.code}</code> {d.message}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
