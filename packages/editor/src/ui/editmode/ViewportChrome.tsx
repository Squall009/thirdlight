/**
 * What lies over the edit mode's Scene view: the isolation chip (what the
 * view shows: the edited object only, or the whole scene with only it
 * pickable) and the mode's own chips. It takes no pointer input itself, so
 * the view under it does.
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';

import { Glyph } from './glyphs';

export function ViewportChrome({ objectName, context, extra }: { objectName: string; context: boolean; extra?: ReactNode }): JSX.Element {
  return (
    <div className="tl-vp-top">
      <span className="tl-iso" role="status" aria-label="isolation">
        <Glyph name="eye" size={14} />
        {context ? (
          <>
            Whole scene · only <b>{objectName}</b> can be picked
          </>
        ) : (
          <>
            Showing <b>{objectName}</b> only
          </>
        )}
      </span>
      {extra}
    </div>
  );
}
