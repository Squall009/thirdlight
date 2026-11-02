/**
 * Upgrade steps of the voxel byte formats. A format's readers read only
 * its current version; bytes of an older version are lifted one version at
 * a time through registered steps first, so a new version adds a step and
 * never drops the readers of the old bytes (no file needs rewriting). A
 * version newer than the reader's is refused: it may hold what this build
 * cannot know about.
 */

/** Lifts a value of version `from` to `from + 1`. */
export interface UpgradeStep<T> {
  readonly from: number;
  lift(value: T): T;
}

/**
 * `value` (of `version`) lifted to `current` through `steps`. `versionOf`
 * reads the version a lifted value declares, so a step that does not land
 * on the next version is caught. Throws a RangeError naming `what`.
 */
export function liftVersion<T>(what: string, version: number, current: number, steps: readonly UpgradeStep<T>[], value: T, versionOf: (v: T) => number): T {
  if (version > current) throw new RangeError(`${what}: version ${version} is newer than this build reads (${current})`);
  let v = value;
  for (let at = version; at < current; at++) {
    const step = steps.find((s) => s.from === at);
    if (step === undefined) throw new RangeError(`${what}: version ${at} has no upgrade step (this build reads ${current})`);
    v = step.lift(v);
    if (versionOf(v) !== at + 1) throw new RangeError(`${what}: the upgrade step from version ${at} gave version ${versionOf(v)}`);
  }
  return v;
}
