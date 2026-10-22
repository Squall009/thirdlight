/**
 * GLB inspection steps 2–5: the container header, chunk framing, strict JSON, and the glTF
 * version and extension declarations (every extension object the profile visits is checked
 * here).
 *
 * One step per function over the shared `GlbState`; `inspect.ts` runs them in the
 * profile order and stops at the first that reports.
 */

import { GLB_MAGIC, GLB_VERSION, CHUNK_JSON, CHUNK_BIN, EXTENSION_PLACES, type ExtensionPlace } from './gltf-rules';
import { escapePointer, strictJsonParse } from './json';
import { M2_GLTF_EXTENSION_ALLOWLIST, M2_GLTF_JSON_CHUNK_BYTES } from './limits';
import type { ImportDiagnostic } from './types';
import { isPlainObject, diag, ptr, type GlbState } from './inspect-glb-state';

export function checkContainer(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  if (glb.bytes.length < 12) {
    out.push(
      diag('asset_container_invalid', '', 'source is shorter than the 12-byte GLB header', {
        found: glb.bytes.length,
        expected: 'a complete 12-byte GLB header',
      }),
    );
    return out;
  }
  const dv = new DataView(glb.bytes.buffer, glb.bytes.byteOffset, glb.bytes.byteLength);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  const declared = dv.getUint32(8, true);
  if (magic !== GLB_MAGIC) {
    out.push(
      diag('asset_container_invalid', '', 'GLB magic must be "glTF"', {
        found: `0x${magic.toString(16).padStart(8, '0')}`,
        expected: '0x46546c67 ("glTF")',
      }),
    );
  }
  if (version !== GLB_VERSION) {
    out.push(
      diag('asset_container_invalid', '', 'GLB container version must be 2', {
        found: version,
        expected: '2',
      }),
    );
  }
  if (declared !== glb.bytes.length) {
    out.push(
      diag('asset_container_invalid', '', 'GLB declared length must equal the actual byte length', {
        found: { declared, actual: glb.bytes.length },
        expected: 'declared length === actual byte length',
      }),
    );
  }
  return out.length > 0 ? out : null;
}

export function checkChunks(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const dv = new DataView(glb.bytes.buffer, glb.bytes.byteOffset, glb.bytes.byteLength);
  const len = glb.bytes.length;
  const chunks: { type: number; dataStart: number; length: number }[] = [];
  let off = 12;
  while (off < len) {
    if (off + 8 > len) {
      out.push(
        diag('asset_container_invalid', '', 'chunk header is truncated', {
          found: len - off,
          expected: 'a complete 8-byte chunk header',
        }),
      );
      return out;
    }
    const chunkLength = dv.getUint32(off, true);
    const chunkType = dv.getUint32(off + 4, true);
    if (chunkLength % 4 !== 0) {
      out.push(
        diag('asset_container_invalid', '', 'chunk length must be a multiple of 4', {
          found: chunkLength,
          expected: 'chunk length % 4 === 0',
        }),
      );
      return out;
    }
    if (off + 8 + chunkLength > len) {
      out.push(
        diag('asset_container_invalid', '', 'chunk length overruns the declared container length', {
          found: { chunkLength, remaining: len - off - 8 },
          expected: 'chunk bytes exactly fill the declared container length',
        }),
      );
      return out;
    }
    chunks.push({ type: chunkType, dataStart: off + 8, length: chunkLength });
    off += 8 + chunkLength;
  }
  if (off !== len) {
    out.push(
      diag('asset_container_invalid', '', 'trailing bytes after the last chunk', {
        found: len - off,
        expected: 'no trailing bytes',
      }),
    );
    return out;
  }
  if (chunks.length !== 2) {
    out.push(
      diag('asset_container_invalid', '', 'GLB must carry exactly a JSON chunk and a BIN chunk', {
        found: chunks.length,
        expected: '2 chunks (JSON then BIN)',
      }),
    );
    return out;
  }
  const json = chunks[0] as { type: number; dataStart: number; length: number };
  const bin = chunks[1] as { type: number; dataStart: number; length: number };
  if (json.type !== CHUNK_JSON) {
    out.push(
      diag('asset_container_invalid', ptr(), 'chunk 0 must be the JSON chunk', {
        found: `0x${json.type.toString(16).padStart(8, '0')}`,
        expected: '0x4e4f534a ("JSON")',
      }),
    );
  }
  if (bin.type !== CHUNK_BIN) {
    out.push(
      diag('asset_container_invalid', ptr(), 'chunk 1 must be the BIN chunk', {
        found: `0x${bin.type.toString(16).padStart(8, '0')}`,
        expected: '0x004e4942 ("BIN\\0")',
      }),
    );
  }
  if (out.length > 0) return out;
  glb.jsonChunk = glb.bytes.subarray(json.dataStart, json.dataStart + json.length);
  glb.bin = glb.bytes.subarray(bin.dataStart, bin.dataStart + bin.length);
  return null;
}

export function checkJson(glb: GlbState): ImportDiagnostic[] | null {
  if (glb.jsonChunk.length > M2_GLTF_JSON_CHUNK_BYTES) {
    return [
      diag('asset_json_invalid', '', 'the JSON chunk exceeds the profile cap', {
        found: glb.jsonChunk.length,
        expected: `<= ${M2_GLTF_JSON_CHUNK_BYTES} bytes`,
        limit: 'json_chunk_bytes',
      }),
    ];
  }
  const parsed = strictJsonParse(glb.jsonChunk);
  if (!parsed.ok) {
    const reason: Record<typeof parsed.reason, string> = {
      bom: 'the JSON chunk must not start with a byte-order mark',
      encoding: 'the JSON chunk is not valid UTF-8',
      syntax: 'the JSON chunk is not strict RFC 8259 JSON',
      duplicate: 'the JSON chunk repeats an object member name',
    };
    return [
      diag('asset_json_invalid', parsed.path, reason[parsed.reason], {
        expected: 'strict UTF-8 JSON with unique keys and an object root',
      }),
    ];
  }
  if (!isPlainObject(parsed.value)) {
    return [
      diag('asset_json_invalid', '', 'the glTF JSON root must be an object', {
        found: Array.isArray(parsed.value) ? 'array' : typeof parsed.value,
        expected: 'object',
      }),
    ];
  }
  glb.json = parsed.value;
  return null;
}

export function checkVersionAndExtensions(glb: GlbState): ImportDiagnostic[] | null {
  const out: ImportDiagnostic[] = [];
  const asset = glb.json['asset'];
  if (!isPlainObject(asset)) {
    out.push(
      diag('asset_version_unsupported', ptr('asset'), 'glTF requires an asset object', {
        found: asset === undefined ? 'absent' : typeof asset,
        expected: 'an object with version "2.0"',
      }),
    );
    return out;
  }
  if (asset['version'] !== '2.0') {
    out.push(
      diag('asset_version_unsupported', ptr('asset', 'version'), 'only glTF 2.0 is in the M2 profile', {
        found: asset['version'],
        expected: '"2.0"',
      }),
    );
  }

  const used = glb.json['extensionsUsed'];
  const required = glb.json['extensionsRequired'];
  const usedList: string[] = [];
  if (used !== undefined) {
    if (!Array.isArray(used) || used.some((e) => typeof e !== 'string')) {
      out.push(
        diag('asset_extension_unsupported', ptr('extensionsUsed'), 'extensionsUsed must be an array of strings', {
          found: used,
          expected: 'an array of extension names',
        }),
      );
    } else {
      for (const e of used as string[]) usedList.push(e);
    }
  }
  const requiredList: string[] = [];
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((e) => typeof e !== 'string')) {
      out.push(
        diag('asset_extension_unsupported', ptr('extensionsRequired'), 'extensionsRequired must be an array of strings', {
          found: required,
          expected: 'an array of extension names',
        }),
      );
    } else {
      for (const e of required as string[]) requiredList.push(e);
    }
  }

  if (out.length > 0) return out;

  for (const name of usedList) {
    if (!M2_GLTF_EXTENSION_ALLOWLIST.includes(name)) {
      out.push(
        diag(
          'asset_extension_unsupported',
          ptr('extensionsUsed'),
          `extension "${name}" in extensionsUsed is outside the effective allowlist`,
          { found: name, expected: `one of [${M2_GLTF_EXTENSION_ALLOWLIST.join(', ')}]` },
        ),
      );
    }
  }
  for (const name of requiredList) {
    if (!M2_GLTF_EXTENSION_ALLOWLIST.includes(name)) {
      out.push(
        diag(
          'asset_extension_unsupported',
          ptr('extensionsRequired'),
          `required extension "${name}" is outside the effective allowlist`,
          { found: name, expected: `one of [${M2_GLTF_EXTENSION_ALLOWLIST.join(', ')}]` },
        ),
      );
    } else if (!usedList.includes(name)) {
      out.push(
        diag(
          'asset_extension_unsupported',
          ptr('extensionsRequired'),
          `required extension "${name}" must be declared in extensionsUsed`,
          { found: name, expected: 'an allowlisted, declared extension' },
        ),
      );
    }
  }
  glb.declaredExtensions = new Set(usedList);
  checkExtensionObject(glb, glb.json, '', out, 'root');
  return out.length > 0 ? out : null;
}

/**
 * "Extensions are never silently ignored, because ignoring one
 * changes what the file means." Every `extensions` member the profile visits
 * must therefore be empty or allowlisted.
 */
export function checkExtensionObject(
  glb: GlbState,
  owner: Record<string, unknown>,
  path: string,
  out: ImportDiagnostic[],
  place: ExtensionPlace,
): void {
  const ext = owner['extensions'];
  if (ext === undefined) return;
  if (!isPlainObject(ext)) {
    out.push(
      diag('asset_extension_unsupported', `${path}/extensions`, 'extensions must be an object', {
        found: ext,
        expected: 'an object of allowlisted extensions',
      }),
    );
    return;
  }
  for (const name of Object.keys(ext)) {
    const epath = `${path}/extensions/${escapePointer(name)}`;
    if (!M2_GLTF_EXTENSION_ALLOWLIST.includes(name)) {
      out.push(
        diag(
          'asset_extension_unsupported',
          epath,
          `extension "${name}" is outside the effective allowlist`,
          { found: name, expected: `one of [${M2_GLTF_EXTENSION_ALLOWLIST.join(', ')}]` },
        ),
      );
      continue;
    }
    if (!(EXTENSION_PLACES[name] ?? []).includes(place)) {
      out.push(
        diag('asset_extension_unsupported', epath, `extension "${name}" is not supported on a ${place}`, {
          found: name,
          expected: `on ${(EXTENSION_PLACES[name] ?? []).join(' | ') || 'no object (a declaration only)'}`,
        }),
      );
      continue;
    }
    if (!glb.declaredExtensions.has(name)) {
      out.push(
        diag('asset_extension_unsupported', epath, `extension "${name}" is used but not declared in extensionsUsed`, {
          found: name,
          expected: 'every used extension listed in extensionsUsed',
        }),
      );
      continue;
    }
    if (!isPlainObject(ext[name])) {
      out.push(
        diag('asset_extension_unsupported', epath, `extension "${name}" must be an object`, {
          found: typeof ext[name],
          expected: 'an object',
        }),
      );
    }
  }
}
