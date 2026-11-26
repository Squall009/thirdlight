/**
 * The preview's answer to the profiler panel's poll. It always fits the
 * bridge's bound for a profile answer: the page's rings on a busy world
 * (120 frames a thread, up to 128 spans each, and the kept long frames) are
 * larger than it, and a first read that the bridge refused left the panel
 * without a cursor, asking for everything again at every poll. A read over
 * the bound is cut to its newest frames, its spikes sent over the next
 * reads (game-host `fitProfileReport`).
 */
import { fitProfileReport, type ProfileReport } from '@thirdlight/game-host/profile-view';
import { BRIDGE_PROFILE_RESULT_MAX_BYTES } from '@thirdlight/protocol';

/** Characters of the answer's result kept for what stands beside the report (the build id, the renderer's name, the keys). */
const BESIDE_REPORT_BYTES = 1024;

/** The result of a `tl.profile.result` for a read of the page's profile, within `maxBytes` of JSON. */
export function profileAnswer(report: ProfileReport, build: string, renderer: string | null, maxBytes = BRIDGE_PROFILE_RESULT_MAX_BYTES): { report: ProfileReport; build: string; renderer: string | null } {
  return { report: fitProfileReport(report, maxBytes - BESIDE_REPORT_BYTES), build, renderer };
}
