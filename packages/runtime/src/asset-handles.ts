/**
 * Scripts' asset handles — `ctx.assets`.
 *
 * A script loads assets by an asset id, an address or a label (Unity's
 * Addressables `LoadAssetAsync` / `LoadAssetsAsync` by key or label) and gets
 * a handle; it releases the handle when it no longer needs them. The page
 * holds what a handle loaded in its resource manager until the release, so a
 * scene or a spawned object that uses them later draws at once.
 *
 * The simulation never waits on a load: a load is a request that leaves the
 * simulation after the step (`takeRequests`, like saves and sounds), and the
 * host's answer — ready with the ids it loaded, or failed with why — enters
 * as an entry of a later step's input frame (`ActionFrame.assets`). So a
 * recording replays the answer at the step it arrived, the simulation worker
 * applies it at that same step, and a run whose loads took longer or shorter
 * replays alike from its recording. Presentation (what is resident) stays out
 * of the simulation; a script reads only the handle's state.
 *
 * Handles are numbers, unique for the whole play (never reused, as effect and
 * timeline handles). A handle still open when its run ends (a restart, the
 * shell's new game) is released then and reported: its key goes to the
 * behavior log, and the host lists it in its report.
 *
 * No I/O, no three.js.
 */

/** A handle's state as a script reads it. */
export type AssetHandleState = 'loading' | 'ready' | 'failed';

/** Longest key a script may load by (an id, an address or a label; addresses are the longest names). */
export const ASSET_KEY_MAX_LENGTH = 256;
/** Longest id in an answer, and longest failure message kept. */
const ANSWER_ID_MAX_LENGTH = 256;
const ANSWER_MESSAGE_MAX_LENGTH = 256;
/**
 * Answers one input frame carries; more wait for the next frame (never
 * refused: a refused answer would leave its handle loading for good).
 */
export const MAX_FRAME_ASSET_ANSWERS = 64;

/** What the simulation asks of the host (in the order scripts asked). */
export type AssetHandleRequest =
  | { readonly op: 'load'; readonly handle: number; readonly key: string }
  /** `runEnded`: the handle was still open when its run ended (reported as not released). */
  | { readonly op: 'release'; readonly handle: number; readonly runEnded?: boolean };

/** The host's answer to one load: part of the input, so a recording replays it. */
export interface AssetHandleAnswer {
  readonly handle: number;
  readonly ok: boolean;
  /** The ids of the assets and resources the key named (ok only). */
  readonly assets?: readonly string[];
  /** Why the load failed (not ok only). */
  readonly message?: string;
}

/**
 * `ctx.assets` — load assets by id, address or label and let them go.
 * A load answers at once with a handle; the assets arrive while the game
 * plays (the simulation never waits) and the handle's state says when they
 * are ready. Release every handle you load: what it holds stays in memory
 * until then.
 */
export interface BehaviorAssets {
  /**
   * Start loading the asset or resource with this id or address, or every one with this label.
   * Returns the handle (0 when the key is not an id, an address or a label). The state is 'loading'
   * until the assets are ready, a later step.
   * @graphNode Load assets
   * @graphLabel key id, address or label
   */
  load(key: string): number;
  /**
   * Let go of what a handle loaded (a handle still loading is let go once it arrives). False for an unknown or released handle.
   * @graphNode Release assets
   */
  release(handle: number): boolean;
  /**
   * A handle's state: 'loading', 'ready', 'failed', or null for an unknown or released handle.
   * @graphPure
   * @graphNode Assets state
   */
  state(handle: number): AssetHandleState | null;
  /**
   * True once a handle's assets are loaded.
   * @graphPure
   * @graphNode Assets ready
   */
  ready(handle: number): boolean;
  /**
   * The ids a ready handle loaded (the assets and resources its key named, in id order); empty otherwise.
   * @graphNode skip a list of ids; read a known id with Assets ready
   */
  ids(handle: number): readonly string[];
  /**
   * Why a failed handle failed ('' otherwise).
   * @graphPure
   * @graphNode Assets error
   */
  error(handle: number): string;
}

interface OpenHandle {
  readonly key: string;
  state: AssetHandleState;
  ids: readonly string[];
  message: string;
}

const NO_IDS: readonly string[] = Object.freeze([]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const textIn = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

/** Validate a frame's `assets` entries (the host's answers). */
export function validateAssetAnswers(value: unknown): { ok: true; answers: readonly AssetHandleAnswer[] } | { ok: false; field: string; message: string } {
  if (!Array.isArray(value) || value.length > MAX_FRAME_ASSET_ANSWERS) return { ok: false, field: 'assets', message: `assets is a list of at most ${MAX_FRAME_ASSET_ANSWERS} answers` };
  const out: AssetHandleAnswer[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const e: unknown = value[i];
    const field = `assets/${i}`;
    if (!isObj(e) || typeof e['ok'] !== 'boolean' || typeof e['handle'] !== 'number' || !Number.isSafeInteger(e['handle']) || e['handle'] < 1) {
      return { ok: false, field, message: 'an assets answer is { handle (a positive integer), ok, assets? (ids), message? }' };
    }
    for (const k of Object.keys(e)) if (k !== 'handle' && k !== 'ok' && k !== 'assets' && k !== 'message') return { ok: false, field, message: `unknown assets answer field "${k.slice(0, 32)}"` };
    const ids = e['assets'];
    if (ids !== undefined && (!Array.isArray(ids) || !ids.every((id) => textIn(id, ANSWER_ID_MAX_LENGTH)))) return { ok: false, field, message: `assets lists ids (text of 1–${ANSWER_ID_MAX_LENGTH} characters)` };
    const message = e['message'];
    if (message !== undefined && (typeof message !== 'string' || message.length > ANSWER_MESSAGE_MAX_LENGTH)) return { ok: false, field, message: `message is text of at most ${ANSWER_MESSAGE_MAX_LENGTH} characters` };
    out.push(
      Object.freeze({
        handle: e['handle'],
        ok: e['ok'],
        ...(ids !== undefined ? { assets: Object.freeze([...(ids as string[])]) } : {}),
        ...(message !== undefined ? { message } : {}),
      }),
    );
  }
  return { ok: true, answers: Object.freeze(out) };
}

/** The runtime's side of `ctx.assets`: the open handles, the requests for the host, the answers from it. */
export class RuntimeAssetHandles {
  readonly api: BehaviorAssets;
  private serial = 0;
  private readonly open = new Map<number, OpenHandle>();
  private out: AssetHandleRequest[] = [];
  /** Anything happened (the digest includes the handles from then on). */
  private active = false;

  constructor(private readonly log: (message: string) => void) {
    this.api = this.buildApi();
  }

  /** This step's answers (applied before any script runs: a script sees ready in the step it arrived). */
  deliver(answers: readonly AssetHandleAnswer[] | undefined): void {
    if (answers === undefined) return;
    for (const a of answers) {
      const h = this.open.get(a.handle);
      // An answer for a released handle, or a second answer, changes nothing.
      if (h === undefined || h.state !== 'loading') continue;
      this.active = true;
      if (a.ok) {
        h.state = 'ready';
        h.ids = a.assets !== undefined && a.assets.length > 0 ? Object.freeze([...a.assets].sort()) : NO_IDS;
      } else {
        h.state = 'failed';
        h.message = a.message ?? 'the assets could not be loaded';
        this.log(`assets "${h.key}" (handle ${a.handle}) could not be loaded: ${h.message}`);
      }
    }
  }

  /** The requests since the last call (the host loads and releases). */
  takeRequests(): AssetHandleRequest[] {
    if (this.out.length === 0) return [];
    const r = this.out;
    this.out = [];
    return r;
  }

  /**
   * The run ends (a restart): every handle still open is released and
   * reported (the scripts that held them start over and know none of them).
   */
  endRun(): void {
    if (this.open.size === 0) return;
    const keys: string[] = [];
    for (const [handle, h] of this.open) {
      this.out.push(Object.freeze({ op: 'release' as const, handle, runEnded: true }));
      keys.push(`${handle} "${h.key}"`);
    }
    this.open.clear();
    this.log(`${keys.length} asset handle${keys.length === 1 ? ' was' : 's were'} not released when the run ended: ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', …' : ''}`);
  }

  /** The handles as digest text (null before any was used). */
  digestText(): string | null {
    if (!this.active) return null;
    let s = `${this.serial}`;
    for (const [handle, h] of this.open) s += `|${handle}:${h.state}:${h.ids.length}:${h.key}`;
    return s;
  }

  private buildApi(): BehaviorAssets {
    const get = (handle: unknown): OpenHandle | undefined => (typeof handle === 'number' ? this.open.get(handle) : undefined);
    return Object.freeze({
      load: (key: string): number => {
        if (!textIn(key, ASSET_KEY_MAX_LENGTH)) {
          this.log(`ctx.assets.load needs an asset id, an address or a label (text of 1–${ASSET_KEY_MAX_LENGTH} characters)`);
          return 0;
        }
        this.active = true;
        this.serial += 1;
        const handle = this.serial;
        this.open.set(handle, { key, state: 'loading', ids: NO_IDS, message: '' });
        this.out.push(Object.freeze({ op: 'load' as const, handle, key }));
        return handle;
      },
      release: (handle: number): boolean => {
        if (get(handle) === undefined) return false;
        this.open.delete(handle);
        this.out.push(Object.freeze({ op: 'release' as const, handle }));
        return true;
      },
      state: (handle: number): AssetHandleState | null => get(handle)?.state ?? null,
      ready: (handle: number): boolean => get(handle)?.state === 'ready',
      ids: (handle: number): readonly string[] => get(handle)?.ids ?? NO_IDS,
      error: (handle: number): string => get(handle)?.message ?? '',
    });
  }
}
