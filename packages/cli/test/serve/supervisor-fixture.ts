import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Exercises the real command adapter against a synthetic executable, never the host service manager. */
export function fakeSystemd(root: string, env: Record<string, string | undefined>): Record<string, string | undefined> {
  const bin = join(root, "synthetic-bin"); mkdirSync(bin, { mode: 0o700 });
  const state = join(root, "synthetic-service-state"); writeFileSync(state, "absent\n", { mode: 0o600 });
  writeFileSync(join(bin, "systemctl"), `#!/bin/sh
if [ "$TEST_SUPERVISOR_FAIL" = "$2" ]; then exit 1; fi
state="\${TEST_SUPERVISOR_STATE:-$(cat "$TEST_SUPERVISOR_FILE")}"
case "$2" in
  daemon-reload)
    if [ -n "$TEST_SUPERVISOR_CACHE" ]; then
      : > "$TEST_SUPERVISOR_CACHE"
      found=no
      for unit in "$TEST_SUPERVISOR_UNITS"/*.service; do
        if [ -f "$unit" ]; then cat "$unit" >> "$TEST_SUPERVISOR_CACHE"; found=yes; fi
      done
      if [ "$found" = no ] && [ "$state" != active ]; then printf 'absent\\n' > "$TEST_SUPERVISOR_FILE"; fi
    fi
    exit 0 ;;
  enable) printf 'enabled\\n' > "$TEST_SUPERVISOR_FILE"; exit 0 ;;
  restart) printf 'active\\n' > "$TEST_SUPERVISOR_FILE"; exit 0 ;;
  disable) printf 'disabled\\n' > "$TEST_SUPERVISOR_FILE"; exit 0 ;;
  is-enabled)
    case "$state" in
      active|enabled) printf 'enabled\\n'; exit 0 ;;
      masked) printf 'masked\\n'; exit 1 ;;
      disabled) printf 'disabled\\n'; exit 1 ;;
      *) printf 'not-found\\n'; exit 4 ;;
    esac ;;
  is-active)
    if [ -n "$TEST_SUPERVISOR_ACTIVITY" ]; then printf '%s\\n' "$TEST_SUPERVISOR_ACTIVITY"; exit "\${TEST_SUPERVISOR_ACTIVITY_EXIT:-3}"; fi
    if [ "$state" = active ]; then printf 'active\\n'; exit 0; fi
    printf 'inactive\\n'; exit 3 ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  return { ...env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, TEST_SUPERVISOR_FILE: state };
}
