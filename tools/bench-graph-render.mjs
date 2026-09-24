/**
 * Phase 16.1: the graph editor's rendering choice, measured.
 *
 * Draws the same 2000-node / 2000-edge graph three ways in the pinned
 * Playwright Chromium (on this host: CPU raster, SwiftShader GL) and animates
 * a pan + zoom for a fixed number of frames, reporting the mean and p95
 * frame interval (requestAnimationFrame deltas, so paint and raster count)
 * and the mean script time per frame:
 *
 *   canvas   one 2D canvas: grid, edges, nodes and labels redrawn per frame
 *            (culled to the view);
 *   svg-dom  nodes as absolutely positioned DOM elements, edges in one SVG,
 *            pan/zoom as one CSS transform on the container;
 *   hybrid   canvas for the grid, edges and node bodies + a DOM layer of
 *            focusable node/port elements only for the nodes in view.
 *
 * Each runs "all in view" (zoomed out, worst case) and "working zoom"
 * (about 100 nodes in view). The numbers are relative (this host has no
 * GPU); the decision is logged in docs/plan-phase-16.md §6.
 *
 * Run: node tools/bench-graph-render.mjs
 */
import { chromium } from '@playwright/test';

import { browserLaunchEnv } from '../tests/e2e/browser-env.mjs';

const PAGE = String.raw`<!doctype html><html><body style="margin:0;overflow:hidden;background:#1d1f24">
<div id="host" style="position:absolute;inset:0;overflow:hidden"></div>
<script>
const N = 2000, COLS = 50, W = 160, H = 84, GX = 220, GY = 130;
const nodes = [];
for (let i = 0; i < N; i++) nodes.push({ id: 'n' + i, x: (i % COLS) * GX, y: Math.floor(i / COLS) * GY, title: 'Node ' + i });
const edges = [];
for (let i = 0; i < N; i++) { const j = i + 1 < N ? i + 1 : 0; edges.push([i, j, i % 3]); }
const VW = innerWidth, VH = innerHeight;
function bez(ctx, x1, y1, x2, y2) { const d = Math.max(40, Math.abs(x2 - x1) / 2); ctx.moveTo(x1, y1); ctx.bezierCurveTo(x1 + d, y1, x2 - d, y2, x2, y2); }
const port = (n, k, out) => [n.x + (out ? W : 0), n.y + 34 + k * 18];

function canvasSetup(domLayer) {
  const host = document.getElementById('host'); host.innerHTML = '';
  const c = document.createElement('canvas'); c.width = VW; c.height = VH; c.style.cssText = 'position:absolute;inset:0'; host.appendChild(c);
  const layer = document.createElement('div'); layer.style.cssText = 'position:absolute;inset:0;transform-origin:0 0'; host.appendChild(layer);
  const ctx = c.getContext('2d');
  const pool = new Map();
  return (view) => {
    const { x: ox, y: oy, s } = view;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#1d1f24'; ctx.fillRect(0, 0, VW, VH);
    // grid
    const g = 20 * s; if (g > 6) { ctx.strokeStyle = '#262a31'; ctx.lineWidth = 1; ctx.beginPath();
      for (let x = ((ox % g) + g) % g; x < VW; x += g) { ctx.moveTo(x, 0); ctx.lineTo(x, VH); }
      for (let y = ((oy % g) + g) % g; y < VH; y += g) { ctx.moveTo(0, y); ctx.lineTo(VW, y); } ctx.stroke(); }
    ctx.setTransform(s, 0, 0, s, ox, oy);
    const x0 = -ox / s - W, y0 = -oy / s - H, x1 = (VW - ox) / s, y1 = (VH - oy) / s;
    const vis = (n) => n.x > x0 && n.x < x1 && n.y > y0 && n.y < y1;
    ctx.lineWidth = 2 / Math.max(s, 0.5);
    for (const col of ['#7fb3ff', '#ffc46b', '#9be28c']) { ctx.strokeStyle = col; ctx.beginPath();
      for (const [a, b, k] of edges) { if (['#7fb3ff', '#ffc46b', '#9be28c'][k] !== col) continue; const A = nodes[a], B = nodes[b]; if (!vis(A) && !vis(B)) continue; const p = port(A, k, true), q = port(B, k, false); bez(ctx, p[0], p[1], q[0], q[1]); } ctx.stroke(); }
    ctx.font = '12px sans-serif';
    let shown = 0;
    for (const n of nodes) { if (!vis(n)) continue; shown++;
      ctx.fillStyle = '#2c313a'; ctx.fillRect(n.x, n.y, W, H); ctx.fillStyle = '#3d5a80'; ctx.fillRect(n.x, n.y, W, 22);
      if (s > 0.35) { ctx.fillStyle = '#e8e8e8'; ctx.fillText(n.title, n.x + 8, n.y + 15); }
      ctx.fillStyle = '#7fb3ff'; for (let k = 0; k < 3; k++) { ctx.fillRect(n.x - 4, n.y + 30 + k * 18, 8, 8); ctx.fillRect(n.x + W - 4, n.y + 30 + k * 18, 8, 8); } }
    if (domLayer) {
      layer.style.transform = 'translate(' + ox + 'px,' + oy + 'px) scale(' + s + ')';
      const keep = new Set();
      for (const n of nodes) { if (!vis(n)) continue; keep.add(n.id); let el = pool.get(n.id);
        if (!el) { el = document.createElement('div'); el.tabIndex = 0; el.setAttribute('aria-label', n.title);
          el.style.cssText = 'position:absolute;width:' + W + 'px;height:' + H + 'px;left:' + n.x + 'px;top:' + n.y + 'px';
          for (let k = 0; k < 6; k++) { const p = document.createElement('button'); p.style.cssText = 'position:absolute;width:10px;height:10px;opacity:0;left:' + (k < 3 ? -5 : W - 5) + 'px;top:' + (29 + (k % 3) * 18) + 'px'; p.setAttribute('aria-label', 'port ' + k); el.appendChild(p); }
          pool.set(n.id, el); layer.appendChild(el); } }
      for (const [id, el] of pool) if (!keep.has(id)) { el.remove(); pool.delete(id); }
    }
    return shown;
  };
}

function svgDomSetup() {
  const host = document.getElementById('host'); host.innerHTML = '';
  const world = document.createElement('div'); world.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;background-image:linear-gradient(#262a31 1px,transparent 1px),linear-gradient(90deg,#262a31 1px,transparent 1px);background-size:20px 20px;width:' + (COLS * GX) + 'px;height:' + (Math.ceil(N / COLS) * GY) + 'px';
  host.appendChild(world);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('width', COLS * GX); svg.setAttribute('height', Math.ceil(N / COLS) * GY); svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
  for (const [a, b, k] of edges) { const A = nodes[a], B = nodes[b]; const p = port(A, k, true), q = port(B, k, false); const d = Math.max(40, Math.abs(q[0] - p[0]) / 2);
    const path = document.createElementNS(NS, 'path'); path.setAttribute('d', 'M' + p[0] + ' ' + p[1] + 'C' + (p[0] + d) + ' ' + p[1] + ' ' + (q[0] - d) + ' ' + q[1] + ' ' + q[0] + ' ' + q[1]);
    path.setAttribute('stroke', ['#7fb3ff', '#ffc46b', '#9be28c'][k]); path.setAttribute('fill', 'none'); path.setAttribute('stroke-width', '2'); svg.appendChild(path); }
  world.appendChild(svg);
  for (const n of nodes) { const el = document.createElement('div'); el.tabIndex = 0;
    el.style.cssText = 'position:absolute;box-sizing:border-box;width:' + W + 'px;height:' + H + 'px;left:' + n.x + 'px;top:' + n.y + 'px;background:#2c313a;border-radius:4px;font:12px sans-serif;color:#e8e8e8';
    el.innerHTML = '<div style="background:#3d5a80;height:22px;padding:4px 8px">' + n.title + '</div>';
    for (let k = 0; k < 6; k++) { const p = document.createElement('button'); p.style.cssText = 'position:absolute;width:8px;height:8px;border:0;padding:0;background:#7fb3ff;left:' + (k < 3 ? -4 : W - 4) + 'px;top:' + (30 + (k % 3) * 18) + 'px'; el.appendChild(p); }
    world.appendChild(el); }
  return (view) => { world.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.s + ')'; return N; };
}

window.bench = async (mode, zoomed, frames) => {
  const draw = mode === 'canvas' ? canvasSetup(false) : mode === 'hybrid' ? canvasSetup(true) : svgDomSetup();
  const s0 = zoomed ? 1 : Math.min(VW / (COLS * GX), VH / (Math.ceil(N / COLS) * GY));
  // Warm-up: the first frame builds the DOM / pools (not a steady-state frame).
  for (let f = 0; f < 10; f++) await new Promise((r) => requestAnimationFrame(() => { draw({ x: 0, y: 0, s: s0 }); r(); }));
  const deltas = [], script = []; let last = performance.now();
  for (let f = 0; f < frames; f++) {
    await new Promise((r) => requestAnimationFrame((t) => { const t0 = performance.now();
      const view = { x: -f * 3 + (zoomed ? -2000 : 0), y: -f * 2 + (zoomed ? -1500 : 0), s: s0 * (1 + 0.15 * Math.sin(f / 10)) };
      draw(view); script.push(performance.now() - t0); deltas.push(t - last); last = t; r(); }));
  }
  deltas.shift();
  const sorted = [...deltas].sort((a, b) => a - b);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  return { mean: +mean(deltas).toFixed(1), median: +sorted[Math.floor(sorted.length / 2)].toFixed(1), p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1), script: +mean(script).toFixed(2) };
};
</script></body></html>`;

const browser = await chromium.launch({
  env: browserLaunchEnv(),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.setContent(PAGE);
const rows = [];
for (const zoomed of [false, true]) {
  for (const mode of ['canvas', 'svg-dom', 'hybrid']) {
    await page.setContent(PAGE);
    const r = await page.evaluate(([m, z]) => window.bench(m, z, 120), [mode, zoomed]);
    rows.push({ view: zoomed ? 'working zoom' : 'all in view', mode, ...r });
  }
}
console.log('view          mode      frame ms (mean / median / p95)  script ms/frame');
for (const r of rows) console.log(`${r.view.padEnd(13)} ${r.mode.padEnd(9)} ${String(r.mean).padStart(6)} / ${String(r.median).padStart(5)} / ${String(r.p95).padEnd(12)} ${r.script}`);
await browser.close();
