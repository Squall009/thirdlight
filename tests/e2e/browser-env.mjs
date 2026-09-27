/**
 * The environment for the Chromium process. This LXC has no system browser
 * libraries, so Chromium's shared libraries come from an extracted tree
 * (TL_BROWSER_LIBS, defaulting to the one already on this host) plus two
 * no-op libavahi stubs that libcups references. Hosts with the libraries
 * installed (`npx playwright install-deps chromium`) need neither.
 */
import { accessSync, constants, existsSync } from 'node:fs';

import { ensureStubLibs } from '../evaluations/m3-browser/lib/stublibs.mjs';

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
 * GPU rendering (2026-09-27, owner: the gate runs on the host's GPU): true when
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
/** Headless WebGPU on SwiftShader (17.0 spike): without the Vulkan pair the device dies at first use. */
export const SOFTWARE_WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-vulkan=swiftshader'];
