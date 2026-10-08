/**
 * Reading the terrain e2e's frames: where a world point lands in a frame the
 * Play camera took (its observed place, turn and field of view), the share of
 * pixels passing a colour test round it or in a whole frame, how much two
 * frames differ; and a small static file server for an export.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize } from 'node:path';

import type { Pred } from './painted-layers';
import type { Image } from './png';

export type V3 = [number, number, number];

/** The Play camera's view of world points: screen fractions [u, v] (null: behind it). */
export type CameraView = { position: number[]; rotation: number[]; fovY: number };
export function projectWith(cam: CameraView, aspect: number, p: V3): [number, number] | null {
  const [qx, qy, qz, qw] = cam.rotation as [number, number, number, number];
  const v = [p[0] - cam.position[0]!, p[1] - cam.position[1]!, p[2] - cam.position[2]!];
  // The inverse rotation (the conjugate quaternion) takes the point into the camera's frame.
  const [x, y, z] = [-qx, -qy, -qz];
  const tx = 2 * (y * v[2]! - z * v[1]!);
  const ty = 2 * (z * v[0]! - x * v[2]!);
  const tz = 2 * (x * v[1]! - y * v[0]!);
  const cx = v[0]! + qw * tx + (y * tz - z * ty);
  const cy = v[1]! + qw * ty + (z * tx - x * tz);
  const cz = v[2]! + qw * tz + (x * ty - y * tx);
  if (cz >= -0.01) return null;
  const f = 1 / Math.tan((cam.fovY * Math.PI) / 360);
  return [((f / aspect) * (cx / -cz) + 1) / 2, (1 - f * (cy / -cz)) / 2];
}
/** The share of a square of a frame around a world point (as the camera sees it) passing `test`. */
export function frameShareNear(img: Image, cam: CameraView, p: V3, test: Pred, size = 8): number {
  const uv = projectWith(cam, img.width / img.height, p);
  if (uv === null) return 0;
  const cx = Math.round(uv[0] * img.width);
  const cy = Math.round(uv[1] * img.height);
  let n = 0;
  let all = 0;
  for (let y = cy - size / 2; y < cy + size / 2; y++) for (let x = cx - size / 2; x < cx + size / 2; x++) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    all += 1;
    if (test(...img.pixel(x, y))) n += 1;
  }
  return all === 0 ? 0 : n / all;
}

/** Pixels passing `test` (every second one). */
export function count(img: Image, test: Pred): number {
  let n = 0;
  for (let y = 0; y < img.height; y += 2) for (let x = 0; x < img.width; x += 2) if (test(...img.pixel(x, y))) n += 1;
  return n;
}

/** The mean absolute difference of two equal-sized pictures (0–255 per channel). */
export function meanDiff(a: Image, b: Image): number {
  let sum = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    const p = a.pixel(x, y);
    const q = b.pixel(x, y);
    sum += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
  }
  return sum / (a.width * a.height * 3);
}
export function share(img: Image, test: Pred): number {
  let n = 0;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (test(...img.pixel(x, y))) n += 1;
  return n / (img.width * img.height);
}

/** A static server for an export's folder. */
export function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server: Server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]!)).replace(/^\/+/, '') || 'index.html';
    const file = join(dir, rel);
    if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      ok({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}
