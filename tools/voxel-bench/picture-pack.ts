/**
 * The picture pack's files, from what the picture command took (pictures-cli.ts): `pictures.json` (each picture's
 * id, title, what to look for, file, settle state and capture facts), `README.md` (the same for a person) and the
 * skeleton of `read.md`, the agent's read in its fixed form (docs/pictures.md). Pure functions of the results, so
 * the forms are tested without a browser.
 *
 * A picture is failed when it could not be taken or did not settle (the run did not do its job: RED); what a
 * picture shows is never a failure here, it is the read's to say.
 */
import type { PictureEntry, PictureRun, WorldPicture } from './picture-list';

/** What one picture came to. */
export interface PictureResult {
  readonly id: string;
  /** The picture as taken (an absolute path before it is copied into the pack), or null: not taken. */
  readonly source: string | null;
  readonly settled: boolean;
  /** What was waited for and how long it took, or "did not settle: <what>", or "not taken: <why>". */
  readonly settle: string;
  /** The bench's speck count (white, green, black pixels and their clusters): recorded, never a pass or fail. */
  readonly specks: { readonly white: number; readonly green: number; readonly black: number; readonly clusters: number } | null;
  /** How it was taken: camera or screen, world, look, counts, times. */
  readonly facts: Readonly<Record<string, unknown>>;
}

/** The pack's name for a picture's file: its id with its number two digits wide (so a listing sorts as the list does), and its camera or screen. */
export function packFileName(p: PictureEntry, unsettled = false): string {
  const id = p.id.replace(/^([A-Z])(\d)$/, '$10$2');
  return `${id}-${p.kind === 'world' ? p.camera : p.screen}${unsettled ? '-UNSETTLED' : ''}.png`;
}

export const failed = (r: PictureResult): boolean => r.source === null || !r.settled;

/** The shot light-shots recorded for a camera (light-shots.json's `shots`), as far as the pack reads it. */
interface LightShot {
  readonly name: string;
  readonly file: string;
  readonly settledS: number | null;
  readonly waiting?: readonly string[];
  readonly texturesLoading?: number | null;
  readonly store?: string;
  readonly storeLitS?: number | null;
  readonly storeState?: { readonly kept?: number } | null;
  readonly sincePlayS?: number;
  readonly counts?: Record<string, number> | null;
  readonly problems?: readonly string[];
  readonly eye?: readonly number[];
  readonly yaw?: number;
  readonly pitch?: number;
  readonly preset?: string;
  readonly voxelShare?: number;
  readonly secondShare?: number;
  readonly blotch?: { readonly specks?: PictureResult['specks'] };
  readonly profile?: { readonly msPerFrame?: unknown } | null;
  /** The world's gas as drawn at the camera, and what the bench fog wrote (the fog cameras). */
  readonly gas?: unknown;
  readonly benchFog?: unknown;
}

/**
 * The world pictures of one light-shots run from its JSON (null: the run wrote none). Settled means streaming
 * settled (counts still, nothing pending, no texture level loading) and, with the light volume, its light settled.
 */
export function worldResults(pictures: readonly WorldPicture[], run: PictureRun, json: { readonly shots?: readonly LightShot[]; readonly error?: string; readonly world?: string; readonly quality?: string; readonly renderer?: string; readonly viewport?: unknown } | null, why: string): PictureResult[] {
  return pictures.filter((p) => p.run === run).map((p): PictureResult => {
    const s = json?.shots?.find((x) => x.name === p.camera);
    if (s === undefined) return { id: p.id, source: null, settled: false, settle: `not taken: ${json === null ? why : (json.error ?? 'the bench took no shot of this camera')}`, specks: null, facts: { camera: p.camera, run } };
    const waits: string[] = [];
    if (s.settledS === null) waits.push(`streaming (${(s.waiting ?? []).join(', ') || 'still moving'})`);
    if (s.store === 'volume' && (s.storeLitS ?? null) === null) waits.push('the light volume');
    const settle = waits.length > 0
      ? `did not settle: ${waits.join('; ')}`
      : `streaming still after ${s.settledS} s${s.texturesLoading === null || s.texturesLoading === undefined ? ' (texture loads not read)' : ', no texture level loading'}${s.store !== 'volume' ? `, lighting store ${s.store ?? 'unknown'}` : s.storeState?.kept === 0 ? `, the light volume keeps no brick in its windows (nothing to light) after ${s.storeLitS} s` : `, light volume settled after ${s.storeLitS} s`}`;
    return {
      id: p.id,
      source: s.file,
      settled: waits.length === 0,
      settle,
      specks: s.blotch?.specks ?? null,
      facts: {
        camera: p.camera,
        run,
        world: json?.world ?? null,
        quality: json?.quality ?? null,
        renderer: json?.renderer ?? null,
        viewport: json?.viewport ?? null,
        eye: s.eye ?? null,
        yaw: s.yaw ?? null,
        pitch: s.pitch ?? null,
        preset: s.preset ?? null,
        sincePlayS: s.sincePlayS ?? null,
        counts: s.counts ?? null,
        voxelShare: s.voxelShare ?? null,
        changedAfter1s: s.secondShare ?? null,
        msPerFrame: s.profile?.msPerFrame ?? null,
        ...(s.gas !== undefined ? { gas: s.gas, benchFog: s.benchFog ?? null } : {}),
        ...((s.problems ?? []).length > 0 ? { benchProblems: s.problems } : {}),
        // The bench failed after this shot was taken (its later steps): the picture stands, the failure is shown with it.
        ...(json?.error !== undefined ? { benchError: json.error } : {}),
      },
    };
  });
}

export interface PackMeta {
  readonly run: string;
  readonly commit: string;
  readonly startedAt: string;
  readonly seconds: number;
  readonly host: Readonly<Record<string, unknown>>;
  /** The performance report beside the pictures (its file in the pack), or why there is none. */
  readonly perf: string;
}

/** `pictures.json`: the list's entries with what each came to, in the list's order. */
export function packJson(list: readonly PictureEntry[], results: readonly PictureResult[], meta: PackMeta): Record<string, unknown> {
  const byId = new Map(results.map((r) => [r.id, r]));
  const pictures = list.map((p) => {
    const r = byId.get(p.id);
    return {
      id: p.id,
      title: p.title,
      look: p.look,
      kind: p.kind,
      file: r?.source === null || r === undefined ? null : packFileName(p, !r.settled),
      settled: r?.settled ?? false,
      settle: r?.settle ?? 'not taken: the command never reached it',
      specks: r?.specks ?? null,
      facts: r?.facts ?? {},
    };
  });
  return { ...meta, pictures, taken: pictures.filter((p) => p.file !== null).length, failed: pictures.filter((p) => p.file === null || !p.settled).map((p) => p.id) };
}

type PackPicture = { id: string; title: string; look: string; file: string | null; settled: boolean; settle: string; specks: PictureResult['specks'] };
const speckLine = (s: PictureResult['specks']): string => (s === null ? '' : ` Specks (white/green/black, clusters): ${s.white}/${s.green}/${s.black}, ${s.clusters}.`);

/** `README.md`: the pack for a person: each picture, what to look for, how it settled. */
export function packReadme(json: Record<string, unknown>): string {
  const pics = json['pictures'] as PackPicture[];
  const failedIds = json['failed'] as string[];
  return [
    `# Picture set ${String(json['run'])}`,
    '',
    `Commit ${String(json['commit'])}, taken ${String(json['startedAt'])} in ${String(json['seconds'])} s. ${pics.length} pictures, ${failedIds.length === 0 ? 'every one taken and settled' : `not taken or not settled: ${failedIds.join(', ')}`}. The agent's read: \`read.md\`. Performance: ${String(json['perf'])}.`,
    '',
    ...pics.map((p) => `- **${p.id} — ${p.title}** (${p.file ?? 'no file'}): ${p.look}. *${p.settle}.*${speckLine(p.specks)}`),
    '',
  ].join('\n');
}

/** The read's skeleton: the five-line summary and one block a picture, each line to be written by the agent who opens it. */
export function readSkeleton(json: Record<string, unknown>): string {
  const pics = json['pictures'] as PackPicture[];
  return [
    `# Read of picture set ${String(json['run'])}`,
    '',
    'Summary (five lines: how many pictures, how many with something wrong, the three things most worth the owner\'s eye):',
    '',
    '1. TO WRITE',
    '2. TO WRITE',
    '3. TO WRITE',
    '4. TO WRITE',
    '5. TO WRITE',
    '',
    ...pics.flatMap((p) => [
      `## ${p.id} — ${p.title}`,
      '',
      `File: ${p.file ?? 'none'} (${p.settle}).${speckLine(p.specks)} Look for: ${p.look}.`,
      '',
      'Sees: TO WRITE',
      'Wrong: TO WRITE',
      'Sure: TO WRITE',
      '',
    ]),
  ].join('\n');
}
