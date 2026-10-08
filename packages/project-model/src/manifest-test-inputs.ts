/**
 * Small synthetic capture inputs the manifest tests share (v4 and v5): a
 * settings block, a media identity, one model asset, and one value for every
 * optional block (a block added to the manifest must be added here).
 */
import { mediaProfileDigest } from './manifest-v2';

// A small synthetic settings block in registry order (all defaults).
export const SETTINGS = {
  gravity_y: -19.62,
  run_speed: 4,
  jump_velocity: 7,
  max_fall_speed: -30,
  max_slope_climb_deg: 45,
  min_slope_slide_deg: 30,
} as const;

// A minimal media identity (only animation rows; one row).
export const ROLES = {
  idle: { clipIndex: 0, clipName: 'Idle' },
  run: { clipIndex: 1, clipName: 'Run' },
  airborne: { clipIndex: 2, clipName: 'Air' },
};
export const MEDIA = {
  animation: [
    {
      entityId: 'p-1',
      assetId: 'asset-1',
      version: 1,
      profileDigest: mediaProfileDigest(ROLES),
      roles: ROLES,
    },
  ],
};

export const ASSETS = [
  {
    assetId: 'asset-1',
    kind: 'model' as const,
    version: 1,
    sourceDigest: 'a'.repeat(64),
    sourceByteLength: 47,
    recipe: { id: 'gltf-glb', version: 1 },
    metricsDigest: 'b'.repeat(64),
  },
];

export const DIGEST = 'c'.repeat(64);

export function v2Input(over: Record<string, unknown> = {}) {
  return {
    projectId: 'demo-0001',
    revision: 12,
    capturedAt: '2026-09-19T10:00:00Z',
    sceneDigest: DIGEST,
    contentDigest: DIGEST,
    assets: ASSETS,
    behaviors: [],
    settings: SETTINGS,
    media: MEDIA,
    moduleIds: ['thirdlight.physics-rapier:3d', 'thirdlight.character:controller'],
    ...over,
  };
}

export function everyOptionalKey(): Record<string, unknown> {
  return {
    tags: [{ bit: 3, name: 'walker' }],
    loadable: [{ kind: 'audio', id: 'asset-2', address: 'voice/line-1', labels: ['voice'] }, { kind: 'prefab', id: 'pf-a', labels: ['spawnable'] }],
    materials: [{ materialId: 'mat-a', name: 'A', shader: 'standard', params: {}, textures: {} }],
    materialFunctions: [{ graphId: 'fn-a', kind: 'material-function', name: 'Fn', graph: { nodes: [], edges: [] } }],
    effects: [{ effectId: 'fx-a', name: 'Fx', duration: 1, loop: false, seed: 1, bounds: { center: [0, 0, 0], size: [1, 1, 1] }, systems: [{ systemId: 'sys-a', name: 'Sys', maxParticles: 8, space: 'world', graph: { nodes: ['spawn', 'initialize', 'update', 'output'].map((c, i) => ({ id: c, type: c, position: [0, i * 200] })), edges: [] } }] }],
    environment: { sky: { mode: 'color', color: '#7ec8ff' } },
    lighting: { 'scene-a': { bakeId: 'bake-a', createdAt: '2026-09-19T10:00:00Z', source: 'browser', range: 1, texelsPerMeter: 4, samples: 16, bounces: 1, atlases: ['tex-a'], entries: [], bakedLights: [], lightsHash: '0'.repeat(16), staticsHash: '1'.repeat(16) } },
    animators: [{ controllerId: 'anim-a', name: 'Anim', parameters: [], states: [{ id: 'idle', name: 'Idle', motion: { kind: 'clip', clip: { assetId: 'asset-1', clip: 'Idle', duration: 1 } }, speed: 1, loop: true }], transitions: [], entry: 'idle', events: [] }],
    rigs: { 'asset-1': { nodes: [{ name: 'root', parent: -1, t: [0, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }], clips: [] } },
    modelColliders: { 'asset-1': { '': [[[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]] } },
    prefabs: [{ prefabId: 'pf-a', displayName: 'Pf', createdRevision: 1, entityCount: 1, depth: 1, entities: [{ localId: 'root', name: 'Root', parentLocalId: null, components: { transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } }] }],
    blockTypes: [{ blockId: 'bt-a', name: 'Bt', shape: 'full', variants: [{ color: '#808080' }] }],
    cellFields: [{ key: 'depth', type: 'int' }],
    input: { actions: [{ name: 'use', type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyE' }] }] },
    collisionLayers: ['world'],
    saveSchema: { version: 1, slots: 1 },
    uiThemes: [{ uiThemeId: 'theme-a', name: 'Theme', styles: {} }],
    uiDocuments: [{ uiDocumentId: 'hud', name: 'HUD', root: { type: 'text', text: 'hi' } }],
    dialogue: { dialogues: [], speakers: [], settings: {}, document: 'dialogue' },
    modes: [{ modeId: 'main', name: 'Main' }],
    timelines: [{ timelineId: 'tl-a', name: 'Tl', duration: 1, tracks: [] }],
    eventCues: [{ on: 'signal', name: 'tick', assetId: 'asset-1' }],
    shell: { hud: ['hud'] },
    architectureStyles: [{ graphId: 'arch-p', kind: 'architecture-preset', name: 'P', graph: { nodes: [{ id: 'preset', type: 'preset', position: [0, 0], data: { style: '', base: 'starter-room', sheet: '' } }], edges: [] } }],
    scenes: [{ sceneId: 'scene-a', path: 'scenes/scene-a.json', digest: 'e'.repeat(64), byteLength: 10, start: true }],
    buffers: [{ digest: 'f'.repeat(64), byteLength: 48 }],
    // The shared script library modules.
    libraries: [{ libraryId: 'lib-a', sourceDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64), outputByteLength: 12 }],
  };
}

