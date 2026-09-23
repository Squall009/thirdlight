/**
 * Editor layout state: the three dock sizes (left/right widths, bottom
 * height) with draggable splitters, remembered per browser in localStorage.
 * Layout is presentation only: it never touches project data.
 */
import { useCallback, useEffect, useState, type PointerEvent as ReactPointerEvent } from 'react';

export interface DockSizes {
  left: number;
  right: number;
  bottom: number;
}

const KEY = 'thirdlight.layout.v2';
export const DEFAULT_SIZES: DockSizes = { left: 280, right: 320, bottom: 300 };
const MIN = { left: 160, right: 220, bottom: 120 } as const;
/** Keep the centre at least this wide/tall whatever the docks ask for. */
const MIN_CENTER = 360;

function clampSizes(s: DockSizes, viewportW: number, viewportH: number): DockSizes {
  const left = Math.max(MIN.left, Math.min(s.left, viewportW - MIN_CENTER - MIN.right));
  const right = Math.max(MIN.right, Math.min(s.right, viewportW - MIN_CENTER - left));
  const bottom = Math.max(MIN.bottom, Math.min(s.bottom, viewportH - 200));
  return { left, right, bottom };
}

function load(): DockSizes {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SIZES;
    const v = JSON.parse(raw) as Partial<DockSizes>;
    const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
    return { left: num(v.left, DEFAULT_SIZES.left), right: num(v.right, DEFAULT_SIZES.right), bottom: num(v.bottom, DEFAULT_SIZES.bottom) };
  } catch {
    return DEFAULT_SIZES;
  }
}

function save(s: DockSizes): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // no storage: the layout lives for this page only
  }
}

/** The dock sizes and a pointer-down handler factory for each splitter. */
export function useDockSizes(): { sizes: DockSizes; splitter: (which: keyof DockSizes) => (e: ReactPointerEvent<HTMLDivElement>) => void } {
  const [sizes, setSizes] = useState<DockSizes>(() => clampSizes(load(), window.innerWidth, window.innerHeight));
  useEffect(() => {
    const onResize = (): void => setSizes((s) => clampSizes(s, window.innerWidth, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const splitter = useCallback(
    (which: keyof DockSizes) => (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startY = e.clientY;
      const start = sizes[which];
      handle.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent): void => {
        const delta = which === 'left' ? ev.clientX - startX : which === 'right' ? startX - ev.clientX : startY - ev.clientY;
        setSizes((s) => clampSizes({ ...s, [which]: start + delta }, window.innerWidth, window.innerHeight));
      };
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        setSizes((s) => {
          save(s);
          return s;
        });
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [sizes],
  );
  return { sizes, splitter };
}

/** Forget the remembered sizes (the next load uses the defaults). */
export function resetLayout(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}
