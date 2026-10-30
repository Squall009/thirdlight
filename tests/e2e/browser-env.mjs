/**
 * The environment for the Chromium process. This LXC has no system browser
 * libraries, so Chromium's shared libraries come from an extracted tree
 * (TL_BROWSER_LIBS, defaulting to the one already on this host) plus two
 * no-op libavahi stubs that libcups references. Hosts with the libraries
 * installed (`npx playwright install-deps chromium`) need neither.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  const dir = join(tmpdir(), 'tl-browser-stubs');
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

const LIB_CANDIDATES = [
  process.env.TL_BROWSER_LIBS,
  '/home/dadmin/projects/visionary/.browser-libs/root/usr/lib/x86_64-linux-gnu',
].filter((p) => typeof p === 'string' && p.length > 0);

/** The extracted browser-library tree on this host (undefined where none is needed). */
export function browserLibs() {
  return LIB_CANDIDATES.find((p) => existsSync(p));
}

export function browserLaunchEnv() {
  const env = { ...process.env };
  const libs = LIB_CANDIDATES.find((p) => existsSync(p));
  if (libs === undefined) return env;
  const stubs = ensureStubLibs();
  env.LD_LIBRARY_PATH = [stubs, libs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return env;
}

/**
 * GPU rendering (owner: the gate runs on the host's GPU): true when
 * the DRM render node can be opened (the account needs the video/render
 * groups) and TL_E2E_SOFTWARE is not 1. Then Chromium draws WebGL 2 through
 * ANGLE on Vulkan and gets a real WebGPU adapter; otherwise SwiftShader (CPU).
 */
export function gpuAvailable() {
  if (process.env.TL_E2E_SOFTWARE === '1') return false;
  try {
    accessSync(process.env.TL_E2E_RENDER_NODE ?? '/dev/dri/renderD128', constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Hardware WebGL 2 (ANGLE on the Vulkan driver) and WebGPU on the same device. */
export const GPU_ARGS = ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-unsafe-webgpu'];
/** WebGL 2 through ANGLE on SwiftShader (hosts without a usable GPU). */
export const SOFTWARE_GL_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
/** Headless WebGPU on SwiftShader: without the Vulkan pair the device dies at first use. */
export const SOFTWARE_WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader'];
