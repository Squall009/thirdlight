/**
 * The environment for the Chromium process. This LXC has no system browser
 * libraries, so Chromium's shared libraries come from an extracted tree
 * (TL_BROWSER_LIBS, defaulting to the one already on this host) plus two
 * no-op libavahi stubs that libcups references. Hosts with the libraries
 * installed (`npx playwright install-deps chromium`) need neither.
 */
import { existsSync } from 'node:fs';

import { ensureStubLibs } from '../evaluations/m3-browser/lib/stublibs.mjs';

const LIB_CANDIDATES = [
  process.env.TL_BROWSER_LIBS,
  '/home/dadmin/projects/visionary/.browser-libs/root/usr/lib/x86_64-linux-gnu',
].filter((p) => typeof p === 'string' && p.length > 0);

export function browserLaunchEnv() {
  const env = { ...process.env };
  const libs = LIB_CANDIDATES.find((p) => existsSync(p));
  if (libs === undefined) return env;
  const stubs = ensureStubLibs();
  env.LD_LIBRARY_PATH = [stubs, libs, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return env;
}
