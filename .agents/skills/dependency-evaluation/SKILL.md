---
name: dependency-evaluation
description: Evaluate whether Kizuki should add, replace, upgrade, or remove a dependency using necessity, maintenance, license, security, runtime cost, transitive surface, offline behavior, and exit strategy. Use before any package or toolchain dependency change.
---

# Dependency evaluation

## Default posture

Kizuki's core is deliberately lean. Do not add a dependency because it saves a
small amount of code. The burden of proof is on the addition.

## Evaluate

1. Run `orient-repository`.
2. Define the exact capability missing from the standard library or existing workspace.
3. Check current official package documentation, repository health, release cadence, maintenance ownership, license, notices, and security history.
4. Inspect runtime versus development use, transitive dependency count, native binaries, postinstall scripts, network behavior, platform support, and startup impact.
5. Compare build, adapt, optional-package, and dependency options.
6. Define how the dependency can later be removed or replaced.

Pin or range versions according to repository policy and reproducibility needs.
Do not introduce silent telemetry, update checks, network egress, opaque
credential handling, or a service dependency.

## Proof

After a change, regenerate the lockfile only through the repository toolchain,
review the complete manifest and lock diff, run frozen install, typecheck, tests,
policy gates, and any license or attribution checks. State material transitive
changes in the PR.
