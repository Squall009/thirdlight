/**
 * A scene's block chunk files: one chunk per file,
 * `scenes/<sceneId>.blocks/<entityId>.<cx>.<cz>.json` (JSON text) or
 * `….bin` (binary, zstd-compressed; project-model `block-chunk-binary.ts`).
 *
 * The project setting `block_chunk_storage` picks the form the editor
 * writes; a scene file names the form its chunk files are in
 * (`blockChunkFormat: "binary"`, absent: JSON), so a project whose scenes
 * were written at different times is read as it is. Both forms are read
 * forever: a project never has to be converted to open, and an older
 * project's JSON files stay JSON until it opts in. Every chunk of a scene is
 * written in the same form; a scene written after the setting changed moves
 * its chunks to the new form in the same transaction.
 *
 * Text files diff column by column in version control; binary ones are
 * several times smaller and faster to read but a diff only shows that they
 * changed (the editor's `queryBlocks` reads either).
 */
import { constants as zlibConstants, gunzipSync, zstdCompressSync, zstdDecompressSync } from 'node:zlib';

import { decodeBlockChunks, encodeBlockChunks, readBlockChunkData, wrapBlockChunkData, type BlockChunk, type SceneV4 } from '@thirdlight/project-model';

import { sha256Hex } from './digest';

export type ChunkFileFormat = 'json' | 'binary';

/** zstd's level for chunk files: small files written on every edit, so a fast level (the ratio barely moves above it). */
const CHUNK_ZSTD_LEVEL = 9;

/**
 * The most uncompressed bytes a chunk file may say it holds: far above any
 * real chunk (256 columns of a 256-cell-high layer in single-cell runs, with
 * metadata in every cell, stay under a few MiB), so a damaged or hostile
 * header cannot make a read inflate without bound.
 */
const CHUNK_FILE_MAX_RAW_BYTES = 64 * 1024 * 1024;

const EXT: Readonly<Record<ChunkFileFormat, string>> = { json: 'json', binary: 'bin' };

export const chunkRel = (sceneId: string, entityId: string, cx: number, cz: number, format: ChunkFileFormat = 'json'): string => `scenes/${sceneId}.blocks/${entityId}.${cx}.${cz}.${EXT[format]}`;
export const CHUNK_REL_RE = /^scenes\/[a-z0-9][a-z0-9_-]{0,63}\.blocks\/[a-z0-9][a-z0-9_-]{0,63}\.-?\d{1,4}\.-?\d{1,4}\.(?:json|bin)$/;
/** A leftover temp of a chunk file (write.ts names temps `.<target>.tmp-…`). */
export const CHUNK_TEMP_RE = /^\.[a-z0-9][a-z0-9_-]{0,63}\.-?\d{1,4}\.-?\d{1,4}\.(?:json|bin)\.tmp-/;
/** The directory holding a scene's chunk files. */
export const chunkDirRel = (sceneId: string): string => `scenes/${sceneId}.blocks`;

/** Whether a relative path is a chunk file of `sceneId` (or of any scene). */
export function isChunkRel(rel: string, sceneId?: string): boolean {
  return CHUNK_REL_RE.test(rel) && (sceneId === undefined || rel.startsWith(`${chunkDirRel(sceneId)}/`));
}

/** The scene file's key naming its chunk files' form (absent: JSON). */
export const SCENE_CHUNK_FORMAT_KEY = 'blockChunkFormat';

/** The chunk form a scene file names (anything but "binary": JSON, what every scene file before the key holds). */
export function sceneChunkFormat(sceneFile: Record<string, unknown>): ChunkFileFormat {
  return sceneFile[SCENE_CHUNK_FORMAT_KEY] === 'binary' ? 'binary' : 'json';
}

const chunkBytesCache = new WeakMap<BlockChunk, { key: string; bytes: Uint8Array; hash: string }>();

/**
 * A chunk file's bytes. JSON: the palette one value per line, one column per
 * line (a diff shows the columns that changed). Binary: the chunk's payload,
 * zstd-compressed, behind the blob header.
 */
export function chunkFileBytes(projectId: string, sceneId: string, entityId: string, chunk: BlockChunk, format: ChunkFileFormat = 'json'): { bytes: Uint8Array; hash: string } {
  const key = `${format}|${projectId}|${sceneId}|${entityId}`;
  const hit = chunkBytesCache.get(chunk);
  if (hit !== undefined && hit.key === key) return hit;
  let bytes: Uint8Array;
  if (format === 'binary') {
    const raw = encodeBlockChunks([chunk]);
    bytes = wrapBlockChunkData('zstd', raw.length, new Uint8Array(zstdCompressSync(raw, { params: { [zlibConstants.ZSTD_c_compressionLevel]: CHUNK_ZSTD_LEVEL } })));
  } else {
    const head = [
      `  "storageVersion": 4`,
      `  "type": "block-chunk"`,
      `  "projectId": ${JSON.stringify(projectId)}`,
      `  "sceneId": ${JSON.stringify(sceneId)}`,
      `  "entityId": ${JSON.stringify(entityId)}`,
      `  "cx": ${chunk.cx}`,
      `  "cz": ${chunk.cz}`,
      `  "palette": [\n${chunk.palette.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`,
      `  "columns": [\n${chunk.columns.map((c) => `    ${JSON.stringify(c)}`).join(',\n')}\n  ]`,
      // The chunk's edge pieces (one row per line), when it has some.
      ...(chunk.edges !== undefined && chunk.edgePalette !== undefined
        ? [`  "edgePalette": [\n${chunk.edgePalette.map((e) => `    ${JSON.stringify(e)}`).join(',\n')}\n  ]`, `  "edges": [\n${chunk.edges.map((r) => `    ${JSON.stringify(r)}`).join(',\n')}\n  ]`]
        : []),
      // The chunk's paint (one base64 line), when painted.
      ...(chunk.paint !== undefined ? [`  "paint": ${JSON.stringify(chunk.paint)}`] : []),
      // Its wall paint points (one base64 line), when any is painted.
      ...(chunk.wallPaint !== undefined ? [`  "wallPaint": ${JSON.stringify(chunk.wallPaint)}`] : []),
      // Its scatter rules' copies and hand edits (one base64 line), when it has any.
      ...(chunk.scatter !== undefined ? [`  "scatter": ${JSON.stringify(chunk.scatter)}`] : []),
    ];
    bytes = new TextEncoder().encode(`{\n${head.join(',\n')}\n}\n`);
  }
  const out = { key, bytes, hash: sha256Hex(bytes) };
  chunkBytesCache.set(chunk, out);
  return out;
}

/** Every chunk file of a scene in `format` (relative path → bytes, hash). */
export function sceneChunkFiles(projectId: string, scene: SceneV4, format: ChunkFileFormat): Map<string, { bytes: Uint8Array; hash: string }> {
  const out = new Map<string, { bytes: Uint8Array; hash: string }>();
  for (const b of scene.blocks ?? []) for (const c of b.chunks ?? []) out.set(chunkRel(scene.sceneId, b.entityId, c.cx, c.cz, format), chunkFileBytes(projectId, scene.sceneId, b.entityId, c, format));
  return out;
}

/**
 * The chunk a binary chunk file holds (throws with a message when it is not
 * one chunk in a readable blob). Its uncompressed size is bounded by the
 * header, so a file cannot inflate past what it says.
 */
export function readBinaryChunkFile(bytes: Uint8Array): BlockChunk {
  const { compression, rawLength, stored } = readBlockChunkData(bytes);
  if (rawLength > CHUNK_FILE_MAX_RAW_BYTES) throw new Error(`the header says ${rawLength} bytes of chunk data, more than a chunk file may hold (${CHUNK_FILE_MAX_RAW_BYTES})`);
  const raw =
    compression === 'zstd'
      ? new Uint8Array(zstdDecompressSync(stored, { maxOutputLength: Math.max(1, rawLength) }))
      : compression === 'gzip'
        ? new Uint8Array(gunzipSync(stored, { maxOutputLength: Math.max(1, rawLength) }))
        : stored;
  if (raw.length !== rawLength) throw new Error(`the header says ${rawLength} bytes of chunk data, the file holds ${raw.length}`);
  const chunks = decodeBlockChunks(raw);
  if (chunks.length !== 1) throw new Error(`a chunk file holds one chunk, not ${chunks.length}`);
  return chunks[0]!;
}
