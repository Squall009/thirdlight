/**
 * An audio asset in the asset inspector: its facts (format, channels, rate,
 * length), how the game holds it (load type, with the default for its length
 * named) and whether it is read with its scene, plus what a browser does not
 * play of it. One kind of audio: a footstep and an hour of music differ only
 * in these settings.
 */
import type { JSX } from 'react';
import type { AudioSummary } from '@thirdlight/project-model';
import { defaultAudioLoadType } from '@thirdlight/project-model/limits';

type LoadType = AudioSummary['loadType'];

const LOAD_TYPE_LABEL: Record<LoadType, string> = {
  'decode-on-load': 'decode on load',
  'decode-while-playing': 'decode while playing',
  stream: 'stream',
};

const FORMAT_LABEL: Record<AudioSummary['format'], string> = {
  'ogg-vorbis': 'Ogg Vorbis',
  'ogg-opus': 'Ogg Opus',
  mp3: 'MP3',
  wav: 'WAV',
  flac: 'FLAC',
};

function seconds(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function AudioAssetOptions(p: {
  assetId: string;
  audio: AudioSummary;
  onLoadType?: ((assetId: string, loadType: LoadType | null) => void) | undefined;
  onPreload?: ((assetId: string, preload: boolean) => void) | undefined;
}): JSX.Element {
  const a = p.audio;
  const byLength = defaultAudioLoadType(a.durationMs);
  return (
    <div className="tl-assets__audio" data-testid="audio-options">
      <div className="tl-assets__source" data-testid="audio-facts" title="Read from the file's headers at import (never decoded there)">
        {FORMAT_LABEL[a.format]} · {a.channels === 1 ? 'mono' : a.channels === 2 ? 'stereo' : `${a.channels} channels`} · {(a.sampleRate / 1000).toFixed(a.sampleRate % 1000 === 0 ? 0 : 1)} kHz
        {a.bitsPerSample !== undefined ? ` · ${a.bitsPerSample}-bit` : ''} · {seconds(a.durationMs)}
      </div>
      <label className="tl-field" title="How the game holds the file: decoded into memory when it loads (short sounds, no wait when played), kept compressed and decoded each time it plays, or streamed from its file (long music and ambience)">
        <span className="tl-field__label">load type</span>
        <select
          className="tl-input"
          aria-label="audio load type"
          value={a.loadTypeSet ? a.loadType : 'default'}
          disabled={p.onLoadType === undefined}
          onChange={(e) => p.onLoadType?.(p.assetId, e.target.value === 'default' ? null : (e.target.value as LoadType))}
        >
          <option value="default">default for its length ({LOAD_TYPE_LABEL[byLength]})</option>
          {(Object.keys(LOAD_TYPE_LABEL) as LoadType[]).map((t) => (
            <option key={t} value={t}>
              {LOAD_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="tl-field" title="Read with the scene that uses it, so it is ready when played; off: read only when first played (voice lines of a long dialogue)">
        <input type="checkbox" aria-label="audio preload" checked={a.preload} disabled={p.onPreload === undefined} onChange={(e) => p.onPreload?.(p.assetId, e.target.checked)} />
        <span className="tl-field__label">preload with its scene</span>
      </label>
      {a.playbackGaps !== undefined && (
        <div className="tl-assets__warning" role="note" data-testid="audio-playback-gaps">
          {a.playbackGaps.join('; ')}
        </div>
      )}
    </div>
  );
}
