/**
 * The edit modes' line glyphs (24 px grid, stroked in the current colour):
 * the rail's modes, the header's buttons. Objects keep their generated
 * icons (`viewport/icons.ts`); tools are glyphs so they stay crisp at 20 px
 * and take the state colour (white on the active rail item).
 *
 * Browser-only (React).
 */
import type { JSX } from 'react';

const PATHS: Readonly<Record<string, JSX.Element>> = {
  raise: (
    <>
      <path d="M3 19h18" />
      <path d="M5 19c3-1 4-8 7-8s4 7 7 8" />
      <path d="M12 3v6M9 6l3-3 3 3" />
    </>
  ),
  lower: (
    <>
      <path d="M3 19h18" />
      <path d="M5 13c3 1 4 5 7 5s4-4 7-5" />
      <path d="M12 3v7M9 7l3 3 3-3" />
    </>
  ),
  smooth: (
    <>
      <path d="M3 15c3-6 6 2 9-3s6 1 9-2" />
      <path d="M3 20c4-2 7-1 9-1s5 1 9-1" opacity=".55" />
    </>
  ),
  flatten: (
    <>
      <path d="M3 19h18" />
      <path d="M4 15h16" />
      <path d="M8 11l4-3 4 3" opacity=".55" />
      <path d="M12 8v7" />
    </>
  ),
  noise: (
    <>
      <path d="M3 16l3-5 2 3 3-7 2 6 2-3 3 5 3-4" />
      <path d="M3 20h18" opacity=".5" />
    </>
  ),
  ramp: (
    <>
      <path d="M3 19h18" />
      <path d="M4 19L20 7v12" />
      <circle cx="4" cy="19" r="1.4" />
      <circle cx="20" cy="7" r="1.4" />
    </>
  ),
  brush: (
    <>
      <path d="M18 3l3 3-9 9-3-3z" />
      <path d="M9 12c-3 0-5 2-5 5 0 1-1 2-2 2 2 2 7 2 9-1 1-1.5 1-3 1-3" />
    </>
  ),
  erase: (
    <>
      <path d="M8 20h12" />
      <path d="M4 14l9-9 6 6-9 9H8z" />
      <path d="M8 10l6 6" />
    </>
  ),
  fill: (
    <>
      <path d="M5 11l7-7 7 7-7 7z" />
      <path d="M5 11h14" />
      <path d="M20 15s2 2.5 2 4a2 2 0 0 1-4 0c0-1.5 2-4 2-4z" />
    </>
  ),
  select: (
    <>
      <path d="M5 3l14 7-6 2-2 6z" />
      <path d="M14 14l5 5" />
    </>
  ),
  stamp: (
    <>
      <path d="M8 3h8v4l-2 3h5v4H5v-4h5L8 7z" />
      <path d="M5 18h14v3H5z" />
    </>
  ),
  erode: (
    <>
      <path d="M3 19h18" />
      <path d="M4 19c2-6 4-11 8-11s6 5 8 11" />
      <path d="M10 9c0 3 1 6 2 10M14 10c-1 3-1 6 0 9" opacity=".55" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3" />
      <path d="M6 7l1 13h10l1-13" />
    </>
  ),
  up: <path d="M7 14l5-5 5 5" />,
  down: <path d="M7 10l5 5 5-5" />,
  dice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <circle cx="9" cy="9" r="1" fill="currentColor" />
      <circle cx="15" cy="15" r="1" fill="currentColor" />
      <circle cx="15" cy="9" r="1" fill="currentColor" />
      <circle cx="9" cy="15" r="1" fill="currentColor" />
    </>
  ),
  import: (
    <>
      <path d="M12 3v12M7 10l5 5 5-5" />
      <path d="M4 17v3h16v-3" />
    </>
  ),
  sculpt: (
    <>
      <path d="M2 20l6-9 4 5 3-4 7 8z" />
      <path d="M15 3v5M12.5 5.5L15 3l2.5 2.5" />
    </>
  ),
  paint: (
    <>
      <path d="M14 4l6 6-8 8H6v-6z" />
      <path d="M6 18l-3 3" />
      <path d="M11 7l6 6" />
    </>
  ),
  holes: (
    <>
      <path d="M3 17l5-9h8l5 9z" />
      <ellipse cx="12" cy="13" rx="3.5" ry="2" fill="currentColor" opacity=".35" />
    </>
  ),
  rules: (
    <>
      <path d="M4 6h3M4 12h3M4 18h3" />
      <path d="M10 6h10M10 12h10M10 18h7" />
    </>
  ),
  scatter: (
    <>
      <path d="M7 4l3 6H4z" />
      <path d="M17 9l3 6h-6z" />
      <path d="M9 14l3 6H6z" />
      <path d="M7 10v2M17 15v2M9 20v1" />
    </>
  ),
  stack: (
    <>
      <path d="M12 3l9 5-9 5-9-5z" />
      <path d="M3 12l9 5 9-5" />
      <path d="M3 16l9 5 9-5" />
    </>
  ),
  tiles: (
    <>
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" strokeDasharray="2 2" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 0 0 0 12h3" />
    </>
  ),
  ghost: (
    <>
      <path d="M6 20V10a6 6 0 0 1 12 0v10l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5z" />
      <circle cx="10" cy="10" r=".8" fill="currentColor" />
      <circle cx="14" cy="10" r=".8" fill="currentColor" />
    </>
  ),
  check: <path d="M4 12.5l5 5L20 6.5" />,
  frame: (
    <>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  channels: (
    <>
      <circle cx="9" cy="9" r="5" />
      <circle cx="15" cy="9" r="5" />
      <circle cx="12" cy="15" r="5" />
    </>
  ),
  material: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M4.5 10c3 2 12 2 15 0" />
      <path d="M9 6.5a4 4 0 0 1 3.5-1.5" />
    </>
  ),
  warn: (
    <>
      <path d="M12 3l10 18H2z" />
      <path d="M12 10v5M12 18v.5" />
    </>
  ),
  drop: <path d="M12 3c3 4.5 6 7.5 6 11a6 6 0 0 1-12 0c0-3.5 3-6.5 6-11z" />,
};

/** A glyph by name (an unknown name draws an empty box of the same size). */
export function Glyph({ name, size = 20 }: { name: string; size?: number }): JSX.Element {
  return (
    <svg className="tl-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? null}
    </svg>
  );
}
