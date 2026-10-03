/**
 * Project-defined save documents in the simulation —
 * `ctx.saves` and the runtime's part of the save flow.
 *
 * The runtime never touches storage (the host owns it: IndexedDB in the
 * browser). Scripts write the project's own JSON document, ask for a save,
 * a load or a delete of a numbered slot, and read the slot list and the
 * outcomes. Requests leave the simulation (`takeRequests`, like sounds);
 * everything that comes back from storage — the slot list, save/delete
 * outcomes and a loaded document — enters as an entry of a step's input
 * frame (`ActionFrame.saves`), so a recording replays it and the page and the
 * simulation worker see it at the same step.
 *
 * A save is assembled at the end of the step it was asked for: the project
 * document plus the engine sections the schema opts into (block-layer cells,
 * material parameters, spawned copies, `ctx.save` storage) and the play time.
 * Format version 2: every save also carries where the play
 * stands (`world`: the loaded scenes, the active spawn, the scene list entry
 * and the character's position and velocity), so a load puts the character
 * back where it was saved; a version 1 save (without it) still loads.
 * A loaded document is migrated (the project's registered migration
 * functions, one version at a time) and restored at the end of the step whose
 * frame brought it — a step boundary: the next step starts from the restored
 * state in every host.
 *
 * No I/O, no three.js.
 */
import { ID_RE } from '@thirdlight/project-model';
import {
  SAVE_LIMITS,
  saveSlotMetaProblem,
  effectiveField,
  settingsDocumentOf,
  settingsValueFits,
  type SaveSchema,
  type SaveSection,
  type SettingsFieldValue,
} from '@thirdlight/project-model';

/** The save document's format marker (and its engine format version; 2, with `world`). */
export const PROJECT_SAVE_FORMAT = 'thirdlight.save';
export const PROJECT_SAVE_FORMAT_VERSION = 2;

/**
 * Where the play stands in a save — the scenes loaded (in load
 * order), the spawn respawns use, the game shell's scene list entry (-1:
 * none) and the character (the controller's object) with its velocity (m/s;
 * z is 0 on the 2D plane) and, in 3D, the way it faces (degrees about +Y, as
 * `characterState().facing` reads it; older saves have none), or null
 * without a character.
 */
export interface WorldSave {
  readonly scenes: readonly string[];
  readonly activeSpawn: string | null;
  readonly listedScene: number;
  readonly character: { readonly position: readonly [number, number, number]; readonly velocity: readonly [number, number, number]; readonly facing?: number } | null;
}

const SCENE_ID_RE = ID_RE;

/** A saved `world` block's shape (null: fine). */
export function worldSaveProblem(v: unknown): string | null {
  if (!isObj(v)) return 'world is an object { scenes, activeSpawn, listedScene, character }';
  for (const k of Object.keys(v)) if (!['scenes', 'activeSpawn', 'listedScene', 'character'].includes(k)) return `unknown world field "${k.slice(0, 32)}"`;
  const scenes = v['scenes'];
  if (!Array.isArray(scenes) || !scenes.every((x) => typeof x === 'string' && SCENE_ID_RE.test(x))) return 'world.scenes lists scene ids';
  const spawn = v['activeSpawn'];
  if (spawn !== null && !(typeof spawn === 'string' && SCENE_ID_RE.test(spawn))) return 'world.activeSpawn is an entity id or null';
  if (!intIn(v['listedScene'], -1, Number.MAX_SAFE_INTEGER)) return 'world.listedScene is an integer from -1 (an index in the shell\'s scene list)';
  const c = v['character'];
  if (c === null) return null;
  const vec = (x: unknown, lim: number): boolean => Array.isArray(x) && x.length === 3 && x.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= lim);
  if (!isObj(c) || Object.keys(c).some((k) => k !== 'position' && k !== 'velocity' && k !== 'facing') || !vec(c['position'], 1e6) || !vec(c['velocity'], 1e4)) return 'world.character is { position: [x, y, z], velocity: [x, y, z], facing? } or null';
  if (c['facing'] !== undefined && !(typeof c['facing'] === 'number' && Number.isFinite(c['facing']) && Math.abs(c['facing']) <= 360)) return 'world.character.facing is degrees (-360 to 360)';
  return null;
}
/** Engine limit: save/load/delete requests one step may make (every script together). */
export const SAVE_REQUESTS_PER_STEP = 8;
/** Engine limit: save entries one input frame may carry. */
export const MAX_FRAME_SAVE_EVENTS = 16;

/** One used slot as the slot list shows it (`ctx.saves.slots()`). */
export interface SaveSlotInfo {
  /** The slot number (1 – the project's slot count). */
  readonly slot: number;
  /** The texts the game gave when it saved (empty when none). */
  readonly title: string;
  readonly chapter: string;
  readonly location: string;
  /** Play time in seconds when it was saved. */
  readonly playSeconds: number;
  /** When it was saved (ISO 8601, the player's clock). */
  readonly savedAt: string;
  /** The save document's schema version. */
  readonly version: number;
  /** The size of the stored document (bytes of JSON). */
  readonly bytes: number;
  /** Whether the slot has a picture of the view. */
  readonly thumbnail: boolean;
  /** The game's own fields the save gave (`meta`: at most 8 short texts; {} when none). */
  readonly meta: Readonly<Record<string, string>>;
  /** Set when the stored slot cannot be read (it is never loaded). */
  readonly damaged?: string;
}

/**
 * Why the player's storage refused a write, for the game's own message
 * (the browser's text is the result's `reason`): the disk or the site's
 * quota is full, the page has no storage (IndexedDB off, a private window
 * that refuses it), or any other refusal.
 */
export const SAVE_STORAGE_CODES = ['storage_full', 'storage_unavailable', 'storage_failed'] as const;
export type SaveStorageCode = (typeof SAVE_STORAGE_CODES)[number];

/** The outcome of one save, load or delete, or a settings document storage refused (`ctx.saves.results()`). */
export interface SaveResult {
  readonly op: 'save' | 'load' | 'delete' | 'settings';
  /** The slot (0: a document given at the start, e.g. by `tl_play_start`, and the settings document). */
  readonly slot: number;
  readonly ok: boolean;
  /** Why it failed. */
  readonly reason?: string;
  /** Set when the player's storage refused it. */
  readonly code?: SaveStorageCode;
}

/**
 * The player's storage as the browser reports it (`ctx.saves.storage()`):
 * whether it keeps the game's data under disk pressure (asked for at the
 * first save), and the site's usage and quota in bytes. Null where unknown
 * (no storage manager, or not answered yet).
 */
export interface SaveStorageInfo {
  readonly persisted: boolean | null;
  readonly usage: number | null;
  readonly quota: number | null;
}

/** What a save shows in the slot list (`ctx.saves.save(slot, meta)`). */
export interface SaveMeta {
  /** A title for the slot (up to 128 characters). */
  title?: string;
  /** The chapter (up to 128 characters). */
  chapter?: string;
  /** The location (up to 128 characters). */
  location?: string;
  /** Keep a small picture of the view with the slot. */
  thumbnail?: boolean;
  /** The game's own fields for the slot card (at most 8 names → texts of up to 128 characters), returned by `slots()`. */
  meta?: Readonly<Record<string, string>>;
}

/** A stored save document (the whole body of a slot; also what `tl_play_start` accepts as `save`). */
export interface ProjectSaveFile {
  readonly format: 'thirdlight.save';
  readonly formatVersion?: number;
  /** The project document's schema version. */
  readonly version: number;
  readonly playSeconds?: number;
  /** The project's own document. */
  readonly doc: unknown;
  /** Engine state the schema opts into. */
  readonly sections?: Readonly<Partial<Record<SaveSection, unknown>>>;
  /** Format version 2: where the play stands. */
  readonly world?: WorldSave;
}

/**
 * One storage entry of an input frame (the host's answer to a request, or the
 * slot list): part of the input, so a recording replays it.
 */
export type SaveEvent =
  | { readonly kind: 'slots'; readonly slots: readonly SaveSlotInfo[] }
  | { readonly kind: 'saved'; readonly slot: number; readonly ok: boolean; readonly reason?: string; readonly code?: SaveStorageCode }
  | { readonly kind: 'deleted'; readonly slot: number; readonly ok: boolean; readonly reason?: string; readonly code?: SaveStorageCode }
  | { readonly kind: 'loaded'; readonly slot: number; readonly ok: boolean; readonly reason?: string; readonly save?: ProjectSaveFile; readonly code?: SaveStorageCode }
  /** The settings document was not kept (it still applies for this session). */
  | { readonly kind: 'settings'; readonly ok: false; readonly reason: string; readonly code: SaveStorageCode }
  | ({ readonly kind: 'storage' } & SaveStorageInfo);

/** A request for the host (the storage owner), in the order scripts made them. */
export type SaveRequest =
  | {
      readonly op: 'save';
      readonly slot: number;
      readonly meta: { readonly title: string; readonly chapter: string; readonly location: string; readonly playSeconds: number; readonly version: number; readonly thumbnail: boolean; readonly meta?: Readonly<Record<string, string>> };
      /** The document's JSON text (≤ 1 MiB). */
      readonly text: string;
    }
  | { readonly op: 'load'; readonly slot: number }
  | { readonly op: 'delete'; readonly slot: number }
  | { readonly op: 'settings'; readonly values: Readonly<Record<string, SettingsFieldValue>> };

/**
 * `ctx.saves` — the project's save document and its slots, and the project
 * settings document. Requires a save schema in the project (Project → Saves);
 * without one every call answers false / empty.
 */
export interface BehaviorSaves {
  /**
   * The save document's schema version (0: the project declares no save schema).
   * @graphPure
   * @graphNode Save version
   */
  readonly version: number;
  /**
   * How many slots the game offers.
   * @graphPure
   * @graphNode Save slot count
   */
  readonly slotCount: number;
  /**
   * Replace the project's save document (any JSON value); false when it is not JSON or larger than 1 MiB.
   * @graphNode Write save document
   */
  write(doc: unknown): boolean;
  /**
   * The project's save document (a copy; null before one is written or loaded).
   * @graphPure
   * @graphNode Save document
   */
  read(): unknown;
  /**
   * Save to a slot at the end of this step (the document and the engine sections of the schema);
   * the outcome arrives in `results()`. `meta.meta`: the game's own fields for the slot card (at most 8 names → short texts).
   * False for a slot the game does not have or a meta that does not fit.
   * @graphNode Save to slot
   */
  save(slot: number, meta?: SaveMeta): boolean;
  /**
   * Load a slot: when storage answers, the document is migrated and restored at the end of that step
   * (the outcome in `results()`).
   * @graphNode Load slot
   */
  load(slot: number): boolean;
  /**
   * Delete a slot (the outcome in `results()`).
   * @graphNode Delete slot
   */
  delete(slot: number): boolean;
  /**
   * The used slots with what they show (title, chapter, location, play time, when, picture, the game's own `meta` fields).
   * @graphPure
   * @graphNode Save slots
   */
  slots(): readonly SaveSlotInfo[];
  /**
   * Whether the slot list has arrived from storage (it is empty before).
   * @graphPure
   * @graphNode Save slots ready
   */
  ready(): boolean;
  /**
   * The outcomes that arrived this step (saves, loads and deletes).
   * @graphPure
   * @graphNode Save results
   */
  results(): readonly SaveResult[];
  /**
   * The player's storage: whether the browser keeps the game's saves under disk pressure (`persisted`, asked for
   * at the first save) and the site's `usage` and `quota` in bytes; null where the browser does not say.
   * @graphPure
   * @graphNode Save storage
   */
  storage(): SaveStorageInfo;
  /**
   * Play time in seconds (restored with a loaded save).
   * @graphPure
   * @graphNode Play time
   */
  playSeconds(): number;
  /**
   * Register the migration a save schema names: `migrate(doc, fromVersion)` returns the document one
   * version later. Call it every step (or once at the start); the last registration counts.
   * @graphNode skip a migration is a function (code)
   */
  migration(name: string, migrate: (doc: unknown, fromVersion: number) => unknown): boolean;
  /**
   * A value of the project settings document (its default until the player changes it).
   * @graphPure
   * @graphNode Setting
   */
  setting(key: string): boolean | number | string | null;
  /**
   * The whole project settings document (a copy).
   * @graphPure
   * @graphNode Settings document
   */
  settings(): Record<string, boolean | number | string>;
  /**
   * Change a value of the project settings document (kept in the player's browser; an engine setting
   * it drives — volume, quality — applies at once). False when the key is unknown or the value does not fit.
   * @graphNode Set setting
   */
  setSetting(key: string, value: boolean | number | string): boolean;
}

/** The engine state a save's sections capture and restore (the runtime implements it). */
export interface SaveSectionsPort {
  capture(section: SaveSection): unknown;
  /** Why a saved section cannot be restored now (null: it can). The grid checks while it restores. */
  check(section: SaveSection, value: unknown): string | null;
  /** Restore (value undefined: back to the run's start); the grid may refuse (null: done). */
  apply(section: SaveSection, value: unknown): string | null;
  /** Where the play stands now (every save carries it). */
  captureWorld(): WorldSave;
  /** Why a saved world cannot be restored now (null: it can). */
  checkWorld(world: WorldSave): string | null;
  /** Restore it (scenes load and unload; the character is placed once they are in). */
  applyWorld(world: WorldSave): void;
}

// ---- validation ------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const intIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const storageCode = (v: unknown): v is SaveStorageCode => (SAVE_STORAGE_CODES as readonly unknown[]).includes(v);
const bytesOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);

/** Bytes of a string as UTF-8. */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i += 1;
    } else n += 3;
  }
  return n;
}

/** The JSON text of a value when it is JSON (no functions, cycles or non-finite numbers lost silently), else null. */
function jsonText(v: unknown): string | null {
  let t: string | undefined;
  try {
    t = JSON.stringify(v);
  } catch {
    return null;
  }
  return t === undefined ? null : t;
}

/** Check a stored save document's shape (not its migration): null when it can be loaded by a schema of `maxVersion`. */
export function projectSaveFileProblem(v: unknown, maxVersion: number): string | null {
  if (!isObj(v) || v['format'] !== PROJECT_SAVE_FORMAT) return 'not a project save document (format "thirdlight.save")';
  // Format version 2 carries `world`; a version 1 save (without it) still loads.
  const fv = v['formatVersion'] ?? 1;
  if (fv !== 1 && fv !== PROJECT_SAVE_FORMAT_VERSION) return `save format version ${String(v['formatVersion']).slice(0, 16)} is not supported`;
  if (fv === 1 && v['world'] !== undefined) return 'a format version 1 save has no world';
  if (fv === PROJECT_SAVE_FORMAT_VERSION) {
    const w = worldSaveProblem(v['world']);
    if (w !== null) return w;
  }
  if (!intIn(v['version'], 1, SAVE_LIMITS.version)) return 'the save document has no valid version';
  if ((v['version'] as number) > maxVersion) return `the save is version ${v['version'] as number}; this game reads up to version ${maxVersion}`;
  if (v['playSeconds'] !== undefined && !(typeof v['playSeconds'] === 'number' && Number.isFinite(v['playSeconds']) && v['playSeconds'] >= 0)) return 'playSeconds is a number ≥ 0';
  if (!('doc' in v)) return 'the save document has no doc';
  if (v['sections'] !== undefined && !isObj(v['sections'])) return 'sections is an object';
  return null;
}

function slotInfoProblem(v: unknown): string | null {
  if (!isObj(v)) return 'a slot is an object';
  if (!intIn(v['slot'], 1, SAVE_LIMITS.slots)) return 'slot is 1-99';
  for (const k of ['title', 'chapter', 'location'] as const) if (!text(v[k], SAVE_LIMITS.metaText)) return `${k} is text of at most ${SAVE_LIMITS.metaText} characters`;
  if (!(typeof v['playSeconds'] === 'number' && Number.isFinite(v['playSeconds']) && v['playSeconds'] >= 0)) return 'playSeconds is a number ≥ 0';
  if (!text(v['savedAt'], 40)) return 'savedAt is a date text';
  if (!intIn(v['version'], 0, SAVE_LIMITS.version)) return 'version is an integer';
  if (!intIn(v['bytes'], 0, SAVE_LIMITS.documentBytes)) return 'bytes is an integer';
  if (typeof v['thumbnail'] !== 'boolean') return 'thumbnail is true or false';
  if (v['damaged'] !== undefined && !text(v['damaged'], 256)) return 'damaged is a reason text';
  // Older recordings and stores have no meta.
  if (v['meta'] !== undefined) {
    const m = saveSlotMetaProblem(v['meta']);
    if (m !== null) return m;
  }
  for (const k of Object.keys(v)) if (!['slot', 'title', 'chapter', 'location', 'playSeconds', 'savedAt', 'version', 'bytes', 'thumbnail', 'meta', 'damaged'].includes(k)) return `unknown slot field "${k}"`;
  return null;
}

const NO_META: Readonly<Record<string, string>> = Object.freeze({});
const freezeSlot = (s: SaveSlotInfo): SaveSlotInfo =>
  Object.freeze({ slot: s.slot, title: s.title, chapter: s.chapter, location: s.location, playSeconds: s.playSeconds, savedAt: s.savedAt, version: s.version, bytes: s.bytes, thumbnail: s.thumbnail, meta: s.meta === undefined || Object.keys(s.meta).length === 0 ? NO_META : Object.freeze({ ...s.meta }), ...(s.damaged !== undefined ? { damaged: s.damaged } : {}) });

/**
 * Validate a frame's `saves` entries strictly (bounded; a loaded document at
 * most 1 MiB). Returns frozen copies.
 */
export function validateSaveEvents(value: unknown): { ok: true; events: readonly SaveEvent[] } | { ok: false; field: string; message: string } {
  if (!Array.isArray(value) || value.length > MAX_FRAME_SAVE_EVENTS) return { ok: false, field: 'saves', message: `saves is a list of at most ${MAX_FRAME_SAVE_EVENTS} entries` };
  const out: SaveEvent[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const e = value[i] as Record<string, unknown>;
    const field = `saves/${i}`;
    const fail = (message: string) => ({ ok: false as const, field, message });
    if (!isObj(e)) return fail('a saves entry is an object');
    const reason = e['reason'];
    if (reason !== undefined && !text(reason, 256)) return fail('reason is text of at most 256 characters');
    const code = e['code'];
    if (code !== undefined && !storageCode(code)) return fail(`code is one of ${SAVE_STORAGE_CODES.join(', ')}`);
    const withCode = code !== undefined ? { code } : {};
    switch (e['kind']) {
      case 'slots': {
        const slots = e['slots'];
        if (!Array.isArray(slots) || slots.length > SAVE_LIMITS.slots) return fail(`slots lists at most ${SAVE_LIMITS.slots} slots`);
        for (const s of slots) {
          const p = slotInfoProblem(s);
          if (p !== null) return fail(p);
        }
        out.push(Object.freeze({ kind: 'slots' as const, slots: Object.freeze((slots as SaveSlotInfo[]).map(freezeSlot)) }));
        break;
      }
      case 'saved':
      case 'deleted': {
        if (!intIn(e['slot'], 1, SAVE_LIMITS.slots) || typeof e['ok'] !== 'boolean') return fail(`a ${e['kind']} entry is { slot 1-99, ok, reason? }`);
        out.push(Object.freeze({ kind: e['kind'], slot: e['slot'], ok: e['ok'], ...(reason !== undefined ? { reason: reason as string } : {}), ...withCode }));
        break;
      }
      case 'settings': {
        if (e['ok'] !== false || reason === undefined || code === undefined) return fail('a settings entry is { ok: false, reason, code }');
        out.push(Object.freeze({ kind: 'settings' as const, ok: false as const, reason: reason as string, code }));
        break;
      }
      case 'storage': {
        if (!(e['persisted'] === null || typeof e['persisted'] === 'boolean') || !bytesOrNull(e['usage']) || !bytesOrNull(e['quota'])) return fail('a storage entry is { persisted: boolean | null, usage, quota: bytes or null }');
        out.push(Object.freeze({ kind: 'storage' as const, persisted: e['persisted'], usage: e['usage'], quota: e['quota'] }));
        break;
      }
      case 'loaded': {
        if (!intIn(e['slot'], 0, SAVE_LIMITS.slots) || typeof e['ok'] !== 'boolean') return fail('a loaded entry is { slot 0-99, ok, reason?, save? }');
        let save: ProjectSaveFile | undefined;
        if (e['save'] !== undefined) {
          const t = jsonText(e['save']);
          if (t === null || utf8Length(t) > SAVE_LIMITS.documentBytes) return fail(`a loaded save is JSON of at most ${SAVE_LIMITS.documentBytes} bytes`);
          const p = projectSaveFileProblem(e['save'], SAVE_LIMITS.version);
          if (p !== null) return fail(p);
          save = deepFreeze(JSON.parse(t) as ProjectSaveFile);
        } else if (e['ok'] === true) return fail('a loaded entry that is ok carries the save');
        out.push(Object.freeze({ kind: 'loaded' as const, slot: e['slot'], ok: e['ok'], ...(reason !== undefined ? { reason: reason as string } : {}), ...(save !== undefined ? { save } : {}), ...withCode }));
        break;
      }
      default:
        return fail('kind is slots, saved, deleted, loaded, settings or storage');
    }
    for (const k of Object.keys(e)) if (!['kind', 'slots', 'slot', 'ok', 'reason', 'save', 'code', 'persisted', 'usage', 'quota'].includes(k)) return fail(`unknown saves entry field "${k}"`);
  }
  return { ok: true, events: Object.freeze(out) };
}

function deepFreeze<T>(v: T): T {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as object)) deepFreeze(x);
  }
  return v;
}

const MIGRATION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const NO_RESULTS: readonly SaveResult[] = Object.freeze([]);
const NO_SLOTS: readonly SaveSlotInfo[] = Object.freeze([]);
const STORAGE_UNKNOWN: SaveStorageInfo = Object.freeze({ persisted: null, usage: null, quota: null });

interface PendingSave {
  readonly slot: number;
  readonly meta: { title: string; chapter: string; location: string; thumbnail: boolean; meta?: Readonly<Record<string, string>> };
}

/**
 * The run's project saves: the document, the settings document, the slot list,
 * the outcomes scripts see, the requests for the host and the restore.
 */
export class RuntimeSaves {
  readonly schema: SaveSchema | null;
  readonly api: BehaviorSaves;
  private readonly hz: number;
  private readonly port: SaveSectionsPort;
  private readonly log: (message: string) => void;
  private doc: unknown = null;
  private docText = 'null';
  private settingsDoc: Record<string, SettingsFieldValue>;
  private settingsDirty = false;
  private slotList: readonly SaveSlotInfo[] = NO_SLOTS;
  private slotsReady = false;
  private storageInfo: SaveStorageInfo = STORAGE_UNKNOWN;
  private visible: readonly SaveResult[] = NO_RESULTS;
  private carried: SaveResult[] = [];
  /** Requests in call order; a save's text is filled at the end of its step. */
  private outbox: (SaveRequest | { op: 'save'; pending: PendingSave })[] = [];
  private ready: SaveRequest[] = [];
  private loads: Extract<SaveEvent, { kind: 'loaded' }>[] = [];
  private requests = 0;
  private readonly migrations = new Map<string, (doc: unknown, fromVersion: number) => unknown>();
  private playBase = 0;
  private playSteps = 0;
  /** Anything happened (the digest includes the saves state from then on). */
  private active = false;

  constructor(schema: SaveSchema | undefined, hz: number, port: SaveSectionsPort, initialSettings: unknown, log: (message: string) => void) {
    this.schema = schema ?? null;
    this.hz = hz;
    this.port = port;
    this.log = log;
    this.settingsDoc = settingsDocumentOf(this.schema?.settings ?? [], initialSettings);
    this.api = this.buildApi();
  }

  /** A step begins: last step's end-of-step outcomes become visible. */
  beginStep(): void {
    this.visible = this.carried.length > 0 ? Object.freeze(this.carried) : NO_RESULTS;
    this.carried = [];
    this.requests = 0;
  }

  /** This step's frame entries (the slot list, outcomes; loads apply at the end of the step). */
  deliver(events: readonly SaveEvent[]): void {
    if (this.schema === null || events.length === 0) return;
    this.active = true;
    const now: SaveResult[] = [...this.visible];
    for (const e of events) {
      if (e.kind === 'slots') {
        this.slotList = Object.freeze([...e.slots].filter((s) => s.slot <= this.schema!.slots).sort((a, b) => a.slot - b.slot).map(freezeSlot));
        this.slotsReady = true;
      } else if (e.kind === 'saved' || e.kind === 'deleted') {
        now.push(Object.freeze({ op: e.kind === 'saved' ? ('save' as const) : ('delete' as const), slot: e.slot, ok: e.ok, ...(e.reason !== undefined ? { reason: e.reason } : {}), ...(e.code !== undefined ? { code: e.code } : {}) }));
      } else if (e.kind === 'settings') {
        now.push(Object.freeze({ op: 'settings' as const, slot: 0, ok: false, reason: e.reason, code: e.code }));
      } else if (e.kind === 'storage') {
        this.storageInfo = Object.freeze({ persisted: e.persisted, usage: e.usage, quota: e.quota });
      } else this.loads.push(e);
    }
    this.visible = Object.freeze(now);
  }

  /** The end of a step: saves are assembled, loads restored, a changed settings document sent. */
  endStep(): void {
    this.playSteps += 1;
    if (this.schema === null) return;
    // Saves first (the state this step made), in request order with the loads and deletes.
    if (this.outbox.length > 0) {
      for (const r of this.outbox) {
        if (!('pending' in r)) {
          this.ready.push(r);
          continue;
        }
        const built = this.assemble(r.pending);
        if (typeof built === 'string') this.carried.push(Object.freeze({ op: 'save' as const, slot: r.pending.slot, ok: false, reason: built }));
        else this.ready.push(built);
      }
      this.outbox = [];
    }
    if (this.loads.length > 0) {
      const loads = this.loads;
      this.loads = [];
      for (const e of loads) {
        const reason = e.ok ? this.restore(e.save!) : (e.reason ?? 'the slot could not be read');
        if (reason !== null) this.log(`save slot ${e.slot} was not loaded: ${reason}`);
        this.carried.push(Object.freeze({ op: 'load' as const, slot: e.slot, ok: reason === null, ...(reason !== null ? { reason } : {}), ...(!e.ok && e.code !== undefined ? { code: e.code } : {}) }));
      }
    }
    if (this.settingsDirty) {
      this.settingsDirty = false;
      this.ready.push({ op: 'settings', values: Object.freeze({ ...this.settingsDoc }) });
    }
  }

  /** The requests since the last call (the host saves, loads, deletes and keeps the settings). */
  takeRequests(): SaveRequest[] {
    if (this.ready.length === 0) return [];
    const out = this.ready;
    this.ready = [];
    return out;
  }

  /**
   * A save the player asked for through the game shell, made now
   * (between steps: the state the last step left) and handed to the host with
   * the next requests. Null when it was made, else why not.
   */
  saveNow(slot: number, meta: SaveMeta): string | null {
    if (!this.slotOk(slot)) return `the game has no save slot ${String(slot)}`;
    for (const k of ['title', 'chapter', 'location'] as const) if (meta[k] !== undefined && !text(meta[k], SAVE_LIMITS.metaText)) return `the save's ${k} is at most ${SAVE_LIMITS.metaText} characters`;
    if (meta.meta !== undefined) {
      const p = saveSlotMetaProblem(meta.meta);
      if (p !== null) return `the save's ${p}`;
    }
    this.active = true;
    const built = this.assemble({ slot, meta: { title: String(meta.title ?? ''), chapter: String(meta.chapter ?? ''), location: String(meta.location ?? ''), thumbnail: meta.thumbnail === true, ...(meta.meta !== undefined && Object.keys(meta.meta).length > 0 ? { meta: { ...meta.meta } } : {}) } });
    if (typeof built === 'string') return built;
    this.ready.push(built);
    return null;
  }

  /** A new run (start, replay): no document, no play time, no pending work; the slot list and settings stay. */
  reset(): void {
    this.doc = null;
    this.docText = 'null';
    this.playBase = 0;
    this.playSteps = 0;
    this.visible = NO_RESULTS;
    this.carried = [];
    this.outbox = this.outbox.filter((r) => !('pending' in r));
    this.loads = [];
    this.migrations.clear();
  }

  /** The project settings document now. */
  settingsNow(): Readonly<Record<string, SettingsFieldValue>> {
    return this.settingsDoc;
  }

  /** The saves state as digest text (null for a project without a save schema or before anything happened). */
  digestText(): string | null {
    if (this.schema === null || !this.active) return null;
    const grid = this.schema.sections?.includes('grid') === true ? JSON.stringify(this.port.capture('grid')) : '';
    // The player's storage facts are input scripts may read; a game that never got them digests as before.
    const storage = this.storageInfo === STORAGE_UNKNOWN ? '' : `|${JSON.stringify(this.storageInfo)}`;
    return `${this.docText}|${this.playSeconds()}|${JSON.stringify(this.settingsDoc)}|${JSON.stringify(this.slotList)}|${JSON.stringify(this.visible)}|${grid}${storage}`;
  }

  private playSeconds(): number {
    return this.playBase + this.playSteps / this.hz;
  }

  private slotOk(slot: unknown): slot is number {
    return this.schema !== null && intIn(slot, 1, this.schema.slots);
  }

  private request(): boolean {
    if (this.requests >= SAVE_REQUESTS_PER_STEP) {
      this.log(`at most ${SAVE_REQUESTS_PER_STEP} save/load/delete requests per step; one was refused`);
      return false;
    }
    this.requests += 1;
    this.active = true;
    return true;
  }

  private assemble(p: PendingSave): SaveRequest | string {
    const schema = this.schema!;
    const sections: Partial<Record<SaveSection, unknown>> = {};
    for (const s of schema.sections ?? []) sections[s] = this.port.capture(s);
    const playSeconds = this.playSeconds();
    const file: ProjectSaveFile = {
      format: PROJECT_SAVE_FORMAT,
      formatVersion: PROJECT_SAVE_FORMAT_VERSION,
      version: schema.version,
      playSeconds,
      doc: this.doc,
      ...(Object.keys(sections).length > 0 ? { sections } : {}),
      world: this.port.captureWorld(),
    };
    const t = JSON.stringify(file);
    const bytes = utf8Length(t);
    if (bytes > SAVE_LIMITS.documentBytes) return `the save is ${bytes} bytes; a slot holds at most ${SAVE_LIMITS.documentBytes}`;
    return { op: 'save', slot: p.slot, meta: { ...p.meta, playSeconds, version: schema.version }, text: t };
  }

  /** Migrate and restore a loaded save (null: done; else why not — nothing changed). */
  private restore(file: ProjectSaveFile): string | null {
    const schema = this.schema!;
    const problem = projectSaveFileProblem(file, schema.version);
    if (problem !== null) return problem;
    let doc: unknown = JSON.parse(JSON.stringify(file.doc ?? null)) as unknown;
    for (let v = file.version; v < schema.version; v += 1) {
      const m = schema.migrations?.find((x) => x.from === v);
      if (m === undefined) return `the save schema has no migration from version ${v}`;
      const fn = this.migrations.get(m.name);
      if (fn === undefined) return `no script registered the migration "${m.name}" (ctx.saves.migration)`;
      let next: unknown;
      try {
        next = fn(doc, v);
      } catch (e) {
        return `migration "${m.name}" failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`;
      }
      const t = next === undefined ? null : jsonText(next);
      if (t === null) return `migration "${m.name}" returned no JSON document`;
      if (utf8Length(t) > SAVE_LIMITS.documentBytes) return `migration "${m.name}" made the document larger than ${SAVE_LIMITS.documentBytes} bytes`;
      doc = JSON.parse(t) as unknown;
    }
    const opted = schema.sections ?? [];
    const saved = file.sections ?? {};
    for (const s of opted) {
      if (s === 'grid' || saved[s] === undefined) continue;
      const p = this.port.check(s, saved[s]);
      if (p !== null) return `section ${s}: ${p}`;
    }
    if (file.world !== undefined) {
      const p = this.port.checkWorld(file.world);
      if (p !== null) return `world: ${p}`;
    }
    // The grid checks while it restores (atomically): first, so a refusal leaves everything as it was.
    if (opted.includes('grid')) {
      const p = this.port.apply('grid', saved.grid);
      if (p !== null) return `section grid: ${p}`;
    }
    for (const s of opted) {
      if (s === 'grid') continue;
      // A section restores what it can; what it had to leave out is a log line, never a failed load.
      const note = this.port.apply(s, saved[s]);
      if (note !== null) this.log(`section ${s}: ${note}`);
    }
    // Where the play stood (after the sections: a spawned copy's scene state is in).
    if (file.world !== undefined) this.port.applyWorld(file.world);
    this.doc = doc;
    this.docText = JSON.stringify(doc);
    this.playBase = file.playSeconds ?? 0;
    this.playSteps = 0;
    return null;
  }

  private buildApi(): BehaviorSaves {
    const r = this;
    return Object.freeze({
      get version(): number {
        return r.schema?.version ?? 0;
      },
      get slotCount(): number {
        return r.schema?.slots ?? 0;
      },
      write(doc: unknown): boolean {
        if (r.schema === null) return false;
        const t = jsonText(doc);
        if (t === null || utf8Length(t) > SAVE_LIMITS.documentBytes) return false;
        r.doc = JSON.parse(t) as unknown;
        r.docText = t;
        r.active = true;
        return true;
      },
      read(): unknown {
        return r.doc === null ? null : (JSON.parse(r.docText) as unknown);
      },
      save(slot: number, meta?: SaveMeta): boolean {
        if (!r.slotOk(slot)) return false;
        const m: SaveMeta = meta ?? {};
        if (typeof m !== 'object' || m === null || Array.isArray(m)) return false;
        for (const k of ['title', 'chapter', 'location'] as const) if (m[k] !== undefined && !text(m[k], SAVE_LIMITS.metaText)) return false;
        if (m.thumbnail !== undefined && typeof m.thumbnail !== 'boolean') return false;
        if (m.meta !== undefined && saveSlotMetaProblem(m.meta) !== null) return false;
        if (!r.request()) return false;
        r.outbox.push({ op: 'save', pending: { slot, meta: { title: String(m.title ?? ''), chapter: String(m.chapter ?? ''), location: String(m.location ?? ''), thumbnail: m.thumbnail === true, ...(m.meta !== undefined && Object.keys(m.meta).length > 0 ? { meta: { ...m.meta } } : {}) } } });
        return true;
      },
      load(slot: number): boolean {
        if (!r.slotOk(slot) || !r.request()) return false;
        r.outbox.push({ op: 'load', slot });
        return true;
      },
      delete(slot: number): boolean {
        if (!r.slotOk(slot) || !r.request()) return false;
        r.outbox.push({ op: 'delete', slot });
        return true;
      },
      slots: (): readonly SaveSlotInfo[] => r.slotList,
      ready: (): boolean => r.slotsReady,
      storage: (): SaveStorageInfo => r.storageInfo,
      results: (): readonly SaveResult[] => r.visible,
      playSeconds: (): number => r.playSeconds(),
      migration(name: string, migrate: (doc: unknown, fromVersion: number) => unknown): boolean {
        if (typeof name !== 'string' || !MIGRATION_NAME_RE.test(name) || typeof migrate !== 'function') return false;
        r.migrations.set(name, migrate);
        return true;
      },
      setting(key: string): boolean | number | string | null {
        return typeof key === 'string' && Object.prototype.hasOwnProperty.call(r.settingsDoc, key) ? r.settingsDoc[key]! : null;
      },
      settings: (): Record<string, boolean | number | string> => ({ ...r.settingsDoc }),
      setSetting(key: string, value: boolean | number | string): boolean {
        const f = r.schema?.settings?.find((x) => x.key === key);
        if (f === undefined || !settingsValueFits(effectiveField(f), value)) return false;
        if (r.settingsDoc[key] !== value) {
          r.settingsDoc = { ...r.settingsDoc, [key]: value };
          r.settingsDirty = true;
          r.active = true;
        }
        return true;
      },
    });
  }
}
