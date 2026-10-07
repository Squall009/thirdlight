/**
 * The exporter's gzip on Node: a build's block-layer cells ship as
 * gzip-compressed chunk data (exporter `block-chunk-data.ts`), Play's and
 * the export's alike.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

import type { GzipPort } from '@thirdlight/exporter';

export const nodeGzip: GzipPort = {
  gzip: (raw) => new Uint8Array(gzipSync(raw)),
  gunzip: (stored, maxLength) => new Uint8Array(gunzipSync(stored, { maxOutputLength: Math.max(1, maxLength) })),
};
