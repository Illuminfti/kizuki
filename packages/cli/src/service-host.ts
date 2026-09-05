import { detectSupervisorKind, realSupervisorHost } from "@kizuki/core";
import { isAbsolute } from "node:path";
import { serveArgs } from "./runtime";

/** XDG config is a configuration root, never a substitute home directory. */
export function serveSupervisorHost(env: Record<string, string | undefined>, vaultPath: string) {
  const xdg = env.XDG_CONFIG_HOME;
  return realSupervisorHost(detectSupervisorKind(env), env.HOME ?? "", serveArgs(vaultPath), {
    ...(xdg && isAbsolute(xdg) ? { configHome: xdg } : {}),
  });
}
