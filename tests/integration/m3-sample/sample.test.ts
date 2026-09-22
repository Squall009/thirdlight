/**
 * Packet 61 — Beacon Reach sample integrity tests (Node):
 *
 *   1. ASSET PROVENANCE — the committed generated assets match their
 *      provenance digests (SHA-256 + byteLength), and the committed WAVs are
 *      the accepted §41.4 PCM container (44-byte RIFF/WAVE header, mono
 *      48 kHz 16-bit, ≤ 2000 ms). Re-running the deterministic generator is
 *      idempotent (the bytes — and therefore the digests — are unchanged).
 *   2. RECIPE REPRODUCIBILITY — replaying the committed command recipe
 *      (`recipe/commands.json`) through the same `applyMutation` the browser
 *      and MCP use, over the same fresh v3 baseline, yields the EXACT captured
 *      scene + content (identical sceneDigest + contentDigest).
 *   3. NO HARDCODED RUNTIME IDs — every command-authored entity ID is in the
 *      auto-generated `<kind>-<NNNN>` form (the sole authored name is the
 *      baseline camera), and every content reference (checkpoint safeSpawnId,
 *      the game config's playerId/cameraId/spawnId) resolves to a real entity.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyMutation, createCommandState } from '@thirdlight/commands';
import type { SceneV3 } from '@thirdlight/project-model';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(HERE, '..', '..', '..', 'samples', 'beacon-reach');
const ASSETS = join(SAMPLE, 'assets');
const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface Provenance {
  assets: Array<{ id: string; kind: string; path: string; sourceDigest: string; sourceByteLength: number }>;
}
interface Captured {
  scene: { revision: number; entities: Array<{ id: string; components: Record<string, { position?: number[]; gameZone?: { role?: string; safeSpawnId?: string } }> }> };
  content: { game: Record<string, unknown>; assets: Array<{ assetId: string; kind: string }> };
}

const provenance = JSON.parse(new TextDecoder().decode(readFileSync(join(ASSETS, 'provenance.json')))) as Provenance;
const captured = JSON.parse(new TextDecoder().decode(readFileSync(join(SAMPLE, 'captured', 'project.json')))) as Captured;
const recipe = JSON.parse(new TextDecoder().decode(readFileSync(join(SAMPLE, 'recipe', 'commands.json')))) as { projectId: string; commands: Array<{ op: string; args: Record<string, unknown> }> };

// The fresh v3 baseline (the workspace's NEW v3 project — the single default
// camera the v3 scene validator requires), identical to the capture runner.
const CAMERA_ENTITY = {
  id: 'br-cam-main',
  name: 'Gameplay camera',
  components: {
    transform: { position: [0, 4, 12], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    camera: { type: 'perspective', fovY: 45, near: 0.1, far: 100 },
    cameraFollow: { deadZone: { x: 0.5, y: 0.5 }, smoothing: 0.2, bounds: { minX: 0, maxX: 48, minY: 0, maxY: 8 } },
  },
};
const FRESH_SCENE = { schemaVersion: 3, sceneId: 'scene-main', revision: 0, entities: [CAMERA_ENTITY] } as unknown as SceneV3;
const FRESH_CONTENT = { assets: [], prefabs: [], behaviors: [], settings: {}, behaviorTrust: { entries: [] }, game: null };

function wavHeaderInfo(bytes: Uint8Array): { ok: boolean; channels: number; sampleRate: number; bitsPerSample: number; frames: number; durationMs: number } {
  if (bytes.length < 44) return { ok: false, channels: 0, sampleRate: 0, bitsPerSample: 0, frames: 0, durationMs: 0 };
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46; // "RIFF"
  const wave = bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45; // "WAVE"
  const fmt = bytes[12] === 0x66 && bytes[13] === 0x6d && bytes[14] === 0x74 && bytes[15] === 0x20; // "fmt "
  const fmtLen = v.getUint32(16, true);
  const audioFormat = v.getUint16(20, true); // 1 = PCM
  const channels = v.getUint16(22, true);
  const sampleRate = v.getUint32(24, true);
  const bitsPerSample = v.getUint16(34, true);
  const dataIdx = 20 + fmtLen; // offset of the "data" chunk id (the fmt chunk's payload starts at 20)
  const dataOk = bytes[dataIdx] === 0x64 && bytes[dataIdx + 1] === 0x61 && bytes[dataIdx + 2] === 0x74 && bytes[dataIdx + 3] === 0x61; // "data"
  const dataBytes = v.getUint32(dataIdx + 4, true);
  const frames = audioFormat === 1 && bitsPerSample === 16 ? dataBytes / 2 : 0;
  const durationMs = sampleRate > 0 ? (frames / sampleRate) * 1000 : 0;
  return { ok: riff && wave && fmt && audioFormat === 1 && fmtLen === 16 && dataOk, channels, sampleRate, bitsPerSample, frames, durationMs };
}

describe('Beacon Reach sample integrity (packet 61)', () => {
  it('1: the committed assets match their provenance digests and the WAVs are the accepted §41.4 PCM container', () => {
    expect(provenance.assets).toHaveLength(7);
    for (const a of provenance.assets) {
      const bytes = new Uint8Array(readFileSync(join(ASSETS, a.path)));
      expect(bytes.length, `${a.path} byteLength`).toBe(a.sourceByteLength);
      expect(sha256Hex(bytes), `${a.path} sourceDigest`).toBe(a.sourceDigest);
      if (a.kind === 'audio') {
        const h = wavHeaderInfo(bytes);
        expect(h.ok, `${a.path} is RIFF/WAVE PCM`).toBe(true);
        expect(h.channels).toBe(1); // mono
        expect(h.sampleRate).toBe(48_000);
        expect(h.bitsPerSample).toBe(16);
        expect(h.durationMs).toBeLessThanOrEqual(2000); // ≤ 2000 ms
        expect(h.frames).toBeGreaterThan(0);
      }
    }
  });

  it('2: re-running the deterministic generator is idempotent (the digests are unchanged)', () => {
    const before = provenance.assets.map((a) => ({ path: a.path, digest: sha256Hex(new Uint8Array(readFileSync(join(ASSETS, a.path)))) }));
    execFileSync(process.execPath, [join(SAMPLE, 'tools', 'generate-assets.mjs')], { stdio: 'ignore' });
    for (const b of before) {
      const after = sha256Hex(new Uint8Array(readFileSync(join(ASSETS, b.path))));
      expect(after, `${b.path} unchanged by regeneration`).toBe(b.digest);
    }
  }, 60_000);

  it('3: replaying the command recipe reproduces the captured scene + content digests exactly', () => {
    let state = createCommandState(FRESH_SCENE, FRESH_CONTENT as never);
    let counter = 0;
    for (const cmd of recipe.commands) {
      counter += 1;
      const revision = (state.scene as unknown as { revision: number }).revision;
      const outcome = applyMutation(state, {
        op: cmd.op,
        projectId: recipe.projectId,
        expectedRevision: revision,
        requestId: `req-${counter.toString(16).padStart(32, '0')}`,
        args: cmd.args,
      });
      if (!outcome.ok) throw new Error(`recipe replay FAILED at ${cmd.op} (revision ${revision}): ${JSON.stringify(outcome.result)}`);
      state = outcome.state;
    }
    const sceneDigest = sha256Hex(new TextEncoder().encode(JSON.stringify(state.scene) + '\n'));
    const contentDigest = sha256Hex(new TextEncoder().encode(JSON.stringify((state as unknown as { content: unknown }).content) + '\n'));
    const expectedScene = sha256Hex(new TextEncoder().encode(JSON.stringify(captured.scene) + '\n'));
    const expectedContent = sha256Hex(new TextEncoder().encode(JSON.stringify(captured.content) + '\n'));
    expect(sceneDigest, 'scene digest').toBe(expectedScene);
    expect(contentDigest, 'content digest').toBe(expectedContent);
    // The replayed entity set matches the captured project's (same count + IDs).
    const replayIds = (state.scene as unknown as { entities: Array<{ id: string }> }).entities.map((e) => e.id).sort();
    const capturedIds = captured.scene.entities.map((e) => e.id).sort();
    expect(replayIds).toEqual(capturedIds);
  });

  it('4: no hardcoded runtime IDs — command-authored entities are auto-generated, and every content reference resolves', () => {
    const entityIds = new Set(captured.scene.entities.map((e) => e.id));
    // Every entity except the baseline camera is in the generated form.
    for (const e of captured.scene.entities) {
      if (e.id === 'br-cam-main') continue; // the authored baseline camera
      expect(e.id, `${e.id} is auto-generated`).toMatch(/^[a-z]+-\d{4}$/);
    }
    // The checkpoint zone's safeSpawnId resolves to a real playerSpawn entity.
    for (const e of captured.scene.entities) {
      const zone = e.components.gameZone;
      if (zone?.role === 'checkpoint') {
        expect(zone.safeSpawnId, 'checkpoint safeSpawnId present').toBeTruthy();
        expect(entityIds.has(zone.safeSpawnId!), `safeSpawnId ${zone.safeSpawnId} resolves`).toBe(true);
        const spawn = captured.scene.entities.find((x) => x.id === zone.safeSpawnId);
        expect(spawn?.components.playerSpawn, 'safeSpawnId is a playerSpawn entity').toBeTruthy();
      }
    }
    // The game config's references resolve to real entities.
    const g = captured.content.game as { playerId: string; cameraId: string; spawnId: string };
    expect(entityIds.has(g.playerId), `playerId ${g.playerId} resolves`).toBe(true);
    expect(entityIds.has(g.cameraId), `cameraId ${g.cameraId} resolves`).toBe(true);
    expect(entityIds.has(g.spawnId), `spawnId ${g.spawnId} resolves`).toBe(true);
    // The player has a controller; the spawns have playerSpawn; the camera has camera.
    const player = captured.scene.entities.find((x) => x.id === g.playerId);
    expect(player?.components.controller, 'playerId is a controller entity').toBeTruthy();
    const spawn = captured.scene.entities.find((x) => x.id === g.spawnId);
    expect(spawn?.components.playerSpawn, 'spawnId is a playerSpawn entity').toBeTruthy();
    const cam = captured.scene.entities.find((x) => x.id === g.cameraId);
    expect(cam?.components.camera, 'cameraId is a camera entity').toBeTruthy();
    // Every cue the game references (when non-null) is a published asset.
    const assetIds = new Set(captured.content.assets.map((a) => a.assetId));
    const cues = (g as { cues?: Record<string, string | null> }).cues ?? {};
    for (const [k, v] of Object.entries(cues)) {
      if (v !== null) expect(assetIds.has(v), `cue ${k} → ${v} is a published asset`).toBe(true);
    }
  });
});