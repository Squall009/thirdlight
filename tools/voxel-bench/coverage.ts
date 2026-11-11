/**
 * The coverage bench's arithmetic (coverage-cli.ts): the flight's line and
 * altitude over a world's ground, where the camera is at a distance along
 * it, which screen rows must show ground, and which pixels show the key
 * colour the run gives the sky (a pixel of it below those rows is a hole).
 */

/** The flight: waypoints (metres, x z), its ground and two altitude tables every `step` metres. */
export interface CoveragePath {
  readonly waypoints: ReadonlyArray<readonly [number, number]>;
  readonly step: number;
  readonly total: number;
  /** The ground (metres) every `step` along the line, the highest of three samples across it. */
  readonly ground: readonly number[];
  /** The camera 30 m over the highest ground from 50 m behind to 150 m ahead. */
  readonly high: readonly number[];
  /** Ground-hugging: 5 m over the highest ground from 10 m behind to 30 m ahead. */
  readonly hug: readonly number[];
}

/** Metres over the ground of the two altitudes, and the windows their highest ground is taken over (behind, ahead). */
export const COVERAGE_ALTITUDES = Object.freeze({ high: { over: 30, behind: 50, ahead: 150 }, hug: { over: 5, behind: 10, ahead: 30 } });

/** A point and heading `m` metres along a polyline. */
export function along(waypoints: CoveragePath['waypoints'], m: number): { x: number; z: number; dx: number; dz: number } {
  let r = Math.max(0, m);
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]!, b = waypoints[i]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dx = (b[0] - a[0]) / len, dz = (b[1] - a[1]) / len;
    if (r <= len || i === waypoints.length - 1) {
      const t = Math.min(r, len);
      return { x: a[0] + dx * t, z: a[1] + dz * t, dx, dz };
    }
    r -= len;
  }
  const p = waypoints[0]!;
  return { x: p[0], z: p[1], dx: 1, dz: 0 };
}

/** The flight over `ground(x, z)` (metres; the highest of the line and 12 m either side every `step`). */
export function coveragePath(waypoints: CoveragePath['waypoints'], ground: (x: number, z: number) => number, step = 25): CoveragePath {
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) total += Math.hypot(waypoints[i]![0] - waypoints[i - 1]![0], waypoints[i]![1] - waypoints[i - 1]![1]);
  const n = Math.ceil(total / step) + 1;
  const pad = 8;
  const g: number[] = [];
  for (let i = -pad; i < n + pad; i++) {
    const p = along(waypoints, Math.min(total, Math.max(0, i * step)));
    let h = -Infinity;
    for (const s of [-12, 0, 12]) h = Math.max(h, ground(p.x - p.dz * s, p.z + p.dx * s));
    g.push(h);
  }
  const at = (i: number): number => g[Math.max(0, Math.min(g.length - 1, i + pad))]!;
  const table = (a: { over: number; behind: number; ahead: number }): number[] =>
    Array.from({ length: n }, (_, i) => {
      let h = -Infinity;
      for (let k = Math.floor(-a.behind / step); k <= Math.ceil(a.ahead / step); k++) h = Math.max(h, at(i + k));
      return Math.round(h + a.over);
    });
  return { waypoints, step, total: Math.round(total), ground: Array.from({ length: n }, (_, i) => Math.round(at(i))), high: table(COVERAGE_ALTITUDES.high), hug: table(COVERAGE_ALTITUDES.hug) };
}

/** The distance along the line (metres) nearest a camera position (x, z). */
export function distanceAlong(path: CoveragePath, x: number, z: number): number {
  let best = 0, bestD = Infinity;
  for (let m = 0; m <= path.total; m += path.step / 5) {
    const p = along(path.waypoints, m);
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

/** A camera of the flight: where it is (metres), its heading's yaw (it looks along −(sin yaw, cos yaw)) and its pitch down. */
export interface FlightCamera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
}

/**
 * Which pixels of a `width` × `height` view must show ground: those whose ray falls to the world's lowest ground
 * (`floorY`) inside its bounds (`[min, max]` metres in x and z, less `inset`). The ground is a height field over the
 * whole world at or above that floor, so such a ray meets it before it leaves the world; a ray reaching the bounds
 * first may see past the world's edge (sky). Returns a mask, row-major.
 */
export function groundMask(width: number, height: number, cam: FlightCamera, fovY: number, bounds: { readonly min: number; readonly max: number }, floorY: number, inset = 32): Uint8Array {
  const out = new Uint8Array(width * height);
  const ty = Math.tan(fovY / 2);
  const tx = ty * (width / height);
  // Forward (pitched down), right and up of the camera.
  const fx = -Math.sin(cam.yaw) * Math.cos(cam.pitch), fy = -Math.sin(cam.pitch), fz = -Math.cos(cam.yaw) * Math.cos(cam.pitch);
  const rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
  const ux = -Math.sin(cam.pitch) * Math.sin(cam.yaw), uy = Math.cos(cam.pitch), uz = -Math.sin(cam.pitch) * Math.cos(cam.yaw);
  const lo = bounds.min + inset, hi = bounds.max - inset;
  const drop = cam.y - floorY;
  for (let row = 0; row < height; row++) {
    const v = (1 - (2 * (row + 0.5)) / height) * ty;
    for (let col = 0; col < width; col++) {
      const u = ((2 * (col + 0.5)) / width - 1) * tx;
      const dx = fx + u * rx + v * ux, dy = fy + v * uy, dz = fz + u * rz + v * uz;
      if (dy >= 0 || drop <= 0) continue;
      const t = drop / -dy;
      const hx = cam.x + dx * t, hz = cam.z + dz * t;
      if (hx > lo && hx < hi && hz > lo && hz < hi) out[row * width + col] = 1;
    }
  }
  return out;
}



/** Whether an RGB pixel is the run's key sky (magenta, after tone mapping and an upscaler's blend at its edges). */
export function isKey(r: number, g: number, b: number): boolean {
  return r > 170 && b > 170 && g < 100 && Math.abs(r - b) < 70;
}

