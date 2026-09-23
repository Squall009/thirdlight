/**
 * FBX import: headless Blender converts an FBX into a GLB, and the GLB then
 * goes through the ordinary import profile. The game only ever loads GLB; the
 * converted GLB is the asset version's stored bytes and the FBX is recorded as
 * its original (`convertedFrom`), so a changed FBX can be re-imported.
 *
 * One conversion runs at a time, in a scratch folder under the data root that
 * is removed afterwards; a conversion is killed after `timeoutMs`. The Blender
 * version is recorded with every conversion (it decides the output bytes).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Runs inside Blender: import the FBX, export one GLB (+Y up, animations kept). */
const CONVERT_SCRIPT = `import sys
import bpy

src, out = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)
if not any(o.type == "MESH" for o in bpy.data.objects):
    raise SystemExit("the FBX holds no mesh")
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_image_format="AUTO",
    export_yup=True,
    export_animations=True,
    export_cameras=False,
    export_lights=False,
    export_extras=False,
)
`;

/** `Kaydara FBX Binary  \\0` or an ASCII FBX (`; FBX` header comment). */
export function isFbx(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64));
  return head.startsWith('Kaydara FBX Binary') || /^\s*; FBX \d/.test(head);
}

export type ConvertResult =
  | { ok: true; glb: Uint8Array; blenderVersion: string }
  | { ok: false; code: 'converter_unavailable' | 'conversion_failed'; message: string };

export interface FbxConverter {
  /** Convert the FBX at `input.path` (its folder is searched for textures) or the given bytes. */
  convert(input: { path: string } | { bytes: Uint8Array }): Promise<ConvertResult>;
}

interface RunResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  spawnError?: string;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, output: '', timedOut: false, spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    const keep = (d: Buffer): void => {
      output = (output + d.toString()).slice(-8192);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, output, timedOut, spawnError: e.message });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

/** The last meaningful line of Blender's output (bounded, no host paths). */
function reason(output: string, workDir: string): string {
  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('Blender quit') && !l.startsWith('Read prefs'));
  const last = [...lines].reverse().find((l) => /error|exception|holds no mesh|cannot|failed/i.test(l)) ?? lines[lines.length - 1] ?? 'no output';
  return last.split(workDir).join('<work>').slice(0, 200);
}

export function createFbxConverter(opts: { blender: string; workRoot: string; timeoutMs?: number }): FbxConverter {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  let version: Promise<{ ok: true; version: string } | { ok: false; message: string }> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const blenderVersion = (): Promise<{ ok: true; version: string } | { ok: false; message: string }> => {
    version ??= run(opts.blender, ['--version'], 30_000).then((r) => {
      const m = /Blender (\d+\.\d+(?:\.\d+)?)/.exec(r.output);
      if (r.code === 0 && m !== null) return { ok: true as const, version: m[1] as string };
      version = null; // try again next time (Blender may be installed later)
      return { ok: false as const, message: r.spawnError !== undefined ? `cannot run ${opts.blender} (${r.spawnError})` : `${opts.blender} --version did not name a Blender version` };
    });
    return version;
  };

  const convertNow = async (input: { path: string } | { bytes: Uint8Array }): Promise<ConvertResult> => {
    const v = await blenderVersion();
    if (!v.ok) return { ok: false, code: 'converter_unavailable', message: `FBX import needs Blender: ${v.message}; set THIRDLIGHT_BLENDER` };
    if (!existsSync(opts.workRoot)) mkdirSync(opts.workRoot, { recursive: true, mode: 0o700 });
    const work = mkdtempSync(join(opts.workRoot, 'fbx-'));
    try {
      const script = join(work, 'convert.py');
      const out = join(work, 'out.glb');
      writeFileSync(script, CONVERT_SCRIPT);
      let src: string;
      if ('path' in input) src = input.path;
      else {
        src = join(work, 'in.fbx');
        writeFileSync(src, input.bytes);
      }
      const r = await run(opts.blender, ['-b', '--factory-startup', '-noaudio', '--python-exit-code', '1', '--python', script, '--', src, out], timeoutMs);
      if (r.timedOut) return { ok: false, code: 'conversion_failed', message: `Blender did not finish the FBX conversion within ${Math.round(timeoutMs / 1000)} s` };
      if (r.code !== 0 || !existsSync(out)) return { ok: false, code: 'conversion_failed', message: `Blender could not convert the FBX: ${reason(r.output, work)}` };
      return { ok: true, glb: new Uint8Array(readFileSync(out)), blenderVersion: v.version };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  return {
    convert(input) {
      const next = queue.then(() => convertNow(input));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
