/**
 * The shared leaf package: generic helpers with one definition each.
 *
 * Every package may import it and it imports nothing (no workspace package,
 * no third-party package, no Node built-in), so moving a helper here never
 * creates a dependency cycle or pulls I/O into a browser bundle. Domain
 * constants and formats stay in project-model; only algorithms that know
 * nothing about a project live here. `tools/check-redefinitions.mjs` names the
 * helpers this package owns and fails the build when one is defined again
 * elsewhere.
 */
export {};
