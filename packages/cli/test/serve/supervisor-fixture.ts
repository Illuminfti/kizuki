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
  daemon-reload) exit 0 ;;
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
    if [ "$state" = active ]; then printf 'active\\n'; exit 0; fi
    printf 'inactive\\n'; exit 3 ;;
  *) exit 1 ;;
esac
`, { mode: 0o700 });
  return { ...env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, TEST_SUPERVISOR_FILE: state };
}
