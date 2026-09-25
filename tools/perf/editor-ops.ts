/**
 * Phase 21.4: editor and backend costs beyond the Scene view — measured on an
 * open editor page (the harness's `measureEditor`), renderer-independent, so
 * once per class:
 *
 * - the Hierarchy: rows in the DOM, click-to-Inspector latency, rename (a
 *   real backend round trip until the row shows the new name), and frame
 *   intervals while the list scrolls;
 * - command round trips (HTTP, the one mutation path) with what each costs
 *   after the response: the delay until the editor's second animation frame
 *   after the `mutation.applied` arrived (projection, React, Scene view sync),
 *   long tasks, WebSocket bytes per change, and bytes/files the backend
 *   writes per command (file stat diff of the project folder, and the
 *   process's /proc write counter);
 * - one material edit (the `setMaterials` change on the wire).
 *
 * In-page steps are timed with performance.now in the page (no Playwright
 * round trip in the number).
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Page } from '@playwright/test';

import type { PerfBackend, ProjectClient } from './backend';
import { summarize, type Summary } from './stats';

export interface EditorOpsResult {
  hierarchy: { domRows: number; entities: number; selectMs: Summary; renameMs: Summary; scrollFrameMs: Summary; scrollStepMs: Summary };
  command: {
    httpMs: Summary;
    /** From the `mutation.applied` arrival to the editor's second animation frame after it. */
    applyFrameMs: Summary;
    /** Long-task milliseconds per command while the loop ran. */
    longTaskMsPerCommand: number;
    wsBytesPerCommand: number;
    /** Whole-file bytes the backend (re)wrote per command (project folder stat diff). */
    bytesWrittenPerCommand: number;
    filesWrittenPerCommand: number;
    /** /proc/<pid>/io wchar per command (every write syscall: files, sockets, logs). */
    wcharPerCommand: number | null;
  };
  material: { wsBytes: number; httpMs: number } | null;
  ws: Record<string, { n: number; bytes: number; max: number }>;
  notes: string[];
}

interface FileStamp {
  ino: number;
  size: number;
  mtimeMs: number;
}

function stampTree(root: string): Map<string, FileStamp> {
  const out = new Map<string, FileStamp>();
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(dir, n);
      try {
        const st = lstatSync(p);
        if (st.isDirectory()) walk(p);
        else if (st.isFile()) out.set(p, { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
        /* removed while walking */
      }
    }
  };
  walk(root);
  return out;
}

function diffTree(before: Map<string, FileStamp>, after: Map<string, FileStamp>): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  for (const [p, a] of after) {
    const b = before.get(p);
    if (b !== undefined && b.ino === a.ino && b.size === a.size && b.mtimeMs === a.mtimeMs) continue;
    bytes += a.size;
    files += 1;
  }
  return { bytes, files };
}

function wchar(pid: number): number | null {
  try {
    const m = /wchar:\s*(\d+)/.exec(readFileSync(`/proc/${pid}/io`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

/** Select rows in the Hierarchy (in the page) and time each until the Inspector shows the entity. */
async function timeSelect(page: Page, picks: number): Promise<number[]> {
  return page.evaluate(async (picks) => {
    const out: number[] = [];
    // Rows near the top of the list (a Scene-view pick may have scrolled it), each scrolled into
    // view before it is timed; a windowed list renders new rows on its scroll event (next frame).
    const list = document.querySelector<HTMLElement>('.tl-hierarchy__list')!;
    const frames = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    list.scrollTop = 0;
    await frames();
    const pick = async (index: number): Promise<HTMLElement | null> => {
      const all = [...list.querySelectorAll<HTMLElement>('li[data-entity-id]')];
      if (all.length === 0) return null;
      const id = all[Math.min(all.length - 1, index)]!.dataset['entityId']!;
      list.querySelector<HTMLElement>(`li[data-entity-id="${id}"]`)!.scrollIntoView({ block: 'nearest' });
      await frames();
      return list.querySelector<HTMLElement>(`li[data-entity-id="${id}"]`);
    };
    for (let i = 0; i < picks; i += 1) {
      const row = await pick(2 + i * 2);
      if (row === null) break;
      const id = row.dataset['entityId']!;
      const name = row.querySelector('.tl-row__name')?.textContent ?? '';
      const t0 = performance.now();
      row.click();
      // Polled between tasks (not frames): the main-thread cost until the DOM shows the selection,
      // independent of how long the Scene view's frame takes on this CPU-rendered host.
      const channel = new MessageChannel();
      await new Promise<void>((done, fail) => {
        const until = t0 + 20_000;
        channel.port1.onmessage = (): void => {
          const input = document.querySelector<HTMLInputElement>('.tl-inspector__name');
          const sel = document.querySelector(`.tl-hierarchy__list li[data-entity-id="${id}"].is-selected`);
          if (input !== null && input.value === name && sel !== null) return done();
          if (performance.now() > until) return fail(new Error(`selecting ${id} ("${name}") never reached the Inspector (it shows "${input?.value ?? 'nothing'}", row selected: ${sel !== null}, row in the DOM: ${row.isConnected})`));
          setTimeout(() => channel.port2.postMessage(0), 1);
        };
        channel.port2.postMessage(0);
      });
      channel.port1.close();
      out.push(performance.now() - t0);
    }
    return out;
  }, picks);
}

/** Rename rows through the Hierarchy (double-click, type, Enter) until each row shows its new name. */
async function timeRename(page: Page, count: number): Promise<number[]> {
  return page.evaluate(async (count) => {
    const out: number[] = [];
    const setValue = (input: HTMLInputElement, v: string): void => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const waitFor = <T>(fn: () => T | null, what: string | (() => string), ms = 30_000): Promise<T> =>
      new Promise((done, fail) => {
        const until = performance.now() + ms;
        const check = (): void => {
          const v = fn();
          if (v !== null) return done(v);
          if (performance.now() > until) return fail(new Error(`timed out: ${typeof what === 'string' ? what : what()}`));
          setTimeout(check, 1);
        };
        check();
      });
    const list = document.querySelector<HTMLElement>('.tl-hierarchy__list')!;
    const frames = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    list.scrollTop = 0;
    await frames();
    for (let i = 0; i < count; i += 1) {
      const all = [...list.querySelectorAll<HTMLElement>('li[data-entity-id]')];
      const id = all[Math.min(all.length - 1, 3 + i)]!.dataset['entityId']!;
      list.querySelector<HTMLElement>(`li[data-entity-id="${id}"]`)!.scrollIntoView({ block: 'nearest' });
      await frames();
      const row = list.querySelector<HTMLElement>(`li[data-entity-id="${id}"]`)!;
      const next = `${row.querySelector('.tl-row__name')?.textContent ?? id} r${i}`;
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      const input = await waitFor(() => document.querySelector<HTMLInputElement>(`.tl-hierarchy__list li[data-entity-id="${id}"] input.tl-row__rename`), 'the rename field');
      setValue(input, next);
      const t0 = performance.now();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await waitFor(() => (document.querySelector(`.tl-hierarchy__list li[data-entity-id="${id}"] .tl-row__name`)?.textContent === next ? true : null), () => `the renamed row ${id} (wanted "${next}", shows "${document.querySelector(`.tl-hierarchy__list li[data-entity-id="${id}"] .tl-row__name`)?.textContent ?? 'no row'}", status "${document.querySelector('.tl-statusbar')?.textContent?.slice(0, 120) ?? ''}")`);
      out.push(performance.now() - t0);
    }
    return out;
  }, count);
}

/**
 * Scroll the Hierarchy list: `frames` = animation-frame intervals while it
 * scrolls one step per frame (what a user sees, Scene view frames included);
 * `steps` = main-thread time per scroll step (the scroll handling and the
 * list's re-render until the next task runs).
 */
async function timeScroll(page: Page, ms: number): Promise<{ frames: number[]; steps: number[] }> {
  return page.evaluate(async (ms) => {
    const list = document.querySelector<HTMLElement>('.tl-hierarchy__list');
    if (list === null) return { frames: [], steps: [] };
    const next = (): void => {
      const max = list.scrollHeight - list.clientHeight;
      list.scrollTop = list.scrollTop + 240 > max ? 0 : list.scrollTop + 240;
    };
    const frames: number[] = [];
    await new Promise<void>((done) => {
      let last: number | null = null;
      const t0 = performance.now();
      const step = (t: number): void => {
        if (last !== null) frames.push(t - last);
        last = t;
        next();
        if (performance.now() - t0 < ms) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    const steps: number[] = [];
    const task = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i += 1) {
      await task();
      const a = performance.now();
      next();
      // The browser's own scroll event waits for the next frame: dispatch one now, then wait for the work it scheduled.
      list.dispatchEvent(new Event('scroll'));
      await task();
      await task();
      steps.push(performance.now() - a);
    }
    list.scrollTop = 0;
    return { frames, steps };
  }, ms);
}

async function readWs(page: Page): Promise<{ byType: Record<string, { n: number; bytes: number; max: number }>; appliedFrame: number[]; longTasks: [number, number][]; now: number }> {
  return page.evaluate(() => {
    const P = (window as unknown as { __tlPerf: { ws: { byType: Record<string, { n: number; bytes: number; max: number }>; appliedFrame: number[] }; longTasks: [number, number][] } }).__tlPerf;
    return { byType: JSON.parse(JSON.stringify(P.ws.byType)), appliedFrame: P.ws.appliedFrame.slice(), longTasks: P.longTasks.slice(), now: performance.now() };
  });
}

const wsBytesOf = (w: Record<string, { bytes: number }>, type: string): number => w[type]?.bytes ?? 0;

export async function measureEditorOps(
  page: Page,
  be: PerfBackend,
  p: ProjectClient,
  opts: { commands: number; entityId: string; projectDir: string; scrollMs: number },
): Promise<EditorOpsResult> {
  const notes: string[] = [];
  const domRows = await page.locator('.tl-hierarchy__list li[data-entity-id]').count();
  const entities = Number(((await p.query('queryProject'))['scenes'] as { entityCount: number }[] | undefined)?.reduce((a, s) => a + s.entityCount, 0) ?? 0);
  const selectMs = await timeSelect(page, 5);
  const renameMs = await timeRename(page, 3).catch((e: Error) => {
    notes.push(`rename: ${e.message}`);
    return [] as number[];
  });
  const scroll = await timeScroll(page, opts.scrollMs);

  // Commands: the first few with write accounting (a stat walk between them), then the timed loop.
  const q = await p.query('queryEntity', { entityId: opts.entityId });
  const pos = ((q['entity'] as { components: { transform: { position: number[] } } } | undefined)?.components.transform.position ?? [0, 0, 0]).slice();
  const move = (i: number): Promise<Record<string, unknown>> => p.command('setTransform', { entityId: opts.entityId, transform: { position: [pos[0]! + (i % 2 === 0 ? 0.25 : 0), pos[1]!, pos[2]!] } });
  await p.revision();
  const writes: { bytes: number; files: number }[] = [];
  const wchars: number[] = [];
  for (let i = 0; i < 5; i += 1) {
    const before = stampTree(opts.projectDir);
    const w0 = wchar(be.pid);
    await move(i);
    const w1 = wchar(be.pid);
    writes.push(diffTree(before, stampTree(opts.projectDir)));
    if (w0 !== null && w1 !== null) wchars.push(w1 - w0);
  }
  // Let the editor settle, then the timed loop with its page-side costs.
  await page.waitForTimeout(500);
  const ws0 = await readWs(page);
  const http: number[] = [];
  for (let i = 0; i < opts.commands; i += 1) {
    const a = performance.now();
    await move(i + 1);
    http.push(performance.now() - a);
  }
  // The last change's frame lands after the loop: wait for it (bounded).
  const until = Date.now() + 30_000;
  let ws1 = await readWs(page);
  while (ws1.appliedFrame.length < ws0.appliedFrame.length + opts.commands && Date.now() < until) {
    await page.waitForTimeout(100);
    ws1 = await readWs(page);
  }
  const applied = ws1.appliedFrame.slice(ws0.appliedFrame.length);
  if (applied.length < opts.commands) notes.push(`only ${applied.length} of ${opts.commands} mutation.applied frames seen`);
  const longMs = ws1.longTasks.filter(([s]) => s >= ws0.now).reduce((a, [, d]) => a + d, 0);
  const wsBytes = wsBytesOf(ws1.byType, 'mutation.applied') - wsBytesOf(ws0.byType, 'mutation.applied');

  // One material edit: what a `setMaterial` puts on the wire.
  let material: EditorOpsResult['material'] = null;
  const mats = ((await p.query('queryGameConfig'))['materials'] ?? []) as Record<string, unknown>[];
  const first = mats[0];
  if (first !== undefined) {
    const m0 = await readWs(page);
    const a = performance.now();
    const params = (first['params'] ?? {}) as Record<string, unknown>;
    const roughness = typeof params['roughness'] === 'number' && params['roughness'] > 0.5 ? 0.25 : 0.75;
    const res = await p.command('setMaterial', { material: { ...first, params: { ...params, roughness } } }).catch((e: Error) => {
      notes.push(`setMaterial: ${e.message.slice(0, 200)}`);
      return null;
    });
    const httpMs = performance.now() - a;
    if (res !== null) {
      const seen = m0.byType['mutation.applied']?.n ?? 0;
      let m1 = await readWs(page);
      for (const until = Date.now() + 30_000; (m1.byType['mutation.applied']?.n ?? 0) <= seen && Date.now() < until; m1 = await readWs(page)) await page.waitForTimeout(100);
      material = { wsBytes: wsBytesOf(m1.byType, 'mutation.applied') - wsBytesOf(m0.byType, 'mutation.applied'), httpMs: r1(httpMs) };
    }
  } else notes.push('no materials: the material edit was skipped');

  const n = Math.max(1, opts.commands);
  return {
    hierarchy: { domRows, entities, selectMs: summarize(selectMs), renameMs: summarize(renameMs), scrollFrameMs: summarize(scroll.frames), scrollStepMs: summarize(scroll.steps) },
    command: {
      httpMs: summarize(http),
      applyFrameMs: summarize(applied),
      longTaskMsPerCommand: r1(longMs / n),
      wsBytesPerCommand: Math.round(wsBytes / n),
      bytesWrittenPerCommand: Math.round(writes.reduce((s, w) => s + w.bytes, 0) / Math.max(1, writes.length)),
      filesWrittenPerCommand: r1(writes.reduce((s, w) => s + w.files, 0) / Math.max(1, writes.length)),
      wcharPerCommand: wchars.length > 0 ? Math.round(wchars.reduce((a, b) => a + b, 0) / wchars.length) : null,
    },
    material,
    ws: ws1.byType,
    notes,
  };
}
