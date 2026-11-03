/**
 * A voxel world's region files read by byte range over HTTP: the backend's
 * range route (the voxel world page, with the editor's token) and the
 * preview origin's (Play, by its locator). One request a read; a server
 * that ignores the range answers the whole file, and the read takes its
 * part of it.
 */
import { SampleRing, type RegionByteSource } from '@thirdlight/voxel';

/** What the reads cost (a page's measurements). */
export interface RangeReadStats {
  requests: number;
  bytes: number;
  readonly ms: SampleRing;
}

export function rangeReadStats(): RangeReadStats {
  return { requests: 0, bytes: 0, ms: new SampleRing() };
}

/** Reads `url` by range (`headers` go with every request). */
export function rangeByteSource(url: string, headers: Readonly<Record<string, string>>, stats?: RangeReadStats): RegionByteSource {
  return {
    read: async (offset, length) => {
      const t0 = performance.now();
      const r = await fetch(url, { headers: { ...headers, range: `bytes=${offset}-${offset + length - 1}` } });
      // Past the end of the file: fewer bytes (none), as a byte source may answer.
      if (r.status === 416) return new Uint8Array(0);
      if (r.status !== 206 && r.status !== 200) throw new Error(`${url}: HTTP ${r.status}`);
      const all = new Uint8Array(await r.arrayBuffer());
      const b = r.status === 200 ? all.subarray(offset, offset + length) : all;
      if (stats !== undefined) {
        stats.requests++;
        stats.bytes += b.length;
        stats.ms.add(performance.now() - t0);
      }
      return b;
    },
  };
}

/** Derive workers a world uses by default: leave two cores to the page and the simulation, at most four. */
export function defaultVoxelWorkers(): number {
  return Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2));
}
