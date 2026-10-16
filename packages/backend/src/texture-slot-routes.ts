/**
 * The routes the editor's views draw per-layer texture slots through
 * (`texture-slots.ts` makes the arrays):
 *
 * - `POST …/content/textures/slots` `{ layers, mode, height? }`: the array
 *   of those layers' current versions, assembled once and cached (Play and
 *   the export read the same cache); `preview: true` asks for the array at
 *   a preview size instead, made ahead of the other encodes and never
 *   stored (204: the array itself is made already, ask for it);
 * - `POST …/content/textures/slot-base` with the same body: each layer's
 *   mean colour as JSON, which a view draws the layers in before even the
 *   preview arrives (`final`: the array itself is made already).
 *
 * A layer is a texture asset id (its current version) or a constant layer
 * (`#rrggbbaa`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { ID_RE, MAX_TEXTURE_LAYERS } from '@thirdlight/project-model/limits';
import { parseFillLayer } from '@thirdlight/project-model/texture-slots';
import { sessionError, type SessionError } from '@thirdlight/protocol';
import type { WorkspaceService } from '@thirdlight/workspace';

import { KTX2_MODES, type Ktx2Mode } from './texture-encode';
import type { SlotLayer, TextureSlotAssembler } from './texture-slots';

export interface TextureSlotRouteDeps {
  readonly service: WorkspaceService;
  readonly textureSlots: TextureSlotAssembler | undefined;
  readonly requireAuth: (req: IncomingMessage, projectId: string, adminOnly: boolean) => SessionError | null;
  readonly sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readonly sendError: (res: ServerResponse, error: SessionError, statusOverride?: number) => void;
  /** The request's strict JSON body (null: refused, the answer sent). */
  readonly readJsonBody: (req: IncomingMessage, res: ServerResponse) => Promise<unknown | null>;
}

type Parsed = { layers: SlotLayer[]; mode: Ktx2Mode; height: boolean; preview: boolean; assembler: TextureSlotAssembler };

/** The body's layers (each texture's current version), mode and flags; null when refused (the answer sent). */
async function parse(d: TextureSlotRouteDeps, req: IncomingMessage, res: ServerResponse, projectId: string): Promise<Parsed | null> {
  const auth = d.requireAuth(req, projectId, false);
  if (auth !== null) {
    d.sendError(res, auth);
    return null;
  }
  const body = await d.readJsonBody(req, res);
  if (body === null) return null;
  const refuse = (e: SessionError): null => {
    d.sendError(res, e);
    return null;
  };
  const b = body as { layers?: unknown; mode?: unknown; height?: unknown; preview?: unknown };
  const ids = b.layers;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_TEXTURE_LAYERS || !ids.every((x) => typeof x === 'string' && (ID_RE.test(x) || parseFillLayer(x) !== null))) {
    return refuse(sessionError('field_value', 'validation', `layers lists 1-${MAX_TEXTURE_LAYERS} texture asset ids (or constant layers, #rrggbbaa)`, { path: '/layers' }));
  }
  if (typeof b.mode !== 'string' || !(KTX2_MODES as readonly string[]).includes(b.mode)) return refuse(sessionError('field_value', 'validation', `mode is one of ${KTX2_MODES.join(', ')}`, { path: '/mode' }));
  if (b.height !== undefined && typeof b.height !== 'boolean') return refuse(sessionError('field_value', 'validation', 'height is true or false', { path: '/height' }));
  if (b.preview !== undefined && typeof b.preview !== 'boolean') return refuse(sessionError('field_value', 'validation', 'preview is true or false', { path: '/preview' }));
  const assembler = d.textureSlots;
  if (assembler === undefined) return refuse(sessionError('converter_unavailable', 'unavailable', 'texture slot assembly is not available on this server'));
  const layers: SlotLayer[] = [];
  for (const assetId of ids as string[]) {
    if (parseFillLayer(assetId) !== null) {
      layers.push({ assetId, version: 0, sourceDigest: assetId });
      continue;
    }
    const q = d.service.query({ op: 'queryAssets', projectId, args: { assetId, includeVersions: true, limit: 1, offset: 0 } }) as { ok: boolean; assets?: { kind: string; currentVersion: number; versions?: { version: number; sourceDigest: string }[] }[] };
    const a = q.assets?.[0];
    const v = a?.versions?.find((x) => x.version === a.currentVersion);
    if (!q.ok || a === undefined || a.kind !== 'texture' || v === undefined) return refuse(sessionError('asset_not_found', 'validation', `no texture asset "${assetId}" in this project`, { path: '/layers' }));
    layers.push({ assetId, version: v.version, sourceDigest: v.sourceDigest });
  }
  return { layers, mode: b.mode as Ktx2Mode, height: b.height === true, preview: b.preview === true, assembler };
}

const failure = (d: TextureSlotRouteDeps, res: ServerResponse, made: { code: string; message: string }): void =>
  d.sendError(res, sessionError((made.code === 'converter_unavailable' ? 'converter_unavailable' : 'conversion_failed') as SessionError['code'], made.code === 'converter_unavailable' ? 'unavailable' : 'validation', made.message.slice(0, 256), { path: '/layers' }));

/** `POST …/textures/slots`: the array (`x-thirdlight-derived-height` lists the layers given a brightness height), or its preview. */
export async function slotArrayRoute(d: TextureSlotRouteDeps, req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> {
  const p = await parse(d, req, res, projectId);
  if (p === null) return;
  const options = { height: p.height };
  if (p.preview) {
    const made = p.assembler.preview === undefined ? ({ ok: true, final: true } as const) : await p.assembler.preview(projectId, p.layers, p.mode, options);
    if (!made.ok) return failure(d, res, made);
    if (made.final) {
      res.statusCode = 204;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-length', String(made.ktx2.byteLength));
    res.setHeader('x-thirdlight-preview', '1');
    res.statusCode = 200;
    res.end(Buffer.from(made.ktx2.buffer, made.ktx2.byteOffset, made.ktx2.byteLength));
    return;
  }
  const made = await p.assembler.assemble(projectId, p.layers, p.mode, options);
  if (!made.ok) return failure(d, res, made);
  const opened = d.service.openBlobFile(projectId, made.file);
  if (!opened.ok) return d.sendError(res, sessionError('asset_source_changed', 'conflict', 'the assembled array changed while it was read; ask again'));
  const parts: Uint8Array[] = [];
  try {
    for await (const c of opened.blob.chunks()) parts.push(c);
  } catch {
    return d.sendError(res, sessionError('asset_source_changed', 'conflict', 'the assembled array changed while it was read; ask again'));
  }
  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-length', String(made.file.byteLength));
  res.setHeader('x-thirdlight-digest', made.file.digest);
  res.setHeader('x-thirdlight-derived-height', (made.derivedHeight ?? []).flatMap((x, i) => (x ? [String(i)] : [])).join(','));
  res.statusCode = 200;
  res.end(Buffer.concat(parts));
}

/** `POST …/textures/slot-base`: `{ ok, base: [[r, g, b, a] per layer], final }`. */
export async function slotBaseRoute(d: TextureSlotRouteDeps, req: IncomingMessage, res: ServerResponse, projectId: string): Promise<void> {
  const p = await parse(d, req, res, projectId);
  if (p === null) return;
  if (p.assembler.base === undefined) return d.sendError(res, sessionError('converter_unavailable', 'unavailable', 'texture slot assembly is not available on this server'));
  const made = await p.assembler.base(projectId, p.layers, p.mode, { height: p.height });
  if (!made.ok) return failure(d, res, made);
  d.sendJson(res, 200, { ok: true, base: made.base, final: made.final });
}
