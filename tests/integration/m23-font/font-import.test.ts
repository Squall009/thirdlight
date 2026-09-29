/**
 * Font assets over the REAL transports — the committed DejaVu Sans
 * ASCII subset (fixtures/fonts, TTF and WOFF2) is uploaded and inspected
 * through the backend content route with kind "font", published through the
 * ordinary `publishAsset` command and listed by `queryAssets`; a PNG under kind
 * "font" is refused and writes nothing. The export's container check accepts
 * the font bytes under the font content type and refuses anything else.
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanAssetContainer } from '@thirdlight/exporter';
import {
  ADMIN_TOKEN,
  AUTH_TOKEN,
  V3_PROJECT,
  cleanupBundles,
  createMcp,
  inspectViaHttp,
  makeRoot,
  mkRequestId,
  publishArgs,
  spawnBackend,
  stopBackend,
  type BackendProcess,
  type DisposableRoot,
  type McpHarness,
} from '../m3-content/harness';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(REPO, 'fixtures', 'fonts', name)));
const TTF = fixture('neutral-sans.ttf');
const WOFF2 = fixture('neutral-sans.woff2');
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0);

describe('export container check for fonts (phase 23.9a)', () => {
  it('accepts TTF and WOFF2 bytes under font/x-font and refuses a PNG or a truncated font', () => {
    expect(scanAssetContainer('font/x-font', TTF)).toEqual({ ok: true });
    expect(scanAssetContainer('font/x-font', WOFF2)).toEqual({ ok: true });
    expect(scanAssetContainer('font/x-font', PNG)).toMatchObject({ ok: false, code: 'font_format' });
    expect(scanAssetContainer('font/x-font', TTF.subarray(0, 40))).toMatchObject({ ok: false, code: 'font_sfnt_directory' });
    expect(scanAssetContainer('font/x-font', WOFF2.subarray(0, WOFF2.length - 4))).toMatchObject({ ok: false, code: 'font_woff_length' });
    // The other kinds keep their own checks (a font is not a texture).
    expect(scanAssetContainer('image/x-texture', TTF).ok).toBe(false);
  });
});

let root: DisposableRoot;
let bp: BackendProcess;
let mcp: McpHarness;

async function currentRevision(): Promise<number> {
  const res = await mcp.call('tl_inspect', { target: 'project' });
  expect(res.body.ok).toBe(true);
  return Number(res.body.revision);
}

beforeAll(async () => {
  root = makeRoot('font');
  bp = await spawnBackend(root, [
    { token: AUTH_TOKEN, scope: `authoring:${V3_PROJECT}` },
    { token: ADMIN_TOKEN, scope: 'admin' },
  ]);
  mcp = await createMcp(bp.origin);
}, 90_000);

afterAll(async () => {
  cleanupBundles();
  await mcp?.close();
  if (bp) await stopBackend(bp);
  if (root) rmSync(root.root, { recursive: true, force: true });
}, 60_000);

describe('font import through the real content route (phase 23.9a)', () => {
  it('inspects and publishes the TTF and the WOFF2 with kind "font"', async () => {
    for (const [bytes, id, format] of [[TTF, 'font-neutral-ttf', 'ttf'], [WOFF2, 'font-neutral-woff2', 'woff2']] as const) {
      const inspected = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, bytes, { kind: 'font' });
      expect(inspected.status, JSON.stringify(inspected.body)).toBe(200);
      const proposal = (inspected.body as { proposal: Record<string, unknown> }).proposal;
      expect(proposal.status).toBe('ok');
      expect(proposal.kind).toBe('font');
      expect((proposal.importRecipe as { profile?: string }).profile).toBe('font');
      expect((proposal.metrics as { format?: string }).format).toBe(format);
      if (format === 'ttf') expect((proposal.inspection as { familyName?: string }).familyName).toBe('DejaVu Sans');
      const rev = await currentRevision();
      const published = await mcp.call('tl_command', {
        op: 'publishAsset',
        args: publishArgs('create', id, proposal, { kind: 'font', displayName: `Neutral ${format}` }),
        expectedRevision: rev,
        requestId: mkRequestId(),
      });
      expect(published.isError, JSON.stringify(published.body)).toBe(false);
      expect(published.body.revision).toBe(rev + 1);
    }
    const listed = await mcp.call('tl_content_query', { target: 'assets', limit: 128, offset: 0 });
    expect(listed.isError, JSON.stringify(listed.body)).toBe(false);
    const fonts = (listed.body.assets as Array<{ assetId: string; kind: string }>).filter((a) => a.kind === 'font').map((a) => a.assetId).sort();
    expect(fonts).toEqual(['font-neutral-ttf', 'font-neutral-woff2']);
  });

  it('refuses a PNG under kind "font" and writes nothing', async () => {
    const dir = join(root.v3Dir, 'sources', 'sha256');
    const before = existsSync(dir) ? readdirSync(dir).length : 0;
    const res = await inspectViaHttp(bp.origin, V3_PROJECT, AUTH_TOKEN, PNG, { kind: 'font' });
    expect(res.status).toBe(400);
    const diagnostics = (res.body as { error?: { diagnostics?: Array<{ code?: string }> } }).error?.diagnostics ?? [];
    expect(diagnostics.map((d) => d.code)).toContain('asset_container_invalid');
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(before);
  });

  it('the MCP upload tool takes kind "font"', async () => {
    const res = await mcp.call('tl_content_upload', { dataBase64: Buffer.from(TTF).toString('base64'), kind: 'font' });
    expect(res.isError, JSON.stringify(res.body)).toBe(false);
    expect(((res.body.proposal as Record<string, unknown>).metrics as { format?: string }).format).toBe('ttf');
  });
});
