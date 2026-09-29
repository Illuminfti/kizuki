declare const KIZUKI_BUILD_SHA: string;
declare const KIZUKI_BUILD_TIME: string;

/**
 * Set only by the release compiler, like `KIZUKI_COMPILED`: a runtime
 * environment variable must not be able to change what a binary claims to be.
 * A source run defines neither and reports itself as `dev`.
 */
export interface BuildInfo {
  readonly sourceSha: string;
  readonly builtAt: string;
}

export const BUILD_INFO: BuildInfo | null =
  typeof KIZUKI_BUILD_SHA !== "undefined" && typeof KIZUKI_BUILD_TIME !== "undefined"
    ? { sourceSha: KIZUKI_BUILD_SHA, builtAt: KIZUKI_BUILD_TIME }
    : null;

/** `1.2.3 source=<sha> built=<rfc3339>` for a release build, `1.2.3 dev` otherwise. */
export function describeBuild(version: string, build: BuildInfo | null = BUILD_INFO): string {
  return build === null ? `${version} dev` : `${version} source=${build.sourceSha} built=${build.builtAt}`;
}
