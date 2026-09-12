import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve(import.meta.dir, "bring-up-compose.sh");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const dockerStub = `#!/usr/bin/env bash
set -euo pipefail
STATE="\${DOCKER_STUB_STATE:?}"
log() { printf '%s\\n' "$*" >> "\$STATE/commands.log"; }
log "\$*"

has_volume_destroy() {
  for arg in "\$@"; do
    case "\$arg" in
      -v|--volumes) return 0 ;;
    esac
  done
  return 1
}

container_file() { printf '%s/containers/%s' "\$STATE" "\$1"; }

list_ids() {
  local name="" all=0 running_only=0
  while [ \$# -gt 0 ]; do
    case "\$1" in
      -aq|-qa) all=1 ;;
      -q) ;;
      --filter)
        shift
        case "\${1:-}" in
          name=*) name="\${1#name=}" ;;
          status=running) running_only=1 ;;
        esac
        ;;
    esac
    shift || true
  done
  [ -n "\$name" ] || return 0
  local file
  file="\$(container_file "\$name")"
  [ -f "\$file" ] || return 0
  if [ "\$running_only" = "1" ] && [ "\$all" = "0" ]; then
    grep -q '^running=1$' "\$file" || return 0
  fi
  printf '%s\\n' "\$name"
}

create_stack() {
  local secretless=0
  if [ -f "\$STATE/force_secretless_once" ]; then
    secretless=1
    rm -f "\$STATE/force_secretless_once"
  fi
  mkdir -p "\$STATE/containers"
  for name in deploy-tailscale-1 deploy-kizuki-1; do
    if [ -f "\$(container_file "\$name")" ]; then
      echo "Error response from daemon: Conflict. The container name \\"/\$name\\" is already in use" >&2
      exit 1
    fi
    {
      echo "running=1"
      echo "secretless=\$secretless"
      echo "compose_owned=1"
    } > "\$(container_file "\$name")"
  done
}

# Resume leftovers are dockerd's, not compose's. \`compose down\` must not
# be enough on its own — the helper has to take the names.
remove_compose_owned() {
  local name file
  for name in deploy-tailscale-1 deploy-kizuki-1; do
    file="\$(container_file "\$name")"
    [ -f "\$file" ] || continue
    grep -q '^compose_owned=1$' "\$file" && rm -f "\$file"
  done
}

cmd="\${1:-}"
shift || true
case "\$cmd" in
  info) exit 0 ;;
  compose)
    sub="\${1:-}"
    shift || true
    case "\$sub" in
      down)
        if has_volume_destroy "\$@"; then
          echo "down-destroyed-volumes" > "\$STATE/volume_destroy"
          echo "bring-up-compose must not pass -v/--volumes to compose down" >&2
          exit 1
        fi
        remove_compose_owned
        exit 0
        ;;
      up)
        create_stack
        exit 0
        ;;
      *)
        echo "docker stub: unsupported compose \${sub}" >&2
        exit 1
        ;;
    esac
    ;;
  ps) list_ids "\$@" ;;
  rm)
    while [ \$# -gt 0 ]; do
      case "\$1" in
        -f|--force) ;;
        *) rm -f "\$(container_file "\$1")" ;;
      esac
      shift
    done
    ;;
  logs)
    file="\$(container_file "\${1:-}")"
    [ -f "\$file" ] || exit 1
    if grep -q '^secretless=1$' "\$file"; then
      echo "tailscale entrypoint: missing secret file /run/secrets/ts_authkey" >&2
    fi
    ;;
  inspect)
    name=""
    while [ \$# -gt 0 ]; do
      case "\$1" in
        -f|--format) shift ;;
        *) name="\$1" ;;
      esac
      shift || true
    done
    file="\$(container_file "\$name")"
    [ -f "\$file" ] || exit 1
    if grep -q '^secretless=1$' "\$file"; then
      exit 0
    fi
    printf '%s\\n' "/run/secrets/ts_authkey"
    ;;
  *)
    echo "docker stub: unsupported \$cmd" >&2
    exit 1
    ;;
esac
`;

function fixture(opts?: { secret?: "present" | "missing" | "empty" | "unset"; leftoverSecretless?: boolean; firstUpSecretless?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-compose-resume-"));
  roots.push(root);
  const state = join(root, "stub");
  const bin = join(root, "bin");
  const project = join(root, "deploy");
  mkdirSync(join(state, "containers"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(bin, "docker"), dockerStub);
  chmodSync(join(bin, "docker"), 0o755);
  const secretPath = join(root, "ts-authkey");
  const secret = opts?.secret ?? "present";
  if (secret === "present") writeFileSync(secretPath, "synthetic-compose-secret\n");
  if (secret === "empty") writeFileSync(secretPath, "");
  if (opts?.leftoverSecretless) {
    writeFileSync(join(state, "containers", "deploy-tailscale-1"), "running=1\nsecretless=1\ncompose_owned=0\n");
    writeFileSync(join(state, "containers", "deploy-kizuki-1"), "running=1\nsecretless=0\ncompose_owned=0\n");
  }
  if (opts?.firstUpSecretless) writeFileSync(join(state, "force_secretless_once"), "1\n");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "KIZUKI_TS_AUTHKEY_FILE") env[key] = value;
  }
  env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  env.DOCKER_STUB_STATE = state;
  env.COMPOSE_PROJECT_NAME = "deploy";
  if (secret !== "unset") env.KIZUKI_TS_AUTHKEY_FILE = secretPath;
  function run() {
    return Bun.spawnSync(["bash", script], {
      cwd: project,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
  }
  function commands() {
    const log = join(state, "commands.log");
    try {
      return readFileSync(log, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  }
  function container(name: string) {
    try {
      return readFileSync(join(state, "containers", name), "utf8");
    } catch {
      return "";
    }
  }
  return { run, commands, container, state, secretPath };
}

function firstCompose(commands: string[], sub: "down" | "up"): number {
  return commands.findIndex((line) => line.split(/\s+/).includes("compose") && line.split(/\s+/).includes(sub));
}

test("refuses before any compose up when the secret file is missing", () => {
  const f = fixture({ secret: "missing" });
  const result = f.run();
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain("secret file is not readable");
  expect(f.commands().some((line) => line.includes("compose up"))).toBe(false);
});

test("refuses an empty or unset secret file before create", () => {
  const empty = fixture({ secret: "empty" });
  expect(empty.run().exitCode).not.toBe(0);
  expect(empty.commands().some((line) => line.includes("compose up"))).toBe(false);
  const unset = fixture({ secret: "unset" });
  const unsetResult = unset.run();
  expect(unsetResult.exitCode).not.toBe(0);
  expect(unsetResult.stderr.toString()).toContain("KIZUKI_TS_AUTHKEY_FILE is unset");
  expect(unset.commands().some((line) => line.includes("compose up"))).toBe(false);
});

test("reconciles with compose down without -v before the first up", () => {
  const f = fixture();
  const result = f.run();
  expect(result.exitCode).toBe(0);
  const commands = f.commands();
  const down = firstCompose(commands, "down");
  const up = firstCompose(commands, "up");
  expect(down).toBeGreaterThanOrEqual(0);
  expect(up).toBeGreaterThan(down);
  expect(commands[down]).toContain("down --remove-orphans");
  expect(commands.some((line) => /\s(-v|--volumes)\b/.test(line))).toBe(false);
  expect(f.container("deploy-tailscale-1")).toContain("secretless=0");
  expect(f.container("deploy-kizuki-1")).toContain("running=1");
});

test("a secretless leftover is removed before create rather than retried against", () => {
  const f = fixture({ leftoverSecretless: true });
  const result = f.run();
  expect(result.exitCode).toBe(0);
  const commands = f.commands();
  expect(commands.some((line) => line.includes("Conflict"))).toBe(false);
  const down = firstCompose(commands, "down");
  const up = firstCompose(commands, "up");
  const rm = commands.findIndex((line) => line.startsWith("rm "));
  expect(down).toBeGreaterThanOrEqual(0);
  expect(rm).toBeGreaterThanOrEqual(0);
  expect(up).toBeGreaterThan(rm);
  expect(f.container("deploy-tailscale-1")).toContain("secretless=0");
});

test("a container that starts without its secret is replaced", () => {
  const f = fixture({ firstUpSecretless: true });
  const result = f.run();
  expect(result.exitCode).toBe(0);
  const commands = f.commands();
  const ups = commands.filter((line) => line.split(/\s+/).includes("compose") && line.split(/\s+/).includes("up"));
  expect(ups.length).toBe(2);
  const firstUp = firstCompose(commands, "up");
  const secondDown = commands.findIndex((line, i) => i > firstUp && line.split(/\s+/).includes("compose") && line.split(/\s+/).includes("down"));
  const secondUp = commands.findIndex((line, i) => i > firstUp && line.split(/\s+/).includes("compose") && line.split(/\s+/).includes("up"));
  expect(secondDown).toBeGreaterThan(firstUp);
  expect(secondUp).toBeGreaterThan(secondDown);
  expect(f.container("deploy-tailscale-1")).toContain("secretless=0");
  expect(f.container("deploy-tailscale-1")).not.toContain("secretless=1");
});

test("ten consecutive leftover-then-bring-up cycles stay healthy with the secret", () => {
  for (let cycle = 1; cycle <= 10; cycle++) {
    const f = fixture({ leftoverSecretless: true });
    const result = f.run();
    expect(result.exitCode, `cycle ${cycle}: ${result.stderr.toString()}`).toBe(0);
    expect(f.commands().some((line) => /\s(-v|--volumes)\b/.test(line))).toBe(false);
    expect(f.container("deploy-tailscale-1")).toContain("secretless=0");
    expect(f.container("deploy-kizuki-1")).toContain("running=1");
  }
});
