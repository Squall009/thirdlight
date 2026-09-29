#!/usr/bin/env node
/**
 * Writes tools/perf/fixtures/opus-pool.bin: a pool of real Opus packets the
 * scale bench assembles its voice lines from. No Opus encoder is installed
 * on the build hosts (no ffmpeg, no opusenc), and a JavaScript Opus encoder
 * would be a new pinned dependency for a benchmark; Chromium's WebCodecs
 * `AudioEncoder` is libopus and is already here through Playwright. The pool
 * is checked in so the generator is deterministic and needs no browser: a
 * libopus upgrade in Chromium would otherwise change every voice file's
 * digest.
 *
 * The pool is TONES tones (a partial-rich hum with a slow vibrato and a
 * syllable-like envelope), each encoded as one continuous stream of 20 ms
 * packets at 16 kbit/s mono. A voice file is runs of consecutive packets
 * cut from these streams, so every file decodes as ordinary Opus audio and
 * costs what a real voice line of its length costs to read and decode.
 *
 * Format: "TLOP" magic, u16 version (1), u16 pre-skip (from the encoder's
 * OpusHead), u16 tone count, u16 packets per tone; then per packet a u16
 * length and the bytes (little-endian).
 *
 *   node tools/perf/opus-pool.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

import { browserLaunchEnv } from '../../tests/e2e/browser-env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures', 'opus-pool.bin');
const TONES = 12;
/** 2 s per tone: long enough that runs cut from it rarely repeat. */
const PACKETS_PER_TONE = 100;

const server = createServer((_req, res) => res.end('<!doctype html><title>opus</title>'));
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const browser = await chromium.launch({ env: browserLaunchEnv() });
try {
  const page = await browser.newPage();
  // WebCodecs needs a secure context; 127.0.0.1 is one.
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const pool = await page.evaluate(
    async ({ tones, packets }) => {
      const rate = 48000;
      const out = { preSkip: 0, tones: [] };
      for (let t = 0; t < tones; t++) {
        const n = (packets * rate) / 50;
        const pcm = new Float32Array(n);
        const f0 = 90 + t * 17;
        for (let i = 0; i < n; i++) {
          const s = i / rate;
          const f = f0 * (1 + 0.03 * Math.sin(2 * Math.PI * 5 * s));
          const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * (3 + (t % 4)) * s);
          let v = 0;
          for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * s) / h;
          pcm[i] = 0.25 * env * v;
        }
        const chunks = [];
        let desc = null;
        const enc = new AudioEncoder({
          output: (c, meta) => {
            const b = new Uint8Array(c.byteLength);
            c.copyTo(b);
            chunks.push(Array.from(b));
            if (meta?.decoderConfig?.description !== undefined) desc = new Uint8Array(meta.decoderConfig.description);
          },
          error: (e) => {
            throw e;
          },
        });
        enc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: 16000, opus: { frameDuration: 20000, complexity: 5 } });
        enc.encode(new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: n, numberOfChannels: 1, timestamp: 0, data: pcm }));
        await enc.flush();
        enc.close();
        if (desc !== null && desc.length >= 12) out.preSkip = desc[10] | (desc[11] << 8);
        out.tones.push(chunks.slice(0, packets));
      }
      return out;
    },
    { tones: TONES, packets: PACKETS_PER_TONE },
  );
  const parts = [];
  const head = Buffer.alloc(12);
  head.write('TLOP', 0, 'latin1');
  head.writeUInt16LE(1, 4);
  head.writeUInt16LE(pool.preSkip, 6);
  head.writeUInt16LE(TONES, 8);
  head.writeUInt16LE(PACKETS_PER_TONE, 10);
  parts.push(head);
  for (const tone of pool.tones) {
    if (tone.length !== PACKETS_PER_TONE) throw new Error(`a tone encoded to ${tone.length} packets`);
    for (const p of tone) {
      const len = Buffer.alloc(2);
      len.writeUInt16LE(p.length, 0);
      parts.push(len, Buffer.from(p));
    }
  }
  mkdirSync(dirname(OUT), { recursive: true });
  const bytes = Buffer.concat(parts);
  writeFileSync(OUT, bytes);
  console.log(`opus-pool: ${TONES} tones × ${PACKETS_PER_TONE} packets, pre-skip ${pool.preSkip}, ${bytes.length} bytes → ${OUT}`);
} finally {
  await browser.close();
  server.close();
}
