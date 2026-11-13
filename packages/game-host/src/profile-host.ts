/**
 * A capture file of this page's profile with what the host knows of the run
 * in its header: the game's build and the renderer that drew it.
 */
import { pageProfile } from './page-profile';
import { makeProfileCapture, rendererOf, type ProfileCapture } from './profile-capture';

/** The page's profile now as a capture (the editor's Play page and an export alike: the build names which). */
export function profileCapture(buildId: string, adapter: () => { diagnostics?(): unknown } | null): ProfileCapture {
  // An exported game's page is its own top-level page; Play runs inside the editor's frame.
  const source = (globalThis as { self?: unknown; top?: unknown }).self !== (globalThis as { top?: unknown }).top ? 'play' : 'export';
  return makeProfileCapture(pageProfile.read(), { build: buildId, renderer: rendererOf(adapter()), source });
}
