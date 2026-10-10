/**
 * The MCP tool surface (charter). Six categories,
 * exposed as MCP tools and routed into the backend's `/api/v1` command/query/
 * play services via `BackendClient` (never a second mutation engine).
 *
 * - bounded project/entity inspection → `tl_inspect`
 * - command submission                → `tl_command`
 * - session listing                   → `tl_sessions`
 * - play start/stop                   → `tl_play_start`, `tl_play_stop`
 * - bounded diagnostics               → `tl_diagnostics`
 * - screenshot (selected browser)     → `tl_screenshot`
 *
 * Responses carry the relevant revision/session IDs, surface the backend's
 * structured errors (code + message + fields such as `currentRevision`), and
 * are bounded by the backend's own payload limits (queries paged/counts-only,
 * screenshot ≤ 1 MiB, diagnostics ≤ 16 KiB). No general eval/shell tool.
 *
 * Pure Node (no `node:` imports): arg validation is manual; the input schemas
 * are plain JSON Schema objects advertised via `tools/list`.
 */

import { BackendClient, makeRequestId } from './backend-client';
import { playtestBackend, runPlaytest, type PlaytestSpec } from './playtest';
import {
  CONTENT_ASSETS_LIMIT_MAX,
  CONTENT_STAGE_MAX,
  CONTENT_UPLOAD_FRAME_MAX,
  GAME_CONTROL_COMMANDS,
  GAME_OBSERVE_TIMEOUT_MAX_MS,
  GAME_OBSERVE_TIMEOUT_MIN_MS,
  INPUT_RELAY_MAX_BODY_BYTES,
  INPUT_RELAY_MAX_FRAMES,
  INPUT_RELAY_MAX_STEPS,
  INSTANCE_BUFFER_INLINE_MAX,
  RELAY_GAMEPAD_AXES,
  RELAY_GAMEPAD_BUTTONS,
  RELAY_MAX_UI_EDGES,
  RELAY_UI_EDGES,
  SCREENSHOT_MAX_WIDTH_MAX,
  SCREENSHOT_MAX_WIDTH_MIN,
  SIGNAL_DEBUG_COMMAND_NAME,
  parseRelayGamepad,
  parseRelayUiEdges,
  relayFrameEnd,
  V3_MUTATION_OPS,
} from '@thirdlight/protocol';
import {
  INSTANCE_FLOATS,
  SAVE_LIMITS,
} from '@thirdlight/project-model/limits';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { toolDescription } from './tool-docs';

export interface McpContext {
  readonly client: BackendClient;
  readonly projectId: string;
  /** The `origin.clientId` recorded on MCP-submitted commands. */
  readonly clientId: string;
}

export type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** The core scene command ops. */
const M1_MUTATION_OPS = ['createEntity', 'setTransform', 'deleteEntity', 'undo', 'redo'] as const;
/** The content/property/prefab mutation ops. */
const M2_MUTATION_OPS = [
  'publishAsset',
  'publishBehavior',
  'setBehaviorProperties',
  'setComponent',
  'setSettings',
  'acknowledgeBehaviorTrust',
  'createPrefab',
  'instantiatePrefab',
] as const;
/** The v3 game/presentation mutation ops. */
// The v3 op list is the protocol's (one list; a new op reaches MCP with it).
const M3_MUTATION_OPS = V3_MUTATION_OPS;
const MUTATION_OPS = [...M1_MUTATION_OPS, ...M2_MUTATION_OPS, ...M3_MUTATION_OPS] as const;
const QUERY_OPS = ['queryProject', 'queryEntity', 'queryEntities', 'queryAssets', 'queryPrefabs', 'queryBehaviors'] as const;
/**
 * The tool's commands: the relay's closed set plus `signal`, which the tool
 * sends as the engine's `signal` debug command (input of the next step, so a
 * recording replays it).
 */
const TOOL_CONTROL_COMMANDS = [...GAME_CONTROL_COMMANDS, SIGNAL_DEBUG_COMMAND_NAME] as const;

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The advertised tools (plain JSON Schema input schemas — no zod). */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'tl_docs',
    description: toolDescription('tl_docs'),
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'a page ("guides/terrain"), a section ("guides/terrain#sculpting") or a reference topic ("op.editBlocks"); absent: the contents' },
        query: { type: 'string', description: 'words to find in topic names and titles (instead of topic)' },
        part: { type: 'integer', minimum: 1, description: 'the part of a long page or section (the answer\'s next names it)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_inspect',
    description: toolDescription('tl_inspect'),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['project', 'entity', 'entities', 'selection', 'engine'] },
        entityId: { type: 'string' },
        includeSubtree: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 1024 },
        offset: { type: 'integer', minimum: 0 },
        sceneId: { type: 'string', description: 'target="entities": only this scene' },
        environments: { type: 'boolean', description: 'target="project": each scene row carries its look (sky, fog, post, wind) when it has one' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_command',
    description: toolDescription('tl_command'),
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: [...MUTATION_OPS, 'stageScriptLibrary'] },
        args: { type: 'object' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'required for every op but stageScriptLibrary (which changes no revision)' },
        requestId: { type: 'string', pattern: '^req-[0-9a-f]{32}$' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_content_query',
    description: toolDescription('tl_content_query'),
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['assets', 'asset', 'prefabs', 'behaviors', 'integrity', 'game', 'projectFiles', 'blocks', 'materials', 'index', 'terrain', 'surface'] },
        kind: { type: 'string', description: 'target="index": one kind (an asset kind, a resource kind such as prefab or material, or scene)' },
        id: { type: 'string', description: 'target="index": one id' },
        label: { type: 'string', description: 'target="index": only entries with this label' },
        address: { type: 'string', description: 'target="index": the entry with this address' },
        loadable: { type: 'boolean', description: 'target="index": true = only entries with an address or a label (what scripts may load by name); false = only those without' },
        referencing: { type: 'string', description: 'target="index": only the entries that reference this id (what uses it)' },
        text: { type: 'string', description: 'target="index": only the entries whose name, id or file contains this text (any case)' },
        labels: { type: 'array', items: { type: 'string' }, description: 'target="index": only entries with every one of these labels' },
        folder: { type: 'string', description: 'target="index": only entries whose file is in this folder of the game folder ("" its top)' },
        recursive: { type: 'boolean', description: 'target="index": with folder, its subfolders too' },
        folders: { type: 'boolean', description: 'target="index": also list the subfolders of folder (the folder tree)' },
        sort: { type: 'string', enum: ['name', 'kind', 'path'], description: 'target="index": the order (default kind:id)' },
        descending: { type: 'boolean', description: 'target="index": the other way' },
        materialId: { type: 'string', description: 'target="materials": one material' },
        check: { type: 'boolean', description: 'target="integrity": check the game folder first (moved files, changed files imported again)' },
        problems: { type: 'boolean', description: 'target="integrity": only the entries that are not ok (limit and offset page them; total counts them)' },
        withProblems: { type: 'boolean', description: 'target="materials": only materials whose graph has problems' },
        sceneId: { type: 'string', description: 'target="blocks" / "terrain": the scene whose layers or terrains are listed; target="surface": the scene asked (absent: every scene)' },
        entityId: { type: 'string', description: 'target="blocks": one block layer (the entity carrying blockLayer); target="terrain": one terrain' },
        points: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: 'target="terrain": [[x, z], …] world points to read the surface at; target="surface": [[x, z] | [x, y, z], …]' },
        scatter: { type: 'object', description: 'target="terrain" with entityId: {box?: [x0, z0, x1, z1]} — its stored scatter per rule (copies, added, erased), and with a box the copies in it {rule, x, y, z, cell} (cell: the copy\'s address, kept through every bake)' },
        chunks: { type: 'array', items: { type: 'array', items: { type: 'integer' } }, description: 'target="blocks": [[cx, cz], …] chunks to read' },
        box: { type: 'array', items: { type: 'integer' }, description: 'target="blocks": [x0, y0, z0, x1, y1, z1] cells to read' },
        region: { type: 'string', description: 'target="blocks": a region id of the layer' },
        dir: { type: 'string', description: 'target="projectFiles": a folder relative to the game folder ("" = the game folder)' },
        assetId: { type: 'string' },
        prefabId: { type: 'string' },
        behaviorId: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: CONTENT_ASSETS_LIMIT_MAX },
        offset: { type: 'integer', minimum: 0 },
        includeVersions: { type: 'boolean' },
        includeEntities: { type: 'boolean' },
        includeDeclaration: { type: 'boolean' },
        includeTrust: { type: 'boolean', description: 'target="behaviors": also return the acknowledged script sources' },
        includeDescriptors: { type: 'boolean', description: 'target="game": also return the descriptor registry' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_content_upload',
    description: toolDescription('tl_content_upload'),
    inputSchema: {
      type: 'object',
      properties: {
        dataBase64: { type: 'string', description: `base64 of the source bytes (≤ ${CONTENT_STAGE_MAX / 1_048_576} MiB decoded)` },
        writeTo: { type: 'string', description: 'with dataBase64: write the file into the game folder at this path (relative, forward slashes), e.g. assets/voice/line-001.ogg; nothing is inspected or imported' },
        projectPath: {
          type: 'string',
          description: 'a .glb/.fbx/.wav/.ogg/.opus/.mp3/.flac/.png/.jpg/.webp/.ktx2/… file relative to the game folder (the folder holding thirdlight.json), forward slashes, e.g. assets/props/crate.glb',
        },
        displayName: { type: 'string' },
        kind: { type: 'string', enum: ['model', 'audio', 'texture', 'font'], description: 'audio: any Ogg Vorbis/Opus, MP3, WAV or FLAC file of any length' },
        ktx2: {
          type: 'string',
          enum: ['color', 'normal', 'data'],
          description:
            'kind "texture" only: encode a PNG/JPEG/WebP to KTX2 (Basis Universal, with mipmaps) on the server — "color" (ETC1S, sRGB: albedo, emissive), ' +
            '"normal" (UASTC, linear: normal maps) or "data" (UASTC, linear, channels kept apart: masks, heights, packed occlusion/roughness/metalness). The result carries convertedFrom (the original), which the publishAsset args must include.',
        },
        pack: {
          type: 'object',
          description:
            'Pack a KTX2 texture (a texture array with several layers) from texture assets of the project: layers = per layer its [R, G, B, A] sources, each ' +
            '{assetId, channel: "r"|"g"|"b"|"a"} (a PNG/JPEG texture asset, its current version) or {value: 0-255}; all sources one size; at most 12 Mpix across the layers ' +
            '(e.g. 4 layers of 1024²). encoding as ktx2. E.g. terrain: albedo RGB + height in A ("color"), normals ("normal"), occlusion/roughness/metalness ("data").',
          properties: {
            layers: { type: 'array', items: { type: 'array', items: { type: 'object' } } },
            encoding: { type: 'string', enum: ['color', 'normal', 'data'] },
          },
          required: ['layers', 'encoding'],
          additionalProperties: false,
        },
        jobExport: {
          type: 'object',
          description: 'an asset tool\'s job export: {path} a folder or .zip relative to the game folder, or {} with dataBase64 of a zip',
          properties: { path: { type: 'string' } },
          additionalProperties: false,
        },
        animation: {
          type: 'object',
          description: 'request the role-aware animated GLB profile (idle, run and airborne clips named by role)',
          properties: {
            entityId: { type: 'string' },
            roles: { type: 'object' },
          },
          required: ['roles'],
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_content_job',
    description: toolDescription('tl_content_job'),
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', pattern: '^job-[0-9a-f]{32}$' } },
      required: ['jobId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_input_exercise',
    description: toolDescription('tl_input_exercise'),
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        frames: {
          type: 'array',
          minItems: 1,
          maxItems: INPUT_RELAY_MAX_FRAMES,
          items: {
            type: 'object',
            properties: {
              stepOffset: { type: 'integer', minimum: 0, maximum: INPUT_RELAY_MAX_STEPS - 1 },
              steps: { type: 'integer', minimum: 1, maximum: INPUT_RELAY_MAX_STEPS, description: 'the frame holds for this many steps (run length; absent 1)' },
              gamepad: {
                type: 'object',
                description: 'a virtual standard gamepad this frame (absent: at rest)',
                properties: {
                  buttons: { type: 'array', maxItems: RELAY_GAMEPAD_BUTTONS, items: { type: 'number', minimum: 0, maximum: 1 } },
                  axes: { type: 'array', maxItems: RELAY_GAMEPAD_AXES, items: { type: 'number', minimum: -1, maximum: 1 } },
                },
                additionalProperties: false,
              },
              ui: { type: 'array', minItems: 1, maxItems: RELAY_MAX_UI_EDGES, items: { type: 'string', enum: [...RELAY_UI_EDGES] }, description: 'menu edges on the frame\'s first step' },
              actions: {
                type: 'object',
                additionalProperties: {
                  type: 'object',
                  properties: { v: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, p: { type: 'string', enum: ['none', 'pressed', 'held', 'released'] } },
                  required: ['v', 'p'],
                  additionalProperties: false,
                },
              },
              pointer: {
                type: 'object',
                description: 'the pointer this step (a frame without one keeps the last position and held buttons)',
                properties: {
                  x: { type: 'number', minimum: 0, maximum: 1 },
                  y: { type: 'number', minimum: 0, maximum: 1 },
                  dx: { type: 'number', minimum: -10, maximum: 10 },
                  dy: { type: 'number', minimum: -10, maximum: 10 },
                  wheel: { type: 'number', minimum: -10, maximum: 10 },
                  buttons: { type: 'integer', minimum: 0, maximum: 7 },
                  pressed: { type: 'integer', minimum: 0, maximum: 7 },
                  released: { type: 'integer', minimum: 0, maximum: 7 },
                  over: { type: 'boolean' },
                  locked: { type: 'boolean' },
                },
                required: ['x', 'y'],
                additionalProperties: false,
              },
            },
            required: ['stepOffset'],
            additionalProperties: false,
          },
        },
        restart: { type: 'boolean', description: 'restart the game first; the frames begin at the new run\'s first step' },
        hold: { type: 'boolean', description: 'hold the game right after the last step until the next exercise, which then begins at exactly the next step (lockstep)' },
      },
      required: ['playSessionId', 'frames'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_instance_buffer',
    description: toolDescription('tl_instance_buffer'),
    inputSchema: {
      type: 'object',
      properties: {
        transforms: { type: 'array', items: { type: 'number' }, minItems: INSTANCE_FLOATS, maxItems: INSTANCE_BUFFER_INLINE_MAX * INSTANCE_FLOATS },
        digest: { type: 'string', description: 'read this buffer (64 hex) instead of publishing' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_game_control',
    description: toolDescription('tl_game_control'),
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        command: { type: 'string', enum: [...TOOL_CONTROL_COMMANDS], description: 'absent with signal: signal' },
        signal: { type: 'string', description: 'signal: the signal to emit (1-64 characters)' },
        expectedRunId: { type: 'string' },
        sceneId: { type: 'string', description: 'loadScene / unloadScene: the scene' },
        name: { type: 'string', description: 'debugCommand: the debug command a script declared' },
        args: { type: 'object', description: 'debugCommand: its arguments by name (numbers, text up to 256 characters, true/false; at most 8)', additionalProperties: { type: ['number', 'string', 'boolean'] } },
        level: { type: 'string', description: 'setQuality: the quality level id' },
      },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_game_observe',
    description: toolDescription('tl_game_observe'),
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        timeoutMs: { type: 'integer', minimum: GAME_OBSERVE_TIMEOUT_MIN_MS, maximum: GAME_OBSERVE_TIMEOUT_MAX_MS },
        entityId: { type: 'string', description: 'also return this entity\'s running script property values (public and private) as `behaviors`, and with an animator its pose as `animator` {state, clips [{assetId, clip, time (s), weight}], layers?, look? {yaw, pitch (degrees), bones}} and its model\'s bones as drawn as `renderedBones` {name: {position, rotation}}' },
      },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_sessions',
    description: toolDescription('tl_sessions'),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'tl_play_start',
    description: toolDescription('tl_play_start'),
    inputSchema: {
      type: 'object',
      properties: {
        demo: { type: 'boolean' },
        sessionId: { type: 'string', pattern: '^sess-[0-9a-f]{32}$' },
        sceneId: { type: 'string', description: 'start Play at this scene' },
        mode: { type: 'string', description: 'a game mode id (applies once the project has game modes)' },
        variables: { type: 'object', description: 'script variables: what ctx.save holds from step 0' },
        save: { type: 'object', description: 'a project save document (format "thirdlight.save") to continue from' },
        saveSlot: { type: 'string', pattern: '^[1-9][0-9]?$', description: `continue from this project save slot of the Play page (1-${SAVE_LIMITS.slots})` },
        threads: { type: 'string', enum: ['worker', 'single'], description: 'where this play\'s simulation runs (a worker or the page\'s main thread), over the project setting sim_thread' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_play_stop',
    description: toolDescription('tl_play_stop'),
    inputSchema: {
      type: 'object',
      properties: { playSessionId: { type: 'string' } },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_diagnostics',
    description: toolDescription('tl_diagnostics'),
    inputSchema: {
      type: 'object',
      properties: { playSessionId: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_playtest',
    description: toolDescription('tl_playtest'),
    inputSchema: {
      type: 'object',
      properties: {
        sceneId: { type: 'string' },
        mode: { type: 'string' },
        variables: { type: 'object' },
        threads: { type: 'string', enum: ['project', 'worker', 'single', 'both'] },
        runs: { type: 'integer', minimum: 1, maximum: 8 },
        frames: { type: 'array', minItems: 1, maxItems: 20000, items: { type: 'object' } },
        driver: { type: 'string', description: 'not taken here: a driver (the project\'s own Node module) runs from node tools/playtest.mjs <game folder> --driver <file>' },
        observe: {
          type: 'object',
          properties: {
            fields: { type: 'array', maxItems: 32, items: { type: 'string' } },
            atSteps: { type: 'array', maxItems: 64, items: { type: 'integer', minimum: 1 } },
            entityId: { type: 'string' },
          },
          additionalProperties: false,
        },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: 3600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'tl_script_publish',
    description: toolDescription('tl_script_publish'),
    inputSchema: {
      type: 'object',
      properties: {
        behaviorId: { type: 'string', description: 'the script (made by this publish when new)' },
        displayName: { type: 'string', description: 'its name (1-128 characters; required to publish)' },
        files: {
          type: 'array',
          items: { type: 'object', properties: { path: { type: 'string' }, text: { type: 'string' } }, required: ['path', 'text'], additionalProperties: false },
          description: 'the source: src/index.ts and any other .ts or .json files it imports',
        },
        ownedTransforms: { type: 'array', items: { type: 'string' }, description: 'objects whose transform the script may move ("@self": the object it is on)' },
        graph: { type: 'boolean', description: 'true: publish the visual script stored as the behavior\'s graph (no files)' },
        declaration: { type: 'object', description: 'the property declaration, for a source that does not declare its properties in code' },
        check: { type: 'boolean', description: 'true: compile only (diagnostics), publish nothing; no expectedRevision' },
        expectedRevision: { type: 'integer', minimum: 0, description: 'required to publish' },
        requestId: { type: 'string', pattern: '^req-[0-9a-f]{32}$' },
      },
      required: ['behaviorId'],
      additionalProperties: false,
    },
  },
  {
    name: 'tl_screenshot',
    description: toolDescription('tl_screenshot'),
    inputSchema: {
      type: 'object',
      properties: {
        playSessionId: { type: 'string' },
        maxWidth: { type: 'integer', minimum: SCREENSHOT_MAX_WIDTH_MIN, maximum: SCREENSHOT_MAX_WIDTH_MAX },
        ui: { type: 'boolean' },
      },
      required: ['playSessionId'],
      additionalProperties: false,
    },
  },
];

export const MCP_TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((t) => t.name);

/** A structured tool error (surfaced with `isError: true`). */
function toolError(message: string, extra?: Record<string, unknown>): CallToolResult {
  const text = JSON.stringify({ ok: false, error: { code: 'tool_error', message, ...(extra ?? {}) } });
  return { content: [{ type: 'text', text }], isError: true };
}

/** A structured tool success: the backend's body, JSON-encoded (bounded by the backend). */
function toolOk(body: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(body) }] };
}

/** Surface the backend's structured error body as a tool error (keeping code + fields). */
function surfaceBackendError(res: { status: number; body: unknown }): CallToolResult {
  const body = isObj(res.body) ? res.body : { ok: false, error: { code: 'invalid_request', message: 'empty backend response' } };
  return { content: [{ type: 'text', text: JSON.stringify({ ...body, __httpStatus: res.status }) }], isError: true };
}

const MUTATION_SET = new Set<string>(MUTATION_OPS);
const QUERY_SET = new Set<string>(QUERY_OPS);
/** Dispatch one `tools/call` to the backend services. Never throws. */
export async function handleToolCall(
  ctx: McpContext,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const a = isObj(args) ? args : {};
  try {
    switch (name) {
      case 'tl_inspect':
        return await inspect(ctx, a);
      case 'tl_command':
        return await command(ctx, a);
      case 'tl_sessions':
        return await sessions(ctx);
      case 'tl_play_start':
        return await playStart(ctx, a);
      case 'tl_play_stop':
        return await playStop(ctx, a);
      case 'tl_diagnostics':
        return await diagnostics(ctx, a);
      case 'tl_screenshot':
        return await screenshot(ctx, a);
      case 'tl_input_exercise':
        return await inputExercise(ctx, a);
      case 'tl_game_control':
        return await gameControl(ctx, a);
      case 'tl_instance_buffer':
        return await instanceBuffer(ctx, a);
      case 'tl_game_observe':
        return await gameObserve(ctx, a);
      case 'tl_content_query':
        return await contentQuery(ctx, a);
      case 'tl_content_upload':
        return await contentUpload(ctx, a);
      case 'tl_content_job':
        return await contentJob(ctx, a);
      case 'tl_playtest':
        return await playtest(ctx, a);
      case 'tl_docs':
        return await docs(ctx, a);
      case 'tl_script_publish':
        return await scriptPublish(ctx, a);
      default:
        return toolError(`unknown tool "${String(name).slice(0, 64)}"`);
    }
  } catch (err) {
    // Network/abort failures and unexpected throws become a structured error.
    const msg = err instanceof Error ? err.message : String(err);
    const aborted = msg.includes('abort');
    return toolError(aborted ? 'request to the backend timed out or was aborted' : `internal tool error: ${msg.slice(0, 128)}`);
  }
}

async function inspect(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const target = a.target;
  if (target === 'selection') return inspectSelection(ctx);
  if (target === 'engine') {
    // The engine the backend runs.
    const res = await ctx.client.engineInfo();
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target !== 'project' && target !== 'entity' && target !== 'entities') {
    return toolError('target must be "project", "entity", "entities", "selection" or "engine"');
  }
  let op: string;
  let argsOut: Record<string, unknown>;
  if (target === 'project') {
    op = 'queryProject';
    argsOut = {};
    if (a.environments !== undefined) {
      if (typeof a.environments !== 'boolean') return toolError('environments must be a boolean');
      argsOut.environments = a.environments;
    }
  } else if (target === 'entity') {
    op = 'queryEntity';
    if (typeof a.entityId !== 'string' || a.entityId.length === 0) return toolError('entityId is required for target="entity"');
    argsOut = { entityId: a.entityId };
    if (a.includeSubtree !== undefined) {
      if (typeof a.includeSubtree !== 'boolean') return toolError('includeSubtree must be a boolean');
      argsOut.includeSubtree = a.includeSubtree;
    }
  } else {
    op = 'queryEntities';
    argsOut = {};
    if (a.limit !== undefined) {
      if (!isInt(a.limit) || a.limit < 1 || a.limit > 1024) return toolError('limit must be an integer 1–1024');
      argsOut.limit = a.limit;
    }
    if (a.offset !== undefined) {
      if (!isInt(a.offset) || a.offset < 0) return toolError('offset must be an integer ≥ 0');
      argsOut.offset = a.offset;
    }
    if (a.sceneId !== undefined) {
      if (typeof a.sceneId !== 'string' || a.sceneId.length === 0) return toolError('sceneId must be a scene id');
      argsOut.sceneId = a.sceneId;
    }
  }
  const res = await ctx.client.command(ctx.projectId, { op, args: argsOut });
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function command(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const op = a.op;
  // A staged library patch goes to the library stage route (it changes no revision).
  if (op === 'stageScriptLibrary') {
    if (!isObj(a.args)) return toolError('args is required for stageScriptLibrary ({stageId?, libraryId, name?, files?} or {stageId, discard: true})');
    const res = await ctx.client.stageScriptLibrary(ctx.projectId, a.args);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (typeof op !== 'string' || !MUTATION_SET.has(op)) {
    return toolError(`op must be one of ${MUTATION_OPS.join(', ')}`);
  }
  if (!isInt(a.expectedRevision) || a.expectedRevision < 0) {
    return toolError('expectedRevision is required (an integer ≥ 0) for command submission');
  }
  const requestId = typeof a.requestId === 'string' ? a.requestId : makeRequestId();
  const envelope: Record<string, unknown> = {
    op,
    projectId: ctx.projectId,
    expectedRevision: a.expectedRevision,
    requestId,
    origin: { kind: 'mcp', clientId: ctx.clientId },
  };
  if (a.args !== undefined) {
    if (!isObj(a.args)) return toolError('args must be an object');
    envelope.args = a.args;
  } else if (op !== 'undo' && op !== 'redo') {
    // createEntity/setTransform/deleteEntity require args; undo/redo take none.
    return toolError(`args is required for ${op}`);
  }
  const res = await ctx.client.command(ctx.projectId, envelope);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** The manual of the running build (the backend answers within its own bound). */
async function docs(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (a.topic !== undefined && typeof a.topic !== 'string') return toolError('topic must be a string');
  if (a.query !== undefined && typeof a.query !== 'string') return toolError('query must be a string');
  if (a.part !== undefined && (!isInt(a.part) || a.part < 1)) return toolError('part must be an integer ≥ 1');
  const res = await ctx.client.docs({
    ...(typeof a.topic === 'string' ? { topic: a.topic } : {}),
    ...(typeof a.query === 'string' ? { query: a.query } : {}),
    ...(isInt(a.part) ? { part: a.part } : {}),
  });
  if (!isObj(res.body) || res.body.ok !== true) return surfaceBackendError(res);
  // A page's text reads as markdown: send it as its own content item, the rest as JSON beside it.
  const { text, ...meta } = res.body as Record<string, unknown>;
  if (typeof text !== 'string') return toolOk(res.body);
  return { content: [{ type: 'text', text: JSON.stringify(meta) }, { type: 'text', text }] };
}

/**
 * A script's source published (or checked) through the backend's script
 * source route — the editor's Publish — so the trust gate, the compiler and
 * the publishBehavior command are the ones every source goes through.
 */
async function scriptPublish(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.behaviorId !== 'string' || a.behaviorId.length === 0) return toolError('behaviorId is required');
  const graph = a.graph === true;
  if (a.graph !== undefined && typeof a.graph !== 'boolean') return toolError('graph must be a boolean');
  if (graph === (a.files !== undefined)) return toolError('give files (a TypeScript source) or graph: true (a visual script), one of them');
  const body: Record<string, unknown> = { behaviorId: a.behaviorId };
  if (graph) body.graph = true;
  else {
    if (!Array.isArray(a.files)) return toolError('files must be [{path, text}]');
    body.container = { files: a.files, ...(a.ownedTransforms !== undefined ? { ownedTransforms: a.ownedTransforms } : {}) };
  }
  if (a.declaration !== undefined) body.declaration = a.declaration;
  if (a.check === true) {
    body.check = true;
    const res = await ctx.client.behaviorSource(ctx.projectId, body);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (a.check !== undefined && a.check !== false) return toolError('check must be a boolean');
  if (typeof a.displayName !== 'string') return toolError('displayName is required to publish');
  if (!isInt(a.expectedRevision) || a.expectedRevision < 0) return toolError('expectedRevision is required (an integer ≥ 0) to publish');
  body.displayName = a.displayName;
  body.expectedRevision = a.expectedRevision;
  body.requestId = typeof a.requestId === 'string' ? a.requestId : makeRequestId();
  const res = await ctx.client.behaviorSource(ctx.projectId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** The entities selected in the project's connected editor (≤ 64). */
async function inspectSelection(ctx: McpContext): Promise<CallToolResult> {
  const list = await ctx.client.listSessions(ctx.projectId);
  if (!isObj(list.body) || list.body.ok !== true) return surfaceBackendError(list);
  const all = (list.body.sessions as Array<{ sessionId: string; connected: boolean; selection?: string[] }>) ?? [];
  const session = all.find((s) => s.connected);
  if (session === undefined) return toolError('no editor browser is connected for this project (nothing is selected)');
  const entities: unknown[] = [];
  for (const entityId of session.selection ?? []) {
    const res = await ctx.client.command(ctx.projectId, { op: 'queryEntity', args: { entityId } });
    if (isObj(res.body) && res.body.ok === true) entities.push(res.body.entity);
  }
  return toolOk({ ok: true, sessionId: session.sessionId, selection: session.selection ?? [], entities });
}

async function sessions(ctx: McpContext): Promise<CallToolResult> {
  const res = await ctx.client.listSessions(ctx.projectId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function playStart(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  // The play-start body is `{ options: { demo } }` (demo
  // boolean, default true) — `demo` nests under `options`, not at the top level.
  const body: Record<string, unknown> = {};
  const options: Record<string, unknown> = {};
  if (a.demo !== undefined) {
    if (typeof a.demo !== 'boolean') return toolError('demo must be a boolean');
    options.demo = a.demo;
  }
  // The start options and the threading mode go in `options` too (the backend validates and resolves them).
  for (const k of ['sceneId', 'mode', 'variables', 'save', 'saveSlot', 'threads'] as const) if (a[k] !== undefined) options[k] = a[k];
  if (Object.keys(options).length > 0) body.options = options;
  if (a.sessionId !== undefined) {
    if (typeof a.sessionId !== 'string') return toolError('sessionId must be a string');
    body.sessionId = a.sessionId;
  }
  const res = await ctx.client.startPlay(ctx.projectId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function playStop(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  const res = await ctx.client.stopPlay(ctx.projectId, a.playSessionId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function diagnostics(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (a.playSessionId === undefined) {
    const problems = await ctx.client.problems(ctx.projectId);
    if (!isObj(problems.body) || problems.body.ok !== true) return surfaceBackendError(problems);
    const project = await ctx.client.command(ctx.projectId, { op: 'queryProject', args: {} });
    const workspace = isObj(project.body) && project.body.ok === true ? project.body.workspace : null;
    // The graph materials that have problems.
    return toolOk({ ok: true, workspace, total: problems.body.total, problems: problems.body.problems, ...(problems.body.materialProblems !== undefined ? { materialProblems: problems.body.materialProblems } : {}), ...(problems.body.missingFiles !== undefined ? { missingFiles: problems.body.missingFiles } : {}) });
  }
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId must be a non-empty string');
  const res = await ctx.client.diagnostics(ctx.projectId, a.playSessionId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function screenshot(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  let maxWidth: number | undefined;
  if (a.maxWidth !== undefined) {
    if (!isInt(a.maxWidth) || a.maxWidth < SCREENSHOT_MAX_WIDTH_MIN || a.maxWidth > SCREENSHOT_MAX_WIDTH_MAX) return toolError(`maxWidth must be an integer ${SCREENSHOT_MAX_WIDTH_MIN}–${SCREENSHOT_MAX_WIDTH_MAX}`);
    maxWidth = a.maxWidth;
  }
  if (a.ui !== undefined && typeof a.ui !== 'boolean') return toolError('ui must be true or false');
  const res = await ctx.client.screenshot(ctx.projectId, a.playSessionId, maxWidth, a.ui === false ? false : undefined);
  if (!isObj(res.body) || res.body.ok !== true) return surfaceBackendError(res);
  // The PNG goes out as an image block, the only form an agent can look at; as text it is
  // hundreds of KB of base64 that clients cut short and nobody can see.
  const { dataUrl, ...meta } = res.body;
  const m = typeof dataUrl === 'string' ? /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(dataUrl) : null;
  if (m === null) return toolOk(res.body);
  return { content: [{ type: 'text', text: JSON.stringify({ ...meta, image: { mimeType: m[1], base64Bytes: m[2]!.length } }) }, { type: 'image', data: m[2]!, mimeType: m[1]! }] };
}

/** Bounded exclusive-test input relay (semantic actions only). */
async function inputExercise(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  if (!Array.isArray(a.frames) || a.frames.length < 1 || a.frames.length > 600) {
    return toolError(`frames must be an array of 1–${INPUT_RELAY_MAX_FRAMES} entries`);
  }
  const frames: Array<Record<string, unknown>> = [];
  let previous = -1;
  let previousEnd = 0;
  for (let i = 0; i < a.frames.length; i += 1) {
    const raw = a.frames[i];
    if (!isObj(raw)) return toolError(`frames[${i}] must be an object`);
    const { stepOffset, actions } = raw;
    // Frame version 2 has no fixed channels.
    for (const old of ['moveX', 'moveY', 'jump']) {
      if (raw[old] !== undefined) return toolError(`frames[${i}].${old} is not a frame field (input frame version 2): use actions {move: {v}, jump: {v, p}}`);
    }
    if (!isInt(stepOffset) || stepOffset < 0) return toolError(`frames[${i}].stepOffset must be an integer ≥ 0`);
    if (stepOffset <= previous) return toolError('frames must be strictly ascending by stepOffset');
    previous = stepOffset;
    if (actions !== undefined && !isObj(actions)) return toolError(`frames[${i}].actions must be an object`);
    // The pointer too.
    if (raw.pointer !== undefined && !isObj(raw.pointer)) return toolError(`frames[${i}].pointer must be an object { x, y, ... }`);
    // Run length (no overlap), a virtual gamepad, UI edges.
    const span = relayFrameEnd(stepOffset, raw.steps, previousEnd);
    if (!span.ok) return toolError(`frames[${i}]: ${span.reason}`);
    previousEnd = span.end;
    if (raw.gamepad !== undefined && parseRelayGamepad(raw.gamepad) === null) return toolError(`frames[${i}].gamepad must be { buttons?: up to 17 numbers 0-1, axes?: up to 4 numbers -1..1 }`);
    if (raw.ui !== undefined && parseRelayUiEdges(raw.ui) === null) return toolError(`frames[${i}].ui must be 1-8 of up, down, left, right, submit, cancel, pause`);
    for (const k of Object.keys(raw)) if (!['stepOffset', 'steps', 'actions', 'pointer', 'gamepad', 'ui'].includes(k)) return toolError(`frames[${i}].${k} is not a frame field (stepOffset, steps, actions, pointer, gamepad, ui)`);
    // The named actions reach the game (the backend validates them).
    frames.push({
      stepOffset,
      ...(raw.steps !== undefined ? { steps: raw.steps } : {}),
      ...(actions !== undefined ? { actions } : {}),
      ...(raw.pointer !== undefined ? { pointer: raw.pointer } : {}),
      ...(raw.gamepad !== undefined ? { gamepad: raw.gamepad } : {}),
      ...(raw.ui !== undefined ? { ui: raw.ui } : {}),
    });
  }
  if (a.restart !== undefined && typeof a.restart !== 'boolean') return toolError('restart must be true or false');
  if (a.hold !== undefined && typeof a.hold !== 'boolean') return toolError('hold must be true or false');
  const request = { mode: 'exclusive-test', frames, ...(a.restart === true ? { restart: true } : {}), ...(a.hold === true ? { hold: true } : {}) };
  const body = JSON.stringify(request);
  if (body.length > INPUT_RELAY_MAX_BODY_BYTES) return toolError(`the relay body exceeds the ${INPUT_RELAY_MAX_BODY_BYTES}-byte bound`);
  const res = await ctx.client.inputRelay(ctx.projectId, a.playSessionId, request);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

// ---- content tools ------------------------------------------------------------

/** Bounded content queries (commands.md and the content routes). */
async function contentQuery(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const target = a.target;
  if (target === 'projectFiles') {
    const dir = a.dir ?? '';
    if (typeof dir !== 'string') return toolError('dir must be a string');
    const res = await ctx.client.listProjectFiles(ctx.projectId, dir);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'materials') {
    // The materials and their graph problems (the backend checks them at load and after each change).
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    if (a.materialId !== undefined && typeof a.materialId !== 'string') return toolError('materialId must be a string');
    if (a.withProblems !== undefined && typeof a.withProblems !== 'boolean') return toolError('withProblems must be a boolean');
    const res = await ctx.client.contentMaterials(ctx.projectId, { ...(paged.args as { limit?: number; offset?: number }), ...(typeof a.materialId === 'string' ? { materialId: a.materialId } : {}), ...(a.withProblems === true ? { withProblems: true } : {}) });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'integrity') {
    if (a.check !== undefined && typeof a.check !== 'boolean') return toolError('check must be a boolean');
    if (a.problems !== undefined && typeof a.problems !== 'boolean') return toolError('problems must be a boolean');
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const page = { ...(paged.args as { limit?: number; offset?: number }), ...(a.problems === true ? { problems: true } : {}) };
    const res = a.check === true ? await ctx.client.checkFiles(ctx.projectId, page) : await ctx.client.contentIntegrity(ctx.projectId, page);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // The v3 game-config query (commands.md) over the same shared command
  // surface; no args.
  if (target === 'game') {
    if (a.includeDescriptors !== undefined && typeof a.includeDescriptors !== 'boolean') return toolError('includeDescriptors must be a boolean');
    const res = await ctx.client.command(ctx.projectId, { op: 'queryGameConfig', ...(a.includeDescriptors === true ? { args: { descriptors: true } } : {}) });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'assets' || target === 'asset') {
    if (target === 'asset') {
      if (typeof a.assetId !== 'string' || a.assetId.length === 0) return toolError('assetId is required for target="asset"');
      const one = await ctx.client.contentAsset(ctx.projectId, a.assetId);
      return isObj(one.body) && one.body.ok === true ? toolOk(one.body) : surfaceBackendError(one);
    }
    const args: Record<string, unknown> = {};
    if (a.includeVersions !== undefined) {
      if (typeof a.includeVersions !== 'boolean') return toolError('includeVersions must be a boolean');
      args.includeVersions = a.includeVersions;
    }
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const res = await ctx.client.command(ctx.projectId, { op: 'queryAssets', args: { ...args, ...paged.args } });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'prefabs') {
    const args: Record<string, unknown> = {};
    if (a.prefabId !== undefined) {
      if (typeof a.prefabId !== 'string') return toolError('prefabId must be a string');
      args.prefabId = a.prefabId;
    }
    if (a.includeEntities !== undefined) {
      if (typeof a.includeEntities !== 'boolean') return toolError('includeEntities must be a boolean');
      args.includeEntities = a.includeEntities;
    }
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const res = await ctx.client.command(ctx.projectId, { op: 'queryPrefabs', args: { ...args, ...paged.args } });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (target === 'behaviors') {
    const args: Record<string, unknown> = {};
    if (a.behaviorId !== undefined) {
      if (typeof a.behaviorId !== 'string') return toolError('behaviorId must be a string');
      args.behaviorId = a.behaviorId;
    }
    if (a.includeDeclaration !== undefined) {
      if (typeof a.includeDeclaration !== 'boolean') return toolError('includeDeclaration must be a boolean');
      args.includeDeclaration = a.includeDeclaration;
    }
    if (a.includeTrust !== undefined) {
      if (typeof a.includeTrust !== 'boolean') return toolError('includeTrust must be a boolean');
      args.includeTrust = a.includeTrust;
    }
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const res = await ctx.client.command(ctx.projectId, { op: 'queryBehaviors', args: { ...args, ...paged.args } });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // Block-layer cells and regions.
  if (target === 'blocks') {
    const args: Record<string, unknown> = {};
    for (const k of ['sceneId', 'entityId', 'chunks', 'box', 'region'] as const) if (a[k] !== undefined) args[k] = a[k];
    const res = await ctx.client.command(ctx.projectId, { op: 'queryBlocks', args });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // Terrains: tiles and their bytes, the surface at points.
  if (target === 'terrain') {
    const args: Record<string, unknown> = {};
    for (const k of ['sceneId', 'entityId', 'points', 'scatter'] as const) if (a[k] !== undefined) args[k] = a[k];
    const res = await ctx.client.command(ctx.projectId, { op: 'queryTerrain', args });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // The ground at points from whichever block layer or terrain is there.
  if (target === 'surface') {
    const args: Record<string, unknown> = {};
    for (const k of ['sceneId', 'points'] as const) if (a[k] !== undefined) args[k] = a[k];
    const res = await ctx.client.command(ctx.projectId, { op: 'querySurface', args });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // The project index: every asset, resource and scene (file, name, labels, what it references).
  if (target === 'index') {
    const args: Record<string, unknown> = {};
    for (const k of ['kind', 'id', 'label', 'address', 'referencing', 'text', 'folder', 'sort'] as const) {
      if (a[k] === undefined) continue;
      if (typeof a[k] !== 'string') return toolError(`${k} must be a string`);
      args[k] = a[k];
    }
    for (const k of ['loadable', 'recursive', 'folders', 'descending'] as const) {
      if (a[k] === undefined) continue;
      if (typeof a[k] !== 'boolean') return toolError(`${k} must be a boolean`);
      args[k] = a[k];
    }
    if (a.labels !== undefined) {
      if (!Array.isArray(a.labels) || !a.labels.every((l) => typeof l === 'string')) return toolError('labels must be an array of strings');
      args.labels = a.labels;
    }
    const paged = pageArgs(a);
    if (!paged.ok) return paged.error;
    const res = await ctx.client.command(ctx.projectId, { op: 'queryIndex', args: { ...args, ...paged.args } });
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  return toolError('target must be "assets", "asset", "prefabs", "behaviors", "integrity", "game", "projectFiles", "blocks", "materials" or "index"');
}

function pageArgs(a: Record<string, unknown>): { ok: true; args: Record<string, unknown> } | { ok: false; error: CallToolResult } {
  const args: Record<string, unknown> = {};
  if (a.limit !== undefined) {
    if (!isInt(a.limit) || a.limit < 1 || a.limit > CONTENT_ASSETS_LIMIT_MAX) return { ok: false, error: toolError(`limit must be an integer 1–${CONTENT_ASSETS_LIMIT_MAX}`) };
    args.limit = a.limit;
  }
  if (a.offset !== undefined) {
    if (!isInt(a.offset) || a.offset < 0) return { ok: false, error: toolError('offset must be an integer ≥ 0') };
    args.offset = a.offset;
  }
  return { ok: true, args };
}

/** Decode base64 without a `node:` import (the global Web `atob`). */
function decodeBase64(text: string): Uint8Array | null {
  const fn = (globalThis as { atob?: (data: string) => string }).atob;
  if (typeof fn !== 'function') return null;
  let binary: string;
  try {
    binary = fn(text);
  } catch {
    return null;
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

/** Stage + upload (bounded frames) + inspect over the real backend routes. */
async function contentUpload(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  // Pack a texture (array) from texture assets.
  if (a.pack !== undefined) {
    if (a.dataBase64 !== undefined || a.projectPath !== undefined || a.ktx2 !== undefined) return toolError('pack goes alone (no dataBase64, projectPath or ktx2; its encoding is pack.encoding)');
    if (!isObj(a.pack)) return toolError('pack must be an object {layers, encoding}');
    const body: Record<string, unknown> = { layers: a.pack.layers, encoding: a.pack.encoding };
    if (a.displayName !== undefined) body.displayName = a.displayName;
    const res = await ctx.client.packTexture(ctx.projectId, body);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  // An asset tool's job export (a folder or zip: a GLB and manifest.json).
  if (a.jobExport !== undefined) {
    if (!isObj(a.jobExport)) return toolError('jobExport must be an object {path?}');
    if (a.projectPath !== undefined || a.kind !== undefined || a.ktx2 !== undefined || a.animation !== undefined) return toolError('jobExport goes alone (with dataBase64 of a zip, or its own path; the model is kind "model")');
    const body: Record<string, unknown> = {};
    if (a.displayName !== undefined) body.displayName = a.displayName;
    if (a.jobExport.path !== undefined) {
      if (a.dataBase64 !== undefined) return toolError('give jobExport.path or dataBase64 (a zip), not both');
      body.path = a.jobExport.path;
    } else {
      if (typeof a.dataBase64 !== 'string' || a.dataBase64.length === 0) return toolError('jobExport needs a path, or dataBase64 of a zip');
      const zip = decodeBase64(a.dataBase64);
      if (zip === null || zip.length === 0) return toolError('dataBase64 is not valid base64');
      if (zip.length > CONTENT_STAGE_MAX) return toolError(`dataBase64 exceeds the ${CONTENT_STAGE_MAX}-byte stage cap`);
      const created = await ctx.client.createStage(ctx.projectId, {});
      if (!(isObj(created.body) && created.body.ok === true && typeof created.body.stageId === 'string')) return surfaceBackendError(created);
      for (let offset = 0; offset < zip.length; offset += CONTENT_UPLOAD_FRAME_MAX) {
        const put = await ctx.client.uploadFrame(ctx.projectId, created.body.stageId, offset, zip.length, zip.subarray(offset, Math.min(offset + CONTENT_UPLOAD_FRAME_MAX, zip.length)));
        if (!(isObj(put.body) && put.body.ok === true)) return surfaceBackendError(put);
      }
      body.stageId = created.body.stageId;
    }
    const res = await ctx.client.inspectJobExport(ctx.projectId, body);
    return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
  }
  if (a.projectPath !== undefined) {
    if (a.dataBase64 !== undefined) return toolError('give either dataBase64 or projectPath, not both');
    return projectFileInspect(ctx, a);
  }
  if (a.writeTo !== undefined) {
    if (typeof a.writeTo !== 'string' || a.writeTo.length === 0) return toolError('writeTo must be a path relative to the game folder, e.g. assets/voice/line-001.ogg');
    if (a.kind !== undefined || a.ktx2 !== undefined || a.animation !== undefined || a.displayName !== undefined) return toolError('writeTo goes with dataBase64 only (the file is written, not inspected)');
  }
  if (typeof a.dataBase64 !== 'string' || a.dataBase64.length === 0) return toolError('dataBase64 or projectPath is required');
  const bytes = decodeBase64(a.dataBase64);
  if (bytes === null) return toolError('dataBase64 is not valid base64');
  if (bytes.length === 0) return toolError('dataBase64 decodes to zero bytes');
  if (bytes.length > CONTENT_STAGE_MAX) return toolError(`dataBase64 exceeds the ${CONTENT_STAGE_MAX}-byte stage cap`);
  const body: Record<string, unknown> = {};
  if (a.displayName !== undefined) {
    if (typeof a.displayName !== 'string' || a.displayName.length < 1 || a.displayName.length > 128) {
      return toolError('displayName must be a 1–128 character string');
    }
    body.displayName = a.displayName;
  }
  const created = await ctx.client.createStage(ctx.projectId, body);
  if (!(isObj(created.body) && created.body.ok === true && typeof created.body.stageId === 'string')) {
    return surfaceBackendError(created);
  }
  const stageId = created.body.stageId;
  for (let offset = 0; offset < bytes.length; offset += CONTENT_UPLOAD_FRAME_MAX) {
    const frame = bytes.subarray(offset, Math.min(offset + CONTENT_UPLOAD_FRAME_MAX, bytes.length));
    const put = await ctx.client.uploadFrame(ctx.projectId, stageId, offset, bytes.length, frame);
    if (!(isObj(put.body) && put.body.ok === true)) return surfaceBackendError(put);
  }
  if (typeof a.writeTo === 'string') {
    const filed = await ctx.client.fileStage(ctx.projectId, stageId, a.writeTo);
    return isObj(filed.body) && filed.body.ok === true ? toolOk(filed.body) : surfaceBackendError(filed);
  }
  // The additive inspect request selects the inspector of a kind
  // or the role-aware animated GLB profile.
  const inspectBody: Record<string, unknown> = {};
  if (a.kind !== undefined) {
    if (a.kind !== 'model' && a.kind !== 'audio' && a.kind !== 'texture' && a.kind !== 'font') return toolError('kind must be "model", "audio", "texture" or "font" (audio of any length is "audio")');
    inspectBody.kind = a.kind;
  }
  if (a.animation !== undefined) {
    if (!isObj(a.animation)) return toolError('animation must be an object');
    const roles = a.animation.roles;
    if (!isObj(roles)) return toolError('animation.roles must be an object');
    inspectBody.animation = a.animation;
  }
  if (a.ktx2 !== undefined) {
    if (a.ktx2 !== 'color' && a.ktx2 !== 'normal' && a.ktx2 !== 'data') return toolError('ktx2 must be "color", "normal" or "data"');
    inspectBody.ktx2 = a.ktx2;
  }
  const inspected = await ctx.client.inspectStage(ctx.projectId, stageId, inspectBody);
  return isObj(inspected.body) && inspected.body.ok === true ? toolOk(inspected.body) : surfaceBackendError(inspected);
}

/** Inspect a file already in the game folder, in place (no upload, no copy). */
async function projectFileInspect(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.projectPath !== 'string' || a.projectPath.length === 0) return toolError('projectPath must be a non-empty string');
  const body: Record<string, unknown> = { path: a.projectPath };
  if (a.displayName !== undefined) {
    if (typeof a.displayName !== 'string' || a.displayName.length < 1 || a.displayName.length > 128) {
      return toolError('displayName must be a 1–128 character string');
    }
    body.displayName = a.displayName;
  }
  if (a.kind !== undefined) {
    if (a.kind !== 'model' && a.kind !== 'audio' && a.kind !== 'texture' && a.kind !== 'font') return toolError('kind must be "model", "audio", "texture" or "font" (audio of any length is "audio")');
    body.kind = a.kind;
  }
  if (a.animation !== undefined) {
    if (!isObj(a.animation) || !isObj(a.animation.roles)) return toolError('animation.roles must be an object');
    body.animation = a.animation;
  }
  if (a.ktx2 !== undefined) {
    if (a.ktx2 !== 'color' && a.ktx2 !== 'normal' && a.ktx2 !== 'data') return toolError('ktx2 must be "color", "normal" or "data"');
    body.ktx2 = a.ktx2;
  }
  const res = await ctx.client.inspectProjectFile(ctx.projectId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

// ---- game control/observation relay tools -------------------------------------

/** Publish an instance-set buffer (inline transforms). */
async function instanceBuffer(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (a.digest !== undefined) {
    if (a.transforms !== undefined) return toolError('give transforms (publish) or digest (read), not both');
    if (typeof a.digest !== 'string' || !/^[0-9a-f]{64}$/.test(a.digest)) return toolError('digest must be 64 lowercase hex characters');
    const read = await ctx.client.readInstanceBuffer(ctx.projectId, a.digest);
    if (!read.ok) return surfaceBackendError(read.response);
    const count = Math.floor(read.floats.length / 10);
    if (count > INSTANCE_BUFFER_INLINE_MAX) return toolError(`the buffer holds ${count} copies; reading returns sets of up to ${INSTANCE_BUFFER_INLINE_MAX} copies`);
    // 9 significant digits: every float32 reads back to the same value when republished.
    return toolOk({ ok: true, digest: a.digest, count, transforms: Array.from(read.floats, (v) => Number(v.toPrecision(9))) });
  }
  const t = a.transforms;
  if (!Array.isArray(t) || t.length === 0 || t.length % INSTANCE_FLOATS !== 0 || t.length > INSTANCE_BUFFER_INLINE_MAX * INSTANCE_FLOATS || !t.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return toolError(`transforms must be a flat list of finite numbers, ${INSTANCE_FLOATS} per copy, 1-${INSTANCE_BUFFER_INLINE_MAX} copies`);
  }
  const res = await ctx.client.publishInstanceBuffer(ctx.projectId, { transforms: t });
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** Bounded game-control relay (never a simulation). */
async function gameControl(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const playSessionId = a.playSessionId;
  if (typeof playSessionId !== 'string' || playSessionId.length === 0) return toolError('playSessionId is required');
  const command = a.command ?? (a.signal !== undefined ? SIGNAL_DEBUG_COMMAND_NAME : undefined);
  if (typeof command !== 'string' || !(TOOL_CONTROL_COMMANDS as readonly string[]).includes(command)) {
    return toolError(`command must be one of ${TOOL_CONTROL_COMMANDS.join(', ')}`);
  }
  if (command === SIGNAL_DEBUG_COMMAND_NAME) {
    if (a.value !== undefined) return toolError('signals carry no value (ctx.signals.emit takes a name only); give scripts a value with a debugCommand or a script message');
    if (typeof a.signal !== 'string' || a.signal.length === 0) return toolError('signal (the signal name) is required for command signal');
    if (a.name !== undefined || a.args !== undefined || a.sceneId !== undefined || a.level !== undefined) return toolError('signal takes the signal name only');
    a = { ...a, command: 'debugCommand', name: SIGNAL_DEBUG_COMMAND_NAME, args: { name: a.signal } };
  } else if (a.signal !== undefined) {
    return toolError('signal goes with command signal only');
  }
  const body: Record<string, unknown> = { command: a.command };
  if (a.expectedRunId !== undefined) {
    if (typeof a.expectedRunId !== 'string' || a.expectedRunId.length === 0 || a.expectedRunId.length > 128) {
      return toolError('expectedRunId must be a bounded non-empty string');
    }
    body.expectedRunId = a.expectedRunId;
  }
  if (a.command === 'loadScene' || a.command === 'unloadScene') {
    if (typeof a.sceneId !== 'string' || a.sceneId.length === 0) return toolError('sceneId is required for loadScene / unloadScene');
    body.sceneId = a.sceneId;
  } else if (a.sceneId !== undefined) {
    return toolError('sceneId goes with loadScene / unloadScene only');
  }
  // A debug command's name and arguments.
  if (a.command === 'debugCommand') {
    if (typeof a.name !== 'string' || a.name.length === 0) return toolError('name is required for debugCommand');
    body.name = a.name;
    if (a.args !== undefined) {
      if (!isObj(a.args)) return toolError('args must be an object of argument values');
      body.args = a.args;
    }
  } else if (a.name !== undefined || a.args !== undefined) {
    return toolError('name and args go with debugCommand only');
  }
  if (a.command === 'setQuality') {
    if (typeof a.level !== 'string' || a.level.length === 0) return toolError('level (a quality level id) is required for setQuality');
    body.level = a.level;
  } else if (a.level !== undefined) {
    return toolError('level goes with setQuality only');
  }
  const res = await ctx.client.gameControl(ctx.projectId, playSessionId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

/** Bounded read-only observation relay (never a simulation). */
async function gameObserve(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.playSessionId !== 'string' || a.playSessionId.length === 0) return toolError('playSessionId is required');
  const body: Record<string, unknown> = {};
  if (a.timeoutMs !== undefined) {
    if (!isInt(a.timeoutMs) || a.timeoutMs < GAME_OBSERVE_TIMEOUT_MIN_MS || a.timeoutMs > GAME_OBSERVE_TIMEOUT_MAX_MS) return toolError(`timeoutMs must be an integer ${GAME_OBSERVE_TIMEOUT_MIN_MS}–${GAME_OBSERVE_TIMEOUT_MAX_MS}`);
    body.timeoutMs = a.timeoutMs;
  }
  if (a.entityId !== undefined) {
    if (typeof a.entityId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(a.entityId)) return toolError('entityId must be an entity id');
    body.entityId = a.entityId;
  }
  const res = await ctx.client.gameObserve(ctx.projectId, a.playSessionId, body);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}

async function contentJob(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  if (typeof a.jobId !== 'string' || !/^job-[0-9a-f]{32}$/.test(a.jobId)) return toolError('jobId must be job- + 32 hex');
  const res = await ctx.client.contentJob(ctx.projectId, a.jobId);
  return isObj(res.body) && res.body.ok === true ? toolOk(res.body) : surfaceBackendError(res);
}
// ---- the headless play-test runner ------------------------------------------

async function playtest(ctx: McpContext, a: Record<string, unknown>): Promise<CallToolResult> {
  const spec: { -readonly [K in keyof PlaytestSpec]: PlaytestSpec[K] } = {};
  if (a.sceneId !== undefined) {
    if (typeof a.sceneId !== 'string') return toolError('sceneId must be a string');
    spec.sceneId = a.sceneId;
  }
  if (a.mode !== undefined) {
    if (typeof a.mode !== 'string') return toolError('mode must be a string');
    spec.mode = a.mode;
  }
  if (a.driver !== undefined) {
    // The driver is the project's own Node code: this process loads no code by a computed path (dependencies.md).
    return toolError('a driver script runs from the command line: node tools/playtest.mjs <game folder> --driver <file> (tl_playtest takes an input script: frames)');
  }
  // The runner checks the rest (frames, threads, runs, observe, variables, timeoutMs).
  if (a.variables !== undefined) spec.variables = a.variables as Record<string, unknown>;
  if (a.threads !== undefined) spec.threads = a.threads as PlaytestSpec['threads'];
  if (a.runs !== undefined) spec.runs = a.runs as number;
  if (a.frames !== undefined) spec.frames = a.frames as PlaytestSpec['frames'];
  if (a.observe !== undefined) spec.observe = a.observe as PlaytestSpec['observe'];
  if (a.timeoutMs !== undefined) spec.timeoutMs = a.timeoutMs as number;
  const result = await runPlaytest(playtestBackend(ctx.client, ctx.projectId), ctx.projectId, spec);
  return result.ok ? toolOk(result) : { content: [{ type: 'text', text: JSON.stringify(result) }], isError: true };
}
