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
};

/** A glyph by name (an unknown name draws an empty box of the same size). */
export function Glyph({ name, size = 20 }: { name: string; size?: number }): JSX.Element {
  return (
    <svg className="tl-glyph" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name] ?? null}
    </svg>
  );
}
