/**
 * Phase 11: Play without the owner's browser.
 *
 * When MCP asks for a play (or a screenshot of one) and no editor browser is
 * connected to the project, the backend opens the editor itself in a headless
 * Chromium (`playwright-core`) on the public authoring origin, logged in with
 * the owner token and marked `headless=1`. The normal browser path then does
 * the rest (the play preview iframe, screenshots, input exercise, observe), so
 * a headless play behaves exactly like one in the owner's browser.
 *
 * A connected owner browser always wins: the headless editor never starts
 * while one is connected, and an owner browser that connects evicts it
 * (`session-routes` calls `evict`). An idle headless editor (no active play)
 * closes after `idleMs`.
 *
 * Hosts without system browser libraries (this LXC) set
 * THIRDLIGHT_BROWSER_LIBS to an extracted library tree; the two libavahi
 * SONAMEs libcups wants are compiled as no-op stubs into
 * `<dataRoot>/.browser-stubs` (gcc). WebGL runs on SwiftShader.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HeadlessConfig {
  /** false: never start a headless editor (THIRDLIGHT_HEADLESS=off). */
  enabled: boolean;
  /** An extracted system-library tree for Chromium (THIRDLIGHT_BROWSER_LIBS). */
  libs?: string;
  /** Close an idle headless editor after this long (ms). */
  idleMs: number;
}

export interface HeadlessDeps {
  config: HeadlessConfig;
  dataRoot: string;
  /** The URL of the editor page for a project (token in the fragment). */
  editorUrl: (projectId: string) => string;
  /** Whether a browser session for the project is connected now. */
  connected: (projectId: string) => boolean;
  /** Whether the project has an active play (keeps the headless editor open). */
  playing: (projectId: string) => boolean;
  log: (message: string) => void;
  now: () => number;
}

export interface HeadlessEditors {
  /** Make sure some editor browser is connected (start a headless one if needed). */
  ensure(projectId: string): Promise<{ ok: true; headless: boolean } | { ok: false; reason: string }>;
  /** Whether a project's connected editor is the headless one. */
  isHeadless(projectId: string): boolean;
  /** Close the headless editor of a project (the owner's browser takes over). */
  evict(projectId: string): Promise<void>;
  /** Projects with a headless editor open (diagnostics). */
  open(): string[];
  dispose(): Promise<void>;
}

interface Opened {
  browser: { close(): Promise<void> };
  lastUsed: number;
}

const CONNECT_TIMEOUT_MS = 30_000;
const SWIFTSHADER_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

const AVAHI_STUB_SOURCE = `
void *avahi_client_new(void*a,unsigned b,void*c,void*d,void*e){(void)a;(void)b;(void)c;(void)d;(void)e;return 0;}
void avahi_client_free(void*a){(void)a;}
void avahi_free(void*a){(void)a;}
void *avahi_record_browser_new(void*a,unsigned b,unsigned c,unsigned d,const char*e,unsigned f,void*g,void*h){(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;(void)g;(void)h;return 0;}
void avahi_record_browser_free(void*a){(void)a;}
void *avahi_service_browser_new(void*a,unsigned b,unsigned c,const char*d,const char*e,unsigned f,void*g,void*h){(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;(void)g;(void)h;return 0;}
void avahi_service_browser_free(void*a){(void)a;}
int avahi_service_name_join(char*a,unsigned long b,const char*c,const char*d){(void)a;(void)b;(void)c;(void)d;return -1;}
void *avahi_service_resolver_new(void*a,unsigned b,unsigned c,const char*d,const char*e,unsigned f,unsigned g,void*h,void*i){(void)a;(void)b;(void)c;(void)d;(void)e;(void)f;(void)g;(void)h;(void)i;return 0;}
void avahi_service_resolver_free(void*a){(void)a;}
void avahi_simple_poll_free(void*a){(void)a;}
void *avahi_simple_poll_get(void*a){(void)a;return 0;}
int avahi_simple_poll_iterate(void*a,int b){(void)a;(void)b;return -1;}
void *avahi_simple_poll_new(void){return 0;}
int avahi_simple_poll_quit(void*a){(void)a;return -1;}
int avahi_simple_poll_set_func(void*a,void*b,void*c){(void)a;(void)b;(void)c;return -1;}
void *avahi_string_list_find(void*a,const char*b){(void)a;(void)b;return 0;}
int avahi_string_list_get_pair(void*a,char**b,char**c,char**d){(void)a;(void)b;(void)c;(void)d;return -1;}
`;

/** The LD_LIBRARY_PATH entries for Chromium on a host without browser libraries. */
function libraryPath(dataRoot: string, libs: string | undefined, log: (m: string) => void): string | null {
  if (libs === undefined || !existsSync(libs)) return null;
  const stubs = join(dataRoot, '.browser-stubs');
  const so = join(stubs, 'libavahi-common.so.3');
  if (!existsSync(so)) {
    try {
      mkdirSync(stubs, { recursive: true });
      const source = join(stubs, 'avahi-stub.c');
      writeFileSync(source, AVAHI_STUB_SOURCE);
      execFileSync('gcc', ['-shared', '-fPIC', '-o', so, source], { stdio: 'pipe' });
      execFileSync('cp', [so, join(stubs, 'libavahi-client.so.3')], { stdio: 'pipe' });
    } catch (e) {
      log(`headless: could not build the libavahi stubs (${e instanceof Error ? e.message : String(e)}); trying without them`);
      return libs;
    }
  }
  return `${stubs}:${libs}`;
}

export function createHeadlessEditors(deps: HeadlessDeps): HeadlessEditors {
  const opened = new Map<string, Opened>();
  const starting = new Map<string, Promise<{ ok: true; headless: boolean } | { ok: false; reason: string }>>();
  let disposed = false;

  const close = async (projectId: string, why: string): Promise<void> => {
    const o = opened.get(projectId);
    if (o === undefined) return;
    opened.delete(projectId);
    deps.log(`headless: closing the editor of ${projectId} (${why})`);
    await o.browser.close().catch(() => undefined);
  };

  const sweep = setInterval(() => {
    for (const [projectId, o] of opened) {
      if (deps.playing(projectId)) {
        o.lastUsed = deps.now();
        continue;
      }
      if (deps.now() - o.lastUsed > deps.config.idleMs) void close(projectId, 'idle');
    }
  }, 15_000);
  sweep.unref?.();

  const start = async (projectId: string): Promise<{ ok: true; headless: boolean } | { ok: false; reason: string }> => {
    let pw: { chromium: { launch(o: Record<string, unknown>): Promise<{ newPage(o?: Record<string, unknown>): Promise<{ goto(u: string): Promise<unknown> }>; close(): Promise<void> }> } };
    try {
      pw = (await import('playwright-core')) as unknown as typeof pw;
    } catch {
      return { ok: false, reason: 'playwright-core is not installed next to the backend (npm ci in the engine checkout)' };
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
    const ld = libraryPath(deps.dataRoot, deps.config.libs, deps.log);
    if (ld !== null) env['LD_LIBRARY_PATH'] = [ld, env['LD_LIBRARY_PATH']].filter(Boolean).join(':');
    let browser: Awaited<ReturnType<typeof pw.chromium.launch>>;
    try {
      browser = await pw.chromium.launch({ headless: true, env, args: SWIFTSHADER_ARGS });
    } catch (e) {
      return { ok: false, reason: `Chromium did not start: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}` };
    }
    if (disposed) {
      await browser.close().catch(() => undefined);
      return { ok: false, reason: 'the backend is shutting down' };
    }
    opened.set(projectId, { browser, lastUsed: deps.now() });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.goto(deps.editorUrl(projectId));
    } catch (e) {
      await close(projectId, 'page failed');
      return { ok: false, reason: `the headless editor page did not load: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}` };
    }
    const deadline = deps.now() + CONNECT_TIMEOUT_MS;
    while (deps.now() < deadline) {
      if (deps.connected(projectId)) {
        deps.log(`headless: editor connected for ${projectId}`);
        return { ok: true, headless: true };
      }
      if (!opened.has(projectId)) return { ok: false, reason: 'the headless editor was closed while starting' };
      await new Promise((r) => setTimeout(r, 200));
    }
    await close(projectId, 'no connection');
    return { ok: false, reason: 'the headless editor did not connect in time' };
  };

  return {
    async ensure(projectId) {
      if (deps.connected(projectId)) {
        const o = opened.get(projectId);
        if (o !== undefined) o.lastUsed = deps.now();
        return { ok: true, headless: o !== undefined };
      }
      if (!deps.config.enabled) return { ok: false, reason: 'headless play is switched off (THIRDLIGHT_HEADLESS=off)' };
      // A headless editor that lost its connection is restarted cleanly.
      if (opened.has(projectId)) await close(projectId, 'disconnected');
      let p = starting.get(projectId);
      if (p === undefined) {
        p = start(projectId).finally(() => starting.delete(projectId));
        starting.set(projectId, p);
      }
      return p;
    },
    isHeadless(projectId) {
      return opened.has(projectId);
    },
    evict(projectId) {
      return close(projectId, 'the owner\'s browser connected');
    },
    open() {
      return [...opened.keys()];
    },
    async dispose() {
      disposed = true;
      clearInterval(sweep);
      await Promise.all([...opened.keys()].map((id) => close(id, 'backend closing')));
    },
  };
}
