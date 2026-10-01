/**
 * An audio asset's sections of its Inspector: how the game holds it (load
 * type, preload) and listening to it (sound starts only after the explicit
 * "enable preview sound", never on its own). Unity's Inspector likewise shows
 * an audio clip's import settings with a play button.
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { AudioSummary } from '@thirdlight/project-model';
import type { PreviewAudioDiagnostic, PreviewAudioStatus } from '../../session/preview-audio';
import { AudioAssetOptions } from '../AudioAssetOptions';

export interface AudioSectionsProps {
  assetId: string;
  name: string;
  audio: AudioSummary;
  status: PreviewAudioStatus;
  diagnostics: readonly PreviewAudioDiagnostic[];
  onUnlock: () => void;
  onListen: (assetId: string) => void;
  onLoadType: (assetId: string, loadType: AudioSummary['loadType'] | null) => void;
  onPreload: (assetId: string, preload: boolean) => void;
}

export function AudioAssetSections(p: AudioSectionsProps): JSX.Element {
  const asset = { assetId: p.assetId, name: p.name, audio: p.audio };
  const status = p.status;
  return (
    <>
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
    </>
  );
}
