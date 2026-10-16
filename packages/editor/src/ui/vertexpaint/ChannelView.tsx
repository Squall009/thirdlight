/**
 * The vertex paint editor's channel view as a list: the material as drawn
 * (Final), or one channel of the paint as grey, each named by what it means
 * on the material. The Channels column shows it; Paint shows it as a docked
 * panel. V cycles it (`PaintView.tsx`).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';

import type { VertexPaintSetup } from './vertex-paint-column';

/** The paint's four channels by letter. */
export const CHANNEL_LETTERS = ['R', 'G', 'B', 'A'] as const;

/** The channel view as a list (Final, then what each channel means; V cycles them): the Channels column's, and Paint's panel. */
export function ChannelViewList({ vp }: { vp: VertexPaintSetup }): JSX.Element {
  const { channels, state, setState } = vp;
  return (
    <>
      <div className="tl-chanlist" role="radiogroup" aria-label="channel view list">
        {channels.views.map((v) => (
          <button key={v.label} type="button" role="radio" aria-label={v.label} aria-checked={state.view === v.channel} className={state.view === v.channel ? 'is-active' : ''} onClick={() => setState({ view: v.channel })}>
            <span className="tl-chanlist__key">{v.channel === null ? '◐' : CHANNEL_LETTERS[v.channel]}</span>
            <span>{v.label}</span>
          </button>
        ))}
      </div>
      <p className="tl-hint">Shows the paint as stored, whatever the material makes of it.</p>
    </>
  );
}
