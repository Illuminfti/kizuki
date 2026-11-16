# Ubuntu 26.04 drops the runner inotify limits

Recorded 2026-11-16.

`ubuntu-latest` is ubuntu-26.04. That image writes its inotify limits to
`/etc/sysctl.conf` and does not apply them at boot, so the runner user keeps
the kernel default of 128 instances. The test job must raise
`fs.inotify.max_user_instances` to 1280 and `fs.inotify.max_user_watches` to
655360 before verify, never lower a higher value, and fail if the new values
do not stick. Closing each test file's capacity-inventory descriptors is
already required by `CONTRIBUTING.md`. That close is not enough while the
cap stays at 128.

Why: once those 128 instances are gone, `inotify_init1` and `fs.watch` fail
with `EMFILE`. Thirteen tests failed that pass on ubuntu-24.04 (capacity
inventory, write scaling, embedded retrieval). After the per-file close, a
run still held a peak of 897 instances, which needs the restored cap.

Commits: `95691219`, `be40ac05` (2026-11-12), merged as #1147.
