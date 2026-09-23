/** The Thirdlight mark (three rays over a rising lamp) and wordmark, inline SVG. */
import type { JSX } from 'react';

export function LogoMark(p: { size?: number }): JSX.Element {
  const s = p.size ?? 18;
  return (
    <svg width={s} height={s} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#14171c" />
      <g fill="none" stroke="#f2b544" strokeWidth="5" strokeLinecap="round">
        <path d="M32 8v13" />
        <path d="M13 15l9 9" />
        <path d="M51 15l-9 9" />
      </g>
      <path d="M18 40a14 14 0 0 1 28 0z" fill="#f2b544" />
      <rect x="24" y="43" width="16" height="5" rx="2.5" fill="#f2b544" />
      <rect x="27" y="51" width="10" height="4" rx="2" fill="#f2b544" opacity=".7" />
    </svg>
  );
}

export function Logo(p: { size?: number }): JSX.Element {
  return (
    <span className="tl-logo">
      <LogoMark size={p.size ?? 18} />
      <span className="tl-logo__word">
        Third<span className="tl-logo__accent">light</span>
      </span>
    </span>
  );
}
