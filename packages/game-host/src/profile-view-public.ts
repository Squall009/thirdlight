/**
 * The frame profile's views and capture file as their own public subpath
 * (`@thirdlight/game-host/profile-view`), so the editor's profiler panel
 * lays out, saves and opens a profile with the very code the Play/export
 * overlay uses. Pure data and code; the host composition stays behind `.`.
 */
export { makeProfileCapture, parseProfileCapture, rendererOf, profileCaptureFileName, profileCaptureText, ProfileAccumulator, PROFILE_CAPTURE_KIND, PROFILE_CAPTURE_VERSION, type ProfileCapture, type ProfileCaptureHeader, type ProfileCaptureSource } from './profile-capture';
export {
  profileBar,
  profileBreakdown,
  profileColumnAt,
  profileColumns,
  profileDigest,
  profileOfSpike,
  profileScaleMs,
  profileSpikeColumn,
  profileWorkers,
  PROFILE_CATEGORY_COLOURS,
  PROFILE_CATEGORY_LABELS,
  PROFILE_DIGEST_MAX_BYTES,
  PROFILE_LANE_LABELS,
  PROFILE_LANES,
  type ProfileBarSegment,
  type ProfileBreakdown,
  type ProfileColumn,
  type ProfileDigest,
  type ProfileLane,
  type ProfileLaneWork,
  type ProfileSpanRow,
} from './profile-view';
export type { ProfileBudgetRow, ProfileCursor, ProfileFrameCounters, ProfileReport, ProfileSpike, ProfileVoxels } from './page-profile';
