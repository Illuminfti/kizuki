/** Closed package identities. Adding a target requires execution on that native host. */
const TARGETS = [
  { target: "bun-linux-x64-baseline", platform: "linux", arch: "x64", description: "Linux x86_64 baseline CPUs", checksum_command: "sha256sum -c SHA256SUMS" },
  { target: "bun-darwin-arm64", platform: "darwin", arch: "arm64", description: "macOS Apple Silicon (arm64)", checksum_command: "shasum -a 256 -c SHA256SUMS" },
] as const;
export type ReleaseTarget = typeof TARGETS[number];
export function releaseTarget(value: string): ReleaseTarget {
  const target = TARGETS.find(target => target.target === value);
  if (!target) throw new Error("unsupported release target");
  return target;
}
export function nativeReleaseTarget(platform: string = process.platform, arch: string = process.arch): ReleaseTarget {
  const target = TARGETS.find(target => target.platform === platform && target.arch === arch);
  if (!target) throw new Error("unsupported native release host");
  return target;
}
export function requireNativeHost(target: ReleaseTarget, platform: string = process.platform, arch: string = process.arch): void {
  if (target.platform !== platform || target.arch !== arch) throw new Error("release host does not match target");
}
export function selectedReleaseTarget(): ReleaseTarget {
  const target = process.env.KIZUKI_TARGET === undefined ? nativeReleaseTarget() : releaseTarget(process.env.KIZUKI_TARGET);
  requireNativeHost(target);
  return target;
}
