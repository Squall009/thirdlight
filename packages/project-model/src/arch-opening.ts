/**
 * Openings in a sweep: the reveals round the hole (the jambs, the head and
 * the sill, across the wall's thickness) and a frame profile swept round
 * it on a face, mitred at its corners — a door's frame stops at the floor.
 * The hole itself is cut by the sweep (`SweepCut`).
 *
 * Pure.
 */
import { len3 } from './arch-math';
import type { ArchMeshWriter } from './arch-mesh';
import { type PathSamples, samplePath } from './arch-path';
import { profileBounds, resolveProfile, type SweepFrames, sweepPointAt, sweepProfile, segmentAt } from './arch-sweep';
import type { ArchitectureOpening, ArchitectureProfile } from './architecture';
import { type TrimRow, type TrimSheet, trimRowDensity, trimRowV } from './trim-sheet';

/** The opening's span along a path `length` metres long, kept inside it (an opening past an end is cut there, never wrapped round). */
export function openingAlong(o: ArchitectureOpening, length: number): { a: number; b: number } {
  return { a: Math.max(0, o.at - o.width / 2), b: Math.min(length, o.at + o.width / 2) };
}

/** The opening's span along the path and its heights, kept inside the path and the wall. */
export function openingSpan(o: ArchitectureOpening, s: PathSamples, wall: readonly number[]): { a: number; b: number; bottom: number; top: number } {
  const [, , y0, y1] = profileBounds(wall);
  return { ...openingAlong(o, s.length), bottom: Math.max(y0, o.bottom), top: Math.min(y1, o.top) };
}

/** A quad of four corners (one strip of `row`: u along 0→1 edge in metres, across 0 at the first two corners). */
function quad(w: ArchMeshWriter, c: readonly number[][], n: readonly number[], sheet: TrimSheet, row: TrimRow, u0: number, u1: number): void {
  const su = trimRowDensity(sheet, row) / sheet.size[0];
  const [v0, v1] = trimRowV(sheet, row);
  const first = w.vertexCount;
  const uv = [
    [u0, v0],
    [u1, v0],
    [u1, v1],
    [u0, v1],
  ];
  for (let k = 0; k < 4; k++) w.vertex(c[k]![0]!, c[k]![1]!, c[k]![2]!, n[0]!, n[1]!, n[2]!, uv[k]![0]! * su, uv[k]![1]!, 0);
  w.triangle(first, first + 1, first + 2, n[0]!, n[1]!, n[2]!);
  w.triangle(first, first + 2, first + 3, n[0]!, n[1]!, n[2]!);
}

/** The reveals: jambs facing into the hole, the head facing down, the sill (when above the wall's foot) facing up. */
export function writeReveals(w: ArchMeshWriter, s: PathSamples, fr: SweepFrames, wall: readonly number[], span: { a: number; b: number; bottom: number; top: number }, sheet: TrimSheet, row: TrimRow): void {
  const [x0, x1, y0] = profileBounds(wall);
  const P = (d: number, x: number, y: number): number[] => {
    const out = [0, 0, 0];
    sweepPointAt(s, fr, d, x, y, out);
    return out;
  };
  const tangent = (d: number): number[] => {
    const j = segmentAt(s, d);
    return [fr.st[j * 3]!, fr.st[j * 3 + 1]!, fr.st[j * 3 + 2]!];
  };
  const upAt = (d: number): number[] => {
    const j = segmentAt(s, d);
    return [fr.su[j * 3]!, fr.su[j * 3 + 1]!, fr.su[j * 3 + 2]!];
  };
  const h = span.top - span.bottom;
  const ta = tangent(span.a);
  quad(w, [P(span.a, x0, span.bottom), P(span.a, x1, span.bottom), P(span.a, x1, span.top), P(span.a, x0, span.top)], ta, sheet, row, 0, h);
  const tb = tangent(span.b);
  quad(w, [P(span.b, x1, span.bottom), P(span.b, x0, span.bottom), P(span.b, x0, span.top), P(span.b, x1, span.top)], [-tb[0]!, -tb[1]!, -tb[2]!], sheet, row, 0, h);
  // Head and sill follow the path between the jambs (a curved wall's opening curves with it).
  const ds = [span.a];
  for (let i = 0; i < s.dist.length; i++) if (s.dist[i]! > span.a + 1e-6 && s.dist[i]! < span.b - 1e-6) ds.push(s.dist[i]!);
  ds.push(span.b);
  for (let k = 0; k + 1 < ds.length; k++) {
    const da = ds[k]!;
    const db = ds[k + 1]!;
    const u = upAt((da + db) / 2);
    quad(w, [P(da, x0, span.top), P(db, x0, span.top), P(db, x1, span.top), P(da, x1, span.top)], [-u[0]!, -u[1]!, -u[2]!], sheet, row, da - span.a, db - span.a);
    if (span.bottom > y0 + 1e-6) quad(w, [P(da, x1, span.bottom), P(db, x1, span.bottom), P(db, x0, span.bottom), P(da, x0, span.bottom)], u, sheet, row, da - span.a, db - span.a);
  }
}

/**
 * The frame: `profile` swept round the opening on the outer face (x max of
 * the wall's profile) or the inner one (x min), its right side away from
 * the hole and its up out of the wall.
 */
export function writeFrame(
  w: ArchMeshWriter,
  s: PathSamples,
  fr: SweepFrames,
  wall: readonly number[],
  span: { a: number; b: number; bottom: number; top: number },
  profile: ArchitectureProfile,
  side: 'outer' | 'inner',
  sheet: TrimSheet,
  rowOf: (slot: string) => TrimRow | null,
): void {
  const [x0, x1, y0] = profileBounds(wall);
  const xf = side === 'outer' ? x1 : x0;
  const P = (d: number, y: number): [number, number, number] => {
    const out = [0, 0, 0];
    sweepPointAt(s, fr, d, xf, y, out);
    return [out[0]!, out[1]!, out[2]!];
  };
  const mid = (span.a + span.b) / 2;
  const j = segmentAt(s, mid);
  const sign = side === 'outer' ? 1 : -1;
  const out = [fr.sr[j * 3]! * sign, fr.sr[j * 3 + 1]! * sign, fr.sr[j * 3 + 2]! * sign];
  const door = span.bottom <= y0 + 1e-6;
  let pts: [number, number, number][] = [P(span.a, span.bottom), P(span.a, span.top), P(span.b, span.top), P(span.b, span.bottom)];
  // The profile's right (travel × out) must look away from the hole: walk the other way round if it looks in.
  const t = [pts[1]![0] - pts[0]![0], pts[1]![1] - pts[0]![1], pts[1]![2] - pts[0]![2]];
  const tl = len3(t[0]!, t[1]!, t[2]!) || 1;
  const right = [(t[1]! * out[2]! - t[2]! * out[1]!) / tl, (t[2]! * out[0]! - t[0]! * out[2]!) / tl, (t[0]! * out[1]! - t[1]! * out[0]!) / tl];
  const centre = P(mid, (span.bottom + span.top) / 2);
  const toCentre = [centre[0] - pts[0]![0], centre[1] - pts[0]![1], centre[2] - pts[0]![2]];
  if (right[0]! * toCentre[0]! + right[1]! * toCentre[1]! + right[2]! * toCentre[2]! > 0) pts = pts.reverse();
  const fs = samplePath({ points: pts, closed: !door });
  sweepProfile(w, fs, resolveProfile(profile, true), { sheet, rowOf, up: out, aoStrength: 0, aoRadius: 1, ground: false });
}
