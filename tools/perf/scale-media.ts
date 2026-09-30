/**
 * The scale bench's media files, deterministic from a seed: Ogg Opus voice
 * lines assembled from the checked-in packet pool (opus-pool.mjs says why a
 * pool), short PCM WAV sounds and small noise PNGs. Every file is distinct
 * bytes, so nothing the engine does per file (hashing, storing, reading,
 * decoding, caching) is hidden by content addressing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makePng } from '../../tests/e2e/png-make';
import { REPO } from './backend';
import { prng } from './generate';

/** Opus always counts 48 kHz samples; one pool packet is 20 ms. */
const OPUS_RATE = 48_000;
const SAMPLES_PER_PACKET = 960;

export interface OpusPool {
  preSkip: number;
  /** tones[t][k]: the k-th packet of tone t's continuous stream. */
  tones: Uint8Array[][];
}

let cachedPool: OpusPool | null = null;

export function loadOpusPool(): OpusPool {
  if (cachedPool !== null) return cachedPool;
  const b = readFileSync(join(REPO, 'tools', 'perf', 'fixtures', 'opus-pool.bin'));
  if (b.toString('latin1', 0, 4) !== 'TLOP' || b.readUInt16LE(4) !== 1) throw new Error('opus-pool.bin: not a version 1 pool (run node tools/perf/opus-pool.mjs)');
  const preSkip = b.readUInt16LE(6);
  const toneCount = b.readUInt16LE(8);
  const perTone = b.readUInt16LE(10);
  let at = 12;
  const tones: Uint8Array[][] = [];
  for (let t = 0; t < toneCount; t++) {
    const packets: Uint8Array[] = [];
    for (let k = 0; k < perTone; k++) {
      const len = b.readUInt16LE(at);
      packets.push(new Uint8Array(b.subarray(at + 2, at + 2 + len)));
      at += 2 + len;
    }
    tones.push(packets);
  }
  cachedPool = { preSkip, tones };
  return cachedPool;
}

// ---- Ogg ---------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) & 0xff) ^ byte]!) >>> 0;
  return crc >>> 0;
}

/** One Ogg page holding whole packets (each under 255 × 255 bytes). */
function oggPage(serial: number, sequence: number, granule: bigint, flags: number, packets: readonly Uint8Array[]): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error('oggPage: too many segments');
  const bodyLen = packets.reduce((a, p) => a + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const v = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0);
  page[4] = 0;
  page[5] = flags;
  v.setBigInt64(6, granule, true);
  v.setUint32(14, serial, true);
  v.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let at = 27 + lacing.length;
  for (const p of packets) {
    page.set(p, at);
    at += p.length;
  }
  v.setUint32(22, oggCrc(page), true);
  return page;
}

/**
 * An Ogg Opus file of about `durationMs` (whole 20 ms packets), mono: runs
 * of consecutive pool packets picked by the seed, tagged with `title`.
 */
export function opusVoice(seed: number, durationMs: number, title: string): Buffer {
  const pool = loadOpusPool();
  const rnd = prng(seed);
  const count = Math.max(1, Math.round(durationMs / 20));
  const packets: Uint8Array[] = [];
  while (packets.length < count) {
    const tone = pool.tones[Math.floor(rnd() * pool.tones.length)]!;
    let k = Math.floor(rnd() * tone.length);
    const run = 10 + Math.floor(rnd() * 40);
    for (let i = 0; i < run && packets.length < count; i++) {
      packets.push(tone[k]!);
      k = (k + 1) % tone.length;
    }
  }
  const serial = Math.floor(rnd() * 0xffffffff) >>> 0;
  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set(Buffer.from('OpusHead', 'latin1'), 0);
  head[8] = 1;
  head[9] = 1;
  hv.setUint16(10, pool.preSkip, true);
  hv.setUint32(12, OPUS_RATE, true);
  hv.setInt16(16, 0, true);
  head[18] = 0;
  const vendor = Buffer.from('thirdlight scale bench', 'utf8');
  const comment = Buffer.from(`TITLE=${title}`, 'utf8');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4 + 4 + comment.length);
  tags.write('OpusTags', 0, 'latin1');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(1, 12 + vendor.length);
  tags.writeUInt32LE(comment.length, 16 + vendor.length);
  comment.copy(tags, 20 + vendor.length);
  const pages: Uint8Array[] = [oggPage(serial, 0, 0n, 0x02, [head]), oggPage(serial, 1, 0n, 0x00, [tags])];
  let seq = 2;
  const PER_PAGE = 50;
  for (let i = 0; i < packets.length; i += PER_PAGE) {
    const chunk = packets.slice(i, i + PER_PAGE);
    const last = i + PER_PAGE >= packets.length;
    const granule = BigInt(pool.preSkip + (i + chunk.length) * SAMPLES_PER_PACKET);
    pages.push(oggPage(serial, seq++, granule, last ? 0x04 : 0x00, chunk));
  }
  return Buffer.concat(pages);
}

// ---- WAV and PNG ----------------------------------------------------------------

/** A mono 48 kHz 16-bit PCM WAV of `durationMs`: a decaying tone with seeded pitch and noise. */
export function pcmWav(seed: number, durationMs: number): Buffer {
  const rnd = prng(seed);
  const frames = Math.round((durationMs / 1000) * OPUS_RATE);
  const out = Buffer.alloc(44 + frames * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + frames * 2, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(OPUS_RATE, 24);
  out.writeUInt32LE(OPUS_RATE * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(frames * 2, 40);
  const f = 120 + rnd() * 1800;
  const noise = rnd() * 0.3;
  for (let i = 0; i < frames; i++) {
    const s = i / OPUS_RATE;
    const env = Math.exp((-4 * i) / frames);
    const v = env * (0.6 * Math.sin(2 * Math.PI * f * s) + noise * (rnd() * 2 - 1));
    out.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 20000))), 44 + i * 2);
  }
  return out;
}

/** An RGBA PNG (`size` × `size`): a seeded gradient with noise, so it neither dedupes nor compresses to nothing. */
export function scalePng(seed: number, size: number): Buffer {
  const rnd = prng(seed);
  const base = [rnd() * 255, rnd() * 255, rnd() * 255];
  const slope = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
  let i = 0;
  return makePng(size, size, () => {
    const x = i % size;
    i += 1;
    const n = rnd() * 48 - 24;
    return [0, 1, 2].map((c) => Math.max(0, Math.min(255, Math.round(base[c]! + slope[c]! * x + n)))).concat(255) as [number, number, number, number];
  });
}

/** A checker of 8-texel squares in two colours (a streamed texture: its first levels show squares, its mip tail is flat). */
export function checkerPng(size: number, a: readonly [number, number, number], b: readonly [number, number, number]): Buffer {
  return makePng(size, size, (x, y) => (((x >> 3) + (y >> 3)) % 2 === 0 ? [a[0], a[1], a[2], 255] : [b[0], b[1], b[2], 255]));
}
