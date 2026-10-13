/**
 * The edit modes' warnings: a `Banner` at the top of a settings column (a
 * warn glyph, a title, a plain explanation and the action that fixes it)
 * and a `Toast` over the Scene view saying the same in one line, so the
 * fix is in reach wherever the user looks. Used for "this material doesn't
 * read paint — Make it paintable"; the decal editor's atlas warnings next.
 *
 * Browser-only (React).
 */
import type { JSX, ReactNode } from 'react';

import { Glyph } from './glyphs';

export interface BannerAction {
  readonly label: string;
  readonly onClick: () => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
}

function ActionButton({ action, small }: { action: BannerAction; small?: boolean }): JSX.Element {
  return (
    <button type="button" className={`tl-btn tl-btn--primary${small === true ? ' tl-btn--small' : ''}`} aria-label={action.label.toLowerCase()} disabled={action.busy === true || action.disabled === true} onClick={action.onClick}>
      {action.busy === true ? 'Working…' : action.label}
    </button>
  );
}

/** A warning at the top of a column: what is wrong, why, and the fix. */
export function Banner({ title, children, action, aria }: { title: string; children: ReactNode; action?: BannerAction; aria: string }): JSX.Element {
  return (
    <div className="tl-banner" role="alert" aria-label={aria}>
      <Glyph name="warn" size={18} />
      <div className="tl-banner__body">
        <b>{title}</b>
        <p>{children}</p>
        {action !== undefined && <ActionButton action={action} />}
      </div>
    </div>
  );
}

/** One line over the Scene view (centred near its top), with the fix. */
export function Toast({ children, action, aria }: { children: ReactNode; action?: BannerAction; aria: string }): JSX.Element {
  return (
    <div className="tl-toast" role="status" aria-label={aria}>
      <Glyph name="warn" size={16} />
      <span>{children}</span>
      {action !== undefined && <ActionButton action={action} small />}
    </div>
  );
}
