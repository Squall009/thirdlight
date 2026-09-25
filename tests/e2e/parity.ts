/**
 * Phase 17.2/17.3: pixel parity helpers shared by the shader parity spec
 * (`shader-parity.e2e.ts`) and the environment/post parity spec
 * (`env-parity.e2e.ts`): the comparison, the tolerance rules (logged in
 * docs/plan-phase-17.md §6), a visual diff for failure reports, and a tiny
 * localhost server for a bundled browser harness.
 */
import { createServer, type Server } from 'node:http';

import { expect } from '@playwright/test';
import { build } from 'esbuild';

import type { Image } from './png';
import { makePng } from './png-make';

export interface Diff {
  mean: number;
  bad: number;
  worst: number;
}

/** A tolerance rule: mean absolute channel difference and the share of pixels off by more than `badDelta`. */
export interface Tolerance {
  readonly mean: number;
  readonly badDelta: number;
  readonly bad: number;
  /** Compare block means of `block` × `block` pixels instead of pixels (blur-type effects; 1 = pixels). */
  readonly block?: number;
}

/**
 * The 17.2 rule: mean ≤ 1.5 (of 255) and ≤ 0.5 % of the pixels off by more
 * than 32 in some channel — about twice the SwiftShader noise between three's
 * GLSL chunks and its node code, far below a lost shader hook.
 */
export const STRICT: Tolerance = { mean: 1.5, badDelta: 32, bad: 0.005 };

/** Average `img` over `block` × `block` cells (a smaller image). */
export function blocks(img: Image, block: number): Image {
  if (block <= 1) return img;
  const w = Math.floor(img.width / block);
  const h = Math.floor(img.height / block);
  const data = new Float64Array(w * h * 3);
  for (let by = 0; by < h; by++) {
    for (let bx = 0; bx < w; bx++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = 0; y < block; y++) {
        for (let x = 0; x < block; x++) {
          const p = img.pixel(bx * block + x, by * block + y);
          r += p[0];
          g += p[1];
          b += p[2];
        }
      }
      const n = block * block;
      data.set([r / n, g / n, b / n], (by * w + bx) * 3);
    }
  }
  return { width: w, height: h, pixel: (x: number, y: number) => [data[(y * w + x) * 3]!, data[(y * w + x) * 3 + 1]!, data[(y * w + x) * 3 + 2]!, 255] } as Image;
}

export function diff(a: Image, b: Image, t: Tolerance = STRICT): Diff {
  expect(a.width).toBe(b.width);
  expect(a.height).toBe(b.height);
  const x = blocks(a, t.block ?? 1);
  const y = blocks(b, t.block ?? 1);
  let sum = 0;
  let bad = 0;
  let worst = 0;
  for (let j = 0; j < x.height; j++) {
    for (let i = 0; i < x.width; i++) {
      const p = x.pixel(i, j);
      const r = y.pixel(i, j);
      const d = Math.max(Math.abs(p[0] - r[0]), Math.abs(p[1] - r[1]), Math.abs(p[2] - r[2]));
      sum += Math.abs(p[0] - r[0]) + Math.abs(p[1] - r[1]) + Math.abs(p[2] - r[2]);
      if (d > t.badDelta) bad += 1;
      worst = Math.max(worst, d);
    }
  }
  const n = x.width * x.height;
  return { mean: sum / (n * 3), bad: bad / n, worst };
}

export const within = (d: Diff, t: Tolerance = STRICT): boolean => d.mean <= t.mean && d.bad <= t.bad;
export const show = (d: Diff, t: Tolerance = STRICT): string =>
  `mean ${d.mean.toFixed(2)} (≤ ${t.mean}), >${t.badDelta}: ${(d.bad * 100).toFixed(2)}% (≤ ${t.bad * 100}%), worst ${Math.round(d.worst)}${(t.block ?? 1) > 1 ? ` [${t.block}px blocks]` : ''}`;

/** A visual diff for a failure report: grey reference, orange/red where they differ. */
export function diffPng(a: Image, b: Image, badDelta = STRICT.badDelta): Buffer {
  return makePng(a.width, a.height, (x, y) => {
    const p = a.pixel(x, y);
    const r = b.pixel(x, y);
    const d = Math.max(Math.abs(p[0] - r[0]), Math.abs(p[1] - r[1]), Math.abs(p[2] - r[2]));
    const g = (r[0] + r[1] + r[2]) / 6;
    return d > badDelta ? [255, 0, 0, 255] : d > 8 ? [255, 160, 0, 255] : [g, g, g, 255];
  });
}

/**
 * Bundle a browser harness (esbuild) and serve it with a page holding one
 * `width` × `height` canvas on localhost (a secure context, so
 * `navigator.gpu` exists where the browser has WebGPU).
 */
export async function serveHarness(entry: string, repo: string, width: number, height: number): Promise<{ base: string; close: () => Promise<void> }> {
  const bundle = await build({ entryPoints: [entry], absWorkingDir: repo, bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'error' });
  const js = bundle.outputFiles[0]!.text;
  const html = `<!doctype html><body style="margin:0;background:#000"><canvas width="${width}" height="${height}" style="width:${width}px;height:${height}px;display:block"></canvas><script type="module" src="harness.js"></script></body>`;
  const server: Server = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/harness.js')) {
      res.setHeader('content-type', 'text/javascript');
      res.end(js);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(html);
    }
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    base: `http://localhost:${(server.address() as { port: number }).port}/`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

