/**
 * The profiler's timeline: the last frames as bars, one column a page frame
 * (newest at the right), one lane a thread (the page, the simulation worker,
 * the job workers per worker), each bar stacked by category in the
 * category's colour, against the frame interval (the cap's dashed line, half
 * way up a lane). Long frames are marked red along the top; the selected
 * column is lit. Under the lanes, the GPU as pass shares of its last
 * timestamp read — never milliseconds at a cap, where the GPU's clock follows
 * its load.
 *
 * Canvas 2D, drawn at the device's pixel ratio; a click picks a column.
 * Browser-only (React).
 */
import { useEffect, useRef, useState, type JSX } from 'react';

import { PROFILE_FRAMES } from '@thirdlight/shared';
import { PROFILE_CATEGORY_COLOURS, PROFILE_LANE_LABELS, PROFILE_LANES, profileBar, profileColumnAt, profileScaleMs, type ProfileColumn, type ProfileReport } from '@thirdlight/game-host/profile-view';

const GUTTER = 84;
const LANE_H = 40;
const LANE_GAP = 5;
const GPU_H = 18;
const TOP = 6;

/** The theme's tokens, read once a draw (the canvas cannot use CSS variables). */
function theme(el: Element): { text: string; dim: string; faint: string; line: string; lane: string; cap: string; err: string; select: string } {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string): string => s.getPropertyValue(name).trim() || fallback;
  return { text: v('--text', '#e8ebf0'), dim: v('--text-dim', '#9aa3b2'), faint: v('--text-faint', '#667082'), line: v('--line', '#2a3039'), lane: v('--surface-0', '#14171c'), cap: v('--brand', '#f2b544'), err: v('--err', '#ff5d5d'), select: v('--select-bg', 'rgba(76,141,255,.18)') };
}

/** The timeline's height in CSS pixels. */
export const timelineHeight = (): number => TOP + PROFILE_LANES.length * (LANE_H + LANE_GAP) + GPU_H + 4;

interface Props {
  report: ProfileReport;
  /** Columns the width is shared by (the newest at the right); a spike's few frames take fewer, wider ones. */
  slots?: number;
  columns: readonly ProfileColumn[];
  selected: number | null;
  onSelect: (index: number) => void;
  onHover: (index: number | null) => void;
}

export function ProfilerTimeline({ report, columns, selected, onSelect, onHover, slots: wanted }: Props): JSX.Element {
  // The page keeps PROFILE_FRAMES frames a thread: room for all of them.
  const slots = Math.max(columns.length, wanted ?? PROFILE_FRAMES);
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(600);
  const height = timelineHeight();
  // The canvas follows its box's width.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The columns fill the slots from the right, so a frame keeps its place as newer ones arrive.
  const plotW = Math.max(1, width - GUTTER);
  const slotW = plotW / slots;
  const offset = slots - columns.length;
  const columnOf = (x: number): number | null => {
    const slot = profileColumnAt(x - GUTTER, plotW, slots);
    if (slot === null || slot < offset) return null;
    return slot - offset;
  };

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
    const g = el.getContext('2d');
    if (g === null) return;
    const t = theme(el);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    g.font = '11px Inter, system-ui, sans-serif';
    g.textBaseline = 'middle';
    const scale = profileScaleMs(report);
    PROFILE_LANES.forEach((lane, li) => {
      const y0 = TOP + li * (LANE_H + LANE_GAP);
      g.fillStyle = t.lane;
      g.fillRect(GUTTER, y0, plotW, LANE_H);
      g.fillStyle = t.dim;
      g.textAlign = 'left';
      g.fillText(PROFILE_LANE_LABELS[lane], 6, y0 + LANE_H / 2 - 6);
      g.fillStyle = t.faint;
      g.fillText(lane === 'jobs' ? 'ms / worker' : 'ms / frame', 6, y0 + LANE_H / 2 + 8);
      if (selected !== null && selected < columns.length) {
        g.fillStyle = t.select;
        g.fillRect(GUTTER + (selected + offset) * slotW, y0, Math.max(1, slotW), LANE_H);
      }
      columns.forEach((c, i) => {
        const x = GUTTER + (i + offset) * slotW;
        const w = Math.max(1, slotW - (slotW > 3 ? 1 : 0));
        for (const s of profileBar(c.lanes[lane], LANE_H, scale)) {
          g.fillStyle = PROFILE_CATEGORY_COLOURS[s.category];
          g.fillRect(x, y0 + s.y, w, s.h);
        }
      });
      // The frame interval: half way up, as the scale is twice it.
      const capY = y0 + LANE_H / 2;
      g.strokeStyle = t.cap;
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(GUTTER, capY + 0.5);
      g.lineTo(GUTTER + plotW, capY + 0.5);
      g.stroke();
      g.setLineDash([]);
      // The interval's value at the line's oldest end, above it (the gutter holds the lane's name; the newest frames the right).
      if (li === 0) {
        g.font = '10px Inter, system-ui, sans-serif';
        const label = `${report.intervalMs.toFixed(1)} ms a frame`;
        const lw = g.measureText(label).width + 6;
        g.fillStyle = t.lane;
        g.fillRect(GUTTER + 2, capY - 13, lw, 12);
        g.fillStyle = t.cap;
        g.textAlign = 'left';
        g.fillText(label, GUTTER + 5, capY - 7);
        g.font = '11px Inter, system-ui, sans-serif';
      }
    });
    // Long frames: a red tick over every lane's column.
    g.fillStyle = t.err;
    columns.forEach((c, i) => {
      if (c.long) g.fillRect(GUTTER + (i + offset) * slotW, 1, Math.max(2, slotW - 1), 4);
    });
    // The GPU: pass shares of the last timestamp read.
    const gy = TOP + PROFILE_LANES.length * (LANE_H + LANE_GAP);
    g.textAlign = 'left';
    g.fillStyle = t.dim;
    g.fillText('GPU', 6, gy + GPU_H / 2);
    const shares = report.gpu.shares;
    if (shares !== null) {
      const rw = plotW * shares.render;
      g.fillStyle = PROFILE_CATEGORY_COLOURS.render;
      g.fillRect(GUTTER, gy, rw, GPU_H);
      g.fillStyle = PROFILE_CATEGORY_COLOURS.effects;
      g.fillRect(GUTTER + rw, gy, plotW - rw, GPU_H);
      g.fillStyle = '#0d0f13';
      g.fillText(`render passes ${Math.round(shares.render * 100)} %`, GUTTER + 6, gy + GPU_H / 2);
      if (shares.compute > 0.12) g.fillText(`compute ${Math.round(shares.compute * 100)} %`, GUTTER + rw + 6, gy + GPU_H / 2);
    } else {
      g.fillStyle = t.lane;
      g.fillRect(GUTTER, gy, plotW, GPU_H);
      g.fillStyle = t.faint;
      g.fillText('pass shares: not measured here (no GPU timestamps); room: the headroom bench', GUTTER + 6, gy + GPU_H / 2);
    }
  }, [report, columns, selected, width, height, plotW, slotW, offset]);

  const pageBars = columns.filter((c) => c.lanes.page.ms > 0).length;
  const simBars = columns.filter((c) => c.lanes.sim.ms > 0).length;
  const jobBars = columns.filter((c) => c.lanes.jobs.ms > 0).length;
  return (
    <canvas
      ref={ref}
      className="tl-prof__timeline"
      style={{ height }}
      data-testid="profiler-timeline"
      data-columns={columns.length}
      data-page-bars={pageBars}
      data-sim-bars={simBars}
      data-jobs-bars={jobBars}
      data-selected={selected ?? ''}
      aria-label="frame timeline: one column a frame, one lane a thread; click a frame to see what every thread did in it"
      onClick={(e) => {
        const i = columnOf(e.nativeEvent.offsetX);
        if (i !== null) onSelect(i);
      }}
      onMouseMove={(e) => onHover(columnOf(e.nativeEvent.offsetX))}
      onMouseLeave={() => onHover(null)}
    />
  );
}
