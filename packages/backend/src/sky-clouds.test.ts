/**
 * The physical sky's cloud settings through the real backend: a scene's look
 * and a preset set them with `setEnvironment` over HTTP (the one mutation path
 * the editor's Environment window and MCP share), out-of-range values are
 * refused naming the field, a new session reads what was written, and Play
 * carries them to the game page (the look its renderer draws the clouds from).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { SKY_CLOUD_TIME_MAX } from '@thirdlight/project-model/limits';

import { FakeEditor } from './test-editor';
import { api, establish, mkRequestId, mkSessionId, playContentOf, startBackend, upgrade, type TestBackend } from './test-helpers';

type Any = any;
const PID = 'demo-0001';
const CLOUDY = { mode: 'procedural', cloudCoverage: 0.7, cloudDensity: 0.55, cloudTime: 120 };

describe('the sky\'s cloud settings (real backend)', () => {
  let tb: TestBackend;
  const revision = (): number => {
    const r = tb.backend._test.service.readCapturedV3(PID);
    if (!r.ok) throw new Error(r.error.code);
    return r.read.revision;
  };
  const command = (op: string, args: Record<string, unknown>) =>
    api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, expectedRevision: revision(), requestId: mkRequestId(), origin: { kind: 'mcp', clientId: 'sky-clouds-test' }, args }, token: tb.adminToken, origin: null });
  const query = async (op: string, args: Record<string, unknown>): Promise<Any> => (await api(`${tb.authUrl}/api/v1/projects/${PID}/commands`, { body: { op, projectId: PID, args }, token: tb.adminToken, origin: null })).json;

  beforeAll(async () => {
    tb = await startBackend();
  }, 60_000);
  afterAll(async () => {
    await tb?.teardown();
  });

  it('sets, refuses, keeps and plays cloud cover, density and start on a scene look and a preset', async () => {
    const look = { sky: CLOUDY, wind: { direction: [0, 1], strength: 0.4, gust: 0.2, gustFrequency: 0.3, turbulence: 0.2, speed: 12 } };
    const set = await command('setEnvironment', { sceneId: 'scene-main', environment: look });
    expect(set.status, JSON.stringify(set.json).slice(0, 400)).toBe(200);
    // Out of range: refused, naming the field.
    for (const bad of [{ cloudCoverage: 1.5 }, { cloudDensity: -0.1 }, { cloudTime: SKY_CLOUD_TIME_MAX + 1 }, { cloudCoverage: 'lots' }]) {
      const r = await command('setEnvironment', { sceneId: 'scene-main', environment: { sky: { ...CLOUDY, ...bad } } });
      expect(r.status, JSON.stringify(bad)).not.toBe(200);
      expect(JSON.stringify(r.json), JSON.stringify(bad)).toContain(Object.keys(bad)[0]);
    }
    // A clear-sky preset (coverage 0) on the project's part, the one a script blends to through ctx.environment.
    const preset = await command('setEnvironment', { environment: { presets: [{ presetId: 'clear', name: 'Clear', sky: { mode: 'procedural', cloudCoverage: 0, cloudDensity: 0 } }] } });
    expect(preset.status, JSON.stringify(preset.json).slice(0, 400)).toBe(200);
    expect((await command('setEnvironment', { environment: { presets: [{ presetId: 'bad', name: 'Bad', sky: { mode: 'procedural', cloudDensity: 2 } }] } })).status).not.toBe(200);

    // What a new session reads.
    const rows = (await query('queryProject', { environments: true })).scenes as { sceneId: string; environment?: Any }[];
    expect(rows.find((r) => r.sceneId === 'scene-main')?.environment?.sky).toEqual(CLOUDY);
    expect((await query('queryGameConfig', {})).environment.presets).toMatchObject([{ presetId: 'clear', sky: { mode: 'procedural', cloudCoverage: 0, cloudDensity: 0 } }]);

    // Play carries them to the game page.
    const sid = mkSessionId();
    const est = await establish(tb, sid);
    const ws = await upgrade(tb, sid, est.wsToken);
    await ws.waitFor((m) => (m as { type?: string }).type === 'attached');
    const editor = new FakeEditor(ws);
    try {
      const r = await api(`${tb.authUrl}/api/v1/projects/${PID}/play`, { body: {}, token: tb.authToken });
      expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
      const psid = (r.json as { playSessionId: string }).playSessionId;
      await editor.waitForEvent('play.started');
      const content = playContentOf(tb, psid) as Any;
      expect(content.environment.presets).toMatchObject([{ presetId: 'clear', sky: { cloudCoverage: 0, cloudDensity: 0 } }]);
      // The scene's look travels in its scene file (the game page lays it over the project's).
      const row = (content.scenes as { sceneId: string; path: string }[]).find((x) => x.sceneId === 'scene-main')!;
      const file = tb.backend._test.playContent.forPlay(psid)!.artifacts.get(row.path) as { bytes: Uint8Array };
      expect(JSON.parse(new TextDecoder().decode(file.bytes)).environment.sky).toEqual(CLOUDY);
    } finally {
      editor.close();
    }
  }, 120_000);
});
