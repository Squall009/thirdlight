/**
 * What a benched browser holds, read from outside it: the GPU process's
 * resident memory as its driver counts it, and the resident set of each of
 * the browser's processes. On an integrated GPU both come out of system
 * memory, so a game's total is the page's processes plus the GPU's.
 */
import { readdirSync, readFileSync } from 'node:fs';
import type { CDPSession } from '@playwright/test';

/** The GPU process's resident memory as its driver counts it (MiB, summed over its DRM fds). */
export function gpuResidentMiB(pid: number): number {
  let kib = 0;
  for (const fd of readdirSync(`/proc/${pid}/fdinfo`)) {
    let text = '';
    try {
      text = readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('drm-driver')) continue;
    for (const line of text.split('\n')) {
      const m = /^drm-resident-[\w-]+:\s+(\d+)\s*(KiB|MiB)?/.exec(line);
      if (m !== null) kib += Number(m[1]) * (m[2] === 'MiB' ? 1024 : 1);
    }
  }
  return Math.round(kib / 1024);
}

/** A process's resident set (MiB): the renderer's counts its workers (the simulation, the voxel jobs) beside the page. */
export function rssMiB(pid: number): number {
  return statusMiB(pid, /^VmRSS:\s+(\d+) kB/m, 'status');
}

/** A process's proportional set (MiB): shared pages split between the processes sharing them, so a tree's sum counts them once. */
export function pssMiB(pid: number): number {
  return statusMiB(pid, /^Pss:\s+(\d+) kB/m, 'smaps_rollup');
}

function statusMiB(pid: number, re: RegExp, file: string): number {
  try {
    const m = re.exec(readFileSync(`/proc/${pid}/${file}`, 'utf8'));
    return m === null ? 0 : Math.round(Number(m[1]) / 1024);
  } catch {
    return 0;
  }
}

export interface ProcessMemory {
  /** The GPU process's driver-resident memory (null: no GPU process). */
  gpuMiB: number | null;
  /** The renderer processes' resident sets summed (the page, its workers). */
  rendererRssMiB: number;
  gpuProcessRssMiB: number | null;
  /** Every process of the browser (browser, GPU, renderers, utilities): resident sets summed, and proportional sets summed. */
  treeRssMiB: number;
  treePssMiB: number;
}

/** The browser's processes' memory, through a browser-level CDP session. */
export async function processMemory(cdpBrowser: CDPSession): Promise<ProcessMemory> {
  const info = (await cdpBrowser.send('SystemInfo.getProcessInfo')) as { processInfo: Array<{ type: string; id: number }> };
  const gpu = info.processInfo.find((p) => p.type === 'GPU')?.id;
  const rendererRssMiB = info.processInfo.filter((p) => p.type === 'renderer').reduce((n, p) => n + rssMiB(p.id), 0);
  return {
    gpuMiB: gpu === undefined ? null : gpuResidentMiB(gpu),
    rendererRssMiB,
    gpuProcessRssMiB: gpu === undefined ? null : rssMiB(gpu),
    treeRssMiB: info.processInfo.reduce((n, p) => n + rssMiB(p.id), 0),
    treePssMiB: info.processInfo.reduce((n, p) => n + pssMiB(p.id), 0),
  };
}
