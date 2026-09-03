import {
  SURFACE_CAPABILITIES,
  SURFACE_CONTRACT,
  SURFACE_CONTRACT_MINOR,
} from "../contracts/surface";
import type { SurfacePort, SurfaceRequest, SurfaceResponse } from "../contracts/surface";
import type { PortDescriptor } from "../contracts/ports";
import { inspectServeDoctor, type ServeDoctorOptions } from "./doctor";
import { runRail } from "./rails";
import type { RailHooks } from "./rails";
import { isRailId } from "./types";
import type { Database } from "bun:sqlite";

export const SERVE_SURFACE_ID = "kizuki.surface.cli";

const DESCRIPTOR: PortDescriptor = Object.freeze({
  id: SERVE_SURFACE_ID,
  kind: "surface",
  contract: SURFACE_CONTRACT,
  contract_minor: SURFACE_CONTRACT_MINOR,
  supports: SURFACE_CAPABILITIES.filter((item) => item === "request-response"),
  requires_lease: false,
  optional_package: null,
});

export interface ServeSurfaceOptions {
  readonly db: Database;
  readonly vaultPath: string;
  readonly hooks?: RailHooks;
  readonly doctor?: ServeDoctorOptions;
}

export function createServeSurfacePort(options: ServeSurfaceOptions): SurfacePort {
  return {
    descriptor: DESCRIPTOR,
    async health() {
      return { status: "ready", detail: { vault: "bound" } };
    },
    async close() {},
    async handle(request: SurfaceRequest): Promise<SurfaceResponse> {
      try {
        if (request.method === "doctor.report") {
          return {
            ok: true,
            value: inspectServeDoctor(options.db, options.vaultPath, options.doctor),
          };
        }
        if (request.method === "serve.run") {
          const rail = request.arguments["rail"];
          if (typeof rail !== "string" || !isRailId(rail)) {
            return {
              ok: false,
              error: { code: "config_invalid", message: "rail is required", retryable: false },
            };
          }
          const receipt = await runRail(options.db, options.vaultPath, rail, {
            ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
          });
          return { ok: true, value: receipt };
        }
        return {
          ok: false,
          error: { code: "not_supported", message: "unknown surface method", retryable: false },
        };
      } catch {
        return {
          ok: false,
          error: { code: "unavailable", message: "surface failed", retryable: true },
        };
      }
    },
  };
}
