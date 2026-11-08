/**
 * three's Basis Universal transcoder in Node, for tests that check what a
 * page would draw of a KTX2: the classic script next to three's KTX2Loader,
 * run with Node's require, its BASIS factory given the WASM binary. Every
 * level and layer is transcoded to RGBA8 as the KTX2Loader reads a file.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

interface BasisFile {
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  getLayers(): number;
  startTranscoding(): boolean;
  getImageTranscodedSizeInBytes(l: number, layer: number, f: number, fmt: number): number;
  transcodeImage(dst: Uint8Array, l: number, layer: number, f: number, fmt: number, a: number, b: number, c: number): boolean;
  close(): void;
  delete(): void;
}
let basis: Promise<{ KTX2File: new (b: Uint8Array) => BasisFile }> | null = null;

/** three's transcoder module, loaded once. */
function transcoder(): Promise<{ KTX2File: new (b: Uint8Array) => BasisFile }> {
  basis ??= (async () => {
    const dir = join(process.cwd(), 'node_modules', 'three', 'examples', 'jsm', 'libs', 'basis');
    const factory = new Function('require', '__filename', '__dirname', `${readFileSync(join(dir, 'basis_transcoder.js'), 'utf8')}\n;return BASIS;`) as (r: NodeJS.Require, f: string, d: string) => (m: { wasmBinary: Uint8Array }) => Promise<{ initializeBasis(): void; KTX2File: new (b: Uint8Array) => BasisFile }>;
    const mod = await factory(createRequire(import.meta.url), join(dir, 'basis_transcoder.js'), dir)({ wasmBinary: new Uint8Array(readFileSync(join(dir, 'basis_transcoder.wasm'))) });
    mod.initializeBasis();
    return mod;
  })();
  return basis;
}

/** One transcoded mip level: its size and every layer's RGBA8 one after another. */
export interface TranscodedLevel {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** A KTX2's every level (level 0 first) and its layer count, transcoded to RGBA8 by three's transcoder (throws when it refuses). */
export async function transcodeKtx2Levels(bytes: Uint8Array): Promise<{ levels: TranscodedLevel[]; layers: number; width: number; height: number }> {
  const mod = await transcoder();
  const f = new mod.KTX2File(bytes);
  try {
    if (!f.startTranscoding()) throw new Error('three\'s transcoder refused the KTX2');
    const layers = Math.max(1, f.getLayers());
    const levels: TranscodedLevel[] = [];
    for (let l = 0; l < f.getLevels(); l++) {
      const parts: Uint8Array[] = [];
      for (let layer = 0; layer < layers; layer++) {
        // 13: cTFRGBA32.
        const dst = new Uint8Array(f.getImageTranscodedSizeInBytes(l, layer, 0, 13));
        if (!f.transcodeImage(dst, l, layer, 0, 13, 0, -1, -1)) throw new Error(`three's transcoder could not decode level ${l} layer ${layer}`);
        parts.push(dst);
      }
      const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      parts.reduce((at, p) => (data.set(p, at), at + p.length), 0);
      levels.push({ data, width: Math.max(1, f.getWidth() >> l), height: Math.max(1, f.getHeight() >> l) });
    }
    return { levels, layers, width: f.getWidth(), height: f.getHeight() };
  } finally {
    f.close();
    f.delete();
  }
}
