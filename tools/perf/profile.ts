/**
 * The page's main thread split by package: a CDP CPU profile's self time,
 * attributed to the source module each sample's line belongs to. An
 * unminified esbuild bundle marks every module with a `// <path>` line
 * (`// packages/three-adapter/src/batching.ts`,
 * `// node_modules/three/build/three.webgpu.js`); a page that loads its
 * files one by one (the plain three.js page) is attributed by its URL path.
 */
import type { CDPSession } from '@playwright/test';

export interface ProfileSplit {
  /** Profiled wall time and the part of it the main thread was busy (ms). */
  totalMs: number;
  busyMs: number;
  /** Busy time by package: `three`, `@thirdlight/<package>`, `native` (GPU API calls, GC, the browser's own work), … */
  packages: { name: string; ms: number; share: number }[];
  /** The heaviest functions (self time). */
  top: { fn: string; module: string; ms: number; share: number }[];
}

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
}

/** Lines that start a module in an unminified esbuild bundle. */
const MODULE_LINE = /^\s{0,4}\/\/ ((?:node_modules|packages|tools|tests)\/\S+)$/;

/** The module starts of one bundle: sorted line numbers (1-based) and the module path at each. */
export function moduleIndex(source: string): { lines: number[]; paths: string[] } {
  const lines: number[] = [];
  const paths: string[] = [];
  source.split('\n').forEach((text, i) => {
    const m = MODULE_LINE.exec(text);
    if (m !== null) {
      lines.push(i + 1);
      paths.push(m[1]!);
    }
  });
  return { lines, paths };
}

/** The package a module path or a file belongs to. */
export function packageOf(module: string): string {
  if (module === '' || module === '(native)') return 'native';
  const nm = /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(module);
  if (nm !== null) return nm[1] === 'three' ? 'three' : nm[1]!;
  const pk = /^packages\/([^/]+)\//.exec(module);
  if (pk !== null) return `@thirdlight/${pk[1]}`;
  const file = module.split('/').pop() ?? module;
  if (/^three\.(webgpu|core|tsl|module)(\.min)?\.js$/.test(file) || /(^|\/)three\/(build|examples|src)\//.test(module)) return 'three';
  return file;
}

/**
 * Profile the page's main thread for `ms` and split its self time by package.
 * `sourceOf(url)` gives a script's text (null: attribute it to its file name).
 */
export async function profileSplit(cdp: CDPSession, ms: number, sourceOf: (url: string) => string | null, top = 25): Promise<ProfileSplit> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  await new Promise((r) => setTimeout(r, ms));
  const { profile } = (await cdp.send('Profiler.stop')) as unknown as { profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] } };
  await cdp.send('Profiler.disable');
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const indexes = new Map<string, ReturnType<typeof moduleIndex> | null>();
  const moduleAt = (url: string, line: number): string => {
    if (url === '') return '(native)';
    let idx = indexes.get(url);
    if (idx === undefined) {
      const src = sourceOf(url);
      idx = src === null ? null : moduleIndex(src);
      if (idx !== null && idx.lines.length === 0) idx = null;
      indexes.set(url, idx);
    }
    // Without module marks: the URL's path (three's own files keep their `three/…` path).
    if (idx === null) return url.split('?')[0]!.replace(/^[a-z]+:\/\/[^/]+/, '');
    // The last module start at or before the line.
    let lo = 0;
    let hi = idx.lines.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (idx.lines[mid]! <= line) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return k >= 0 ? idx.paths[k]! : url.split('/').pop()!;
  };
  let total = 0;
  let idle = 0;
  const fns = new Map<string, { module: string; ms: number }>();
  const pkgs = new Map<string, number>();
  for (let i = 0; i < profile.samples.length; i += 1) {
    const dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    const n = byId.get(profile.samples[i]!);
    if (n === undefined) continue;
    total += dt;
    const name = n.callFrame.functionName || '(anonymous)';
    if (name === '(idle)') {
      idle += dt;
      continue;
    }
    const module = moduleAt(n.callFrame.url, n.callFrame.lineNumber + 1);
    const key = `${name} ${module}`;
    const f = fns.get(key) ?? { module, ms: 0 };
    f.ms += dt;
    fns.set(key, f);
    const pkg = packageOf(module);
    pkgs.set(pkg, (pkgs.get(pkg) ?? 0) + dt);
  }
  const busy = total - idle;
  const r1 = (v: number): number => Math.round(v * 10) / 10;
  const share = (v: number): number => (busy > 0 ? Math.round((v / busy) * 1000) / 10 : 0);
  return {
    totalMs: r1(total),
    busyMs: r1(busy),
    packages: [...pkgs.entries()].sort((a, b) => b[1] - a[1]).map(([name, v]) => ({ name, ms: r1(v), share: share(v) })),
    top: [...fns.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, top).map(([fn, v]) => ({ fn: fn.slice(0, fn.length - v.module.length - 1), module: v.module, ms: r1(v.ms), share: share(v.ms) })),
  };
}
