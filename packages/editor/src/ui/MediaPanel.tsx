/**
 * The Media tab: asset-level sound work — listen to the project's sounds.
 *
 * Phase 15.1: the object and game settings that lived here moved to where
 * the data is edited: game cues are fields of the game block (Gameplay →
 * Game), a checkpoint's activation look, a surface (with its presets), lights
 * and the old model-animation roles are Inspector sections built from their
 * descriptors. What stays is per asset: the preview of an audio asset.
 *
 * The PREVIEW plays committed bytes through the injected preview-audio owner
 * (explicit local gesture; the authoring token stays the session credential of
 * the content read, never a resource).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';
import type { AssetView } from '../session/content-projection';
import type { PreviewAudioStatus, PreviewAudioDiagnostic } from '../session/preview-audio';

interface Props {
  assets: readonly AssetView[];
  previewStatus: PreviewAudioStatus;
  previewDiagnostics: readonly PreviewAudioDiagnostic[];
  onUnlockPreview: () => void;
  onPreviewCue: (assetId: string) => void;
}

export function MediaPanel(props: Props): JSX.Element {
  const sounds = props.assets.filter((a) => a.kind === 'audio');
  const status = props.previewStatus;
  return (
    <div className="tl-panel tl-media" aria-label="media">
      <div className="tl-panel__title">Media</div>
      <p className="tl-note">
        Listen to the project's sounds. Where they are used is set in the Inspector (a pickup's sound, a checkpoint's cue, an audio source) and in Gameplay → Game (the game's cues).
      </p>
      {sounds.length === 0 ? (
        <p className="tl-note">No sounds yet: import a WAV in the Assets tab.</p>
      ) : (
        <div className="tl-media__cues">
          {sounds.map((a) => (
            <div className="tl-media__cue-row" key={a.assetId}>
              <span className="tl-media__cue-label">{a.displayName}</span>
              <span className="tl-inspector__hint">v{a.currentVersion}</span>
              <button className="tl-btn tl-btn--small" aria-label={`preview ${a.displayName}`} onClick={() => props.onPreviewCue(a.assetId)} title="Play the sound (enable preview sound first)">
                ▶
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="tl-note">
        Preview: <code>{status.state}{status.state === 'ready' ? (status.muted ? ' (muted)' : '') : ''}</code>. Sound starts only after the button below (no autoplay).
      </p>
      {status.state === 'blocked' && (
        <button className="tl-btn" onClick={props.onUnlockPreview}>
          enable preview sound
        </button>
      )}
      {props.previewDiagnostics.length > 0 && (
        <div className="tl-media__diag">
          {props.previewDiagnostics.slice(-4).map((d, i) => (
            <div key={i} className="tl-media__diag-line">
              <code>{d.code}</code> {d.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
