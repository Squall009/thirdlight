/**
 * Packet 38 — local browser bootstrap for the container.
 *
 * There is NO browser installed on this host and no display. A real Chrome for
 * Testing binary and a pre-existing hand-extracted system-library tree are
 * present in the user's caches (they belong to other projects on this machine,
 * not to Thirdlight). Two libraries that Chrome's `libcups.so.2` references
 * (`libavahi-common.so.3`, `libavahi-client.so.3`) are absent from that tree;
 * this module compiles no-op stubs for exactly those two SONAMEs into a temp
 * directory so the loader can resolve them. Printing/CUPS is never exercised in
 * headless mode.
 *
 * NOTHING is installed: no root, no apt, no system file is created or modified.
 * Both paths are overridable by env var so an owner desktop with real browsers
 * (or `npx playwright install-deps`) can run the same probes:
 *
 *   TL_CHROME_PATH    absolute path to a Chrome/Chromium binary
 *   TL_BROWSER_LIBS   directory prepended to LD_LIBRARY_PATH
 *
 * If neither exists, `resolveBrowser()` returns null and every caller must
 * record UNVERIFIED rather than pretend a browser ran.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_CHROME_CANDIDATES = [
  process.env['TL_CHROME_PATH'],
  '/home/dadmin/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  '/home/dadmin/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p) => typeof p === 'string');

const DEFAULT_LIBS = [
  process.env['TL_BROWSER_LIBS'],
  '/home/dadmin/projects/visionary/.browser-libs/root/usr/lib/x86_64-linux-gnu',
].filter((p) => typeof p === 'string');

/** The two stubbed SONAMEs and the symbols `libcups.so.2` needs from them. */
const AVAHI_STUB_SOURCE = `
/* No-op stubs for the libavahi symbol names referenced by libcups.so.2.
   Used only so the local Chromium binary loads in a container that has no
   system libavahi; CUPS discovery/printing is never exercised headlessly. */
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

/** Build (once) and return the stub directory, or null when gcc is unavailable. */
export function ensureStubLibs() {
  const dir = join(tmpdir(), 'tl-m3-browser-stubs');
  const so = join(dir, 'libavahi-common.so.3');
  if (existsSync(so)) return dir;
  try {
    mkdirSync(dir, { recursive: true });
    const source = join(dir, 'avahi-stub.c');
    writeFileSync(source, AVAHI_STUB_SOURCE);
    execFileSync('gcc', ['-shared', '-fPIC', '-o', so, source], { stdio: 'pipe' });
    writeFileSync(join(dir, 'libavahi-client.so.3'), '');
    // libavahi-client.so.3 must be a real ELF; copy the compiled one.
    execFileSync('cp', [so, join(dir, 'libavahi-client.so.3')], { stdio: 'pipe' });
    return dir;
  } catch {
    return null;
  }
}

/** @returns {{chrome:string, libs:string|null, stubs:string|null}|null} */
export function resolveBrowser() {
  const chrome = DEFAULT_CHROME_CANDIDATES.find((p) => existsSync(p));
  if (chrome === undefined) return null;
  const libs = DEFAULT_LIBS.find((p) => existsSync(p)) ?? null;
  const stubs = libs === null ? null : ensureStubLibs();
  return { chrome, libs, stubs };
}

export function browserEnvironment(resolved) {
  const parts = [resolved.stubs, resolved.libs].filter((p) => typeof p === 'string');
  const env = { ...process.env };
  if (parts.length > 0) {
    env['LD_LIBRARY_PATH'] = [...parts, env['LD_LIBRARY_PATH'] ?? ''].filter(Boolean).join(':');
  }
  return env;
}
