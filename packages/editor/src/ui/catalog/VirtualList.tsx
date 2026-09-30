/**
 * A virtualized list or grid: only the rows in view (and a few either side)
 * are in the DOM, so a list of tens of thousands of items scrolls at the cost
 * of a screenful. Rows have a fixed stride; in grid mode the columns follow
 * the width (as a CSS `repeat(auto-fill, minmax(w, 1fr))` grid lays them out),
 * so the same stylesheet grid can be used with spacer rows above and below.
 *
 * Built here rather than taken from a package: the editor needs one fixed
 * stride list/grid, ~150 lines, and every dependency is pinned and audited
 * (tools/check-deps.mjs).
 *
 * Browser-only (React, ResizeObserver).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX, type ReactNode, type Ref } from 'react';

export interface VirtualListProps {
  /** How many items there are (their contents are asked for by index). */
  count: number;
  /** One row's height plus the gap below it (px). */
  stride: number;
  /** The gap between rows and columns (px; part of `stride`). */
  gap?: number;
  /** Grid mode: the narrowest item (px); the columns follow the width. Absent: one column. */
  minItemWidth?: number;
  /** The container's own padding on each side (px), which the columns do not use. */
  padding?: number;
  /** Rows drawn above and below the view. */
  overscan?: number;
  /** The item at `index` (a keyed element: `li` for the default `ul`). */
  renderItem: (index: number) => ReactNode;
  /** The items in view changed (with the overscan): load what they show. */
  onRange?: (from: number, to: number) => void;
  /** Rendered in place of the items when `count` is 0. */
  empty?: ReactNode;
  className?: string;
  style?: CSSProperties;
  as?: 'ul' | 'div';
  role?: string;
  ariaLabel?: string;
  /** The scroll container (tests and callers that scroll it). */
  containerRef?: Ref<HTMLElement>;
  /** Scroll so that this item is in view (changes of the value scroll once). */
  scrollToIndex?: number | null;
}

/** The columns a CSS auto-fill grid makes in `width` (px). */
export function gridColumns(width: number, minItemWidth: number, gap: number, padding: number): number {
  const inner = Math.max(0, width - 2 * padding);
  return Math.max(1, Math.floor((inner + gap) / (minItemWidth + gap)));
}

/** The item range to draw for a scroll position (with `overscan` rows either side). */
export function visibleRange(o: { count: number; columns: number; stride: number; padding: number; scrollTop: number; height: number; overscan: number }): { firstRow: number; lastRow: number; rows: number } {
  const rows = Math.ceil(o.count / o.columns);
  const top = Math.max(0, o.scrollTop - o.padding);
  const firstRow = Math.max(0, Math.floor(top / o.stride) - o.overscan);
  const lastRow = Math.min(rows, Math.ceil((top + o.height) / o.stride) + o.overscan);
  return { firstRow, lastRow: Math.max(firstRow, lastRow), rows };
}

export function VirtualList(p: VirtualListProps): JSX.Element {
  const ref = useRef<HTMLElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0, scrollTop: 0 });
  const gap = p.gap ?? 0;
  const padding = p.padding ?? 0;
  const overscan = p.overscan ?? 4;
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      ref.current = el;
      const r = p.containerRef;
      if (typeof r === 'function') r(el);
      else if (r !== null && r !== undefined) (r as { current: HTMLElement | null }).current = el;
    },
    [p.containerRef],
  );
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = (): void => setBox((b) => (b.width === el.clientWidth && b.height === el.clientHeight && b.scrollTop === el.scrollTop ? b : { width: el.clientWidth, height: el.clientHeight, scrollTop: el.scrollTop }));
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    // One read per frame however many scroll events arrive.
    let frame = 0;
    const onScroll = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener('scroll', onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);
  const columns = p.minItemWidth !== undefined ? gridColumns(box.width, p.minItemWidth, gap, padding) : 1;
  // Before the first measure, draw one screen's worth (a test or a first paint sees items at once).
  const height = box.height > 0 ? box.height : 600;
  const { firstRow, lastRow, rows } = visibleRange({ count: p.count, columns, stride: p.stride, padding, scrollTop: box.scrollTop, height, overscan });
  const from = firstRow * columns;
  const to = Math.min(p.count, lastRow * columns);
  const onRange = p.onRange;
  useEffect(() => {
    if (to > from) onRange?.(from, to);
  }, [from, to, onRange]);
  const scrollTo = p.scrollToIndex;
  useEffect(() => {
    const el = ref.current;
    if (el === null || scrollTo === null || scrollTo === undefined || scrollTo < 0) return;
    const row = Math.floor(scrollTo / columns);
    const top = padding + row * p.stride;
    if (top < el.scrollTop || top + p.stride > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 2);
    // Only when asked to (a new value), not on every layout change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the scroll follows the requested index, not the stride or columns
  }, [scrollTo]);
  const items: ReactNode[] = [];
  for (let i = from; i < to; i++) items.push(p.renderItem(i));
  const Tag = p.as ?? 'ul';
  const Pad = Tag === 'ul' ? 'li' : 'div';
  // Spacers stand for the rows not drawn (a grid gap follows each, so it is left out of their height).
  const topPad = firstRow > 0 ? firstRow * p.stride - gap : 0;
  const bottomPad = lastRow < rows ? (rows - lastRow) * p.stride - gap : 0;
  const padStyle = (h: number): CSSProperties => ({ height: h, gridColumn: '1 / -1', padding: 0, margin: 0, border: 0, listStyle: 'none' });
  return (
    <Tag ref={setRef as never} className={p.className} style={p.style} role={p.role} aria-label={p.ariaLabel} data-virtual-count={p.count} data-virtual-from={from} data-virtual-to={to}>
      {topPad > 0 && <Pad aria-hidden="true" className="tl-virtual__pad" style={padStyle(topPad)} />}
      {p.count === 0 ? p.empty : items}
      {bottomPad > 0 && <Pad aria-hidden="true" className="tl-virtual__pad" style={padStyle(bottomPad)} />}
    </Tag>
  );
}
