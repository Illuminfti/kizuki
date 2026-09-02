import type { Port } from "./ports";

export const SURFACE_CONTRACT = "kizuki.surface/v1" as const;
export const SURFACE_CONTRACT_MINOR = 0;
export const SURFACE_CAPABILITIES = [
  "request-response",
  "streaming",
] as const;
export type SurfaceCapability =
  (typeof SURFACE_CAPABILITIES)[number];

export interface SurfacePrincipal {
  readonly principal_id: string;
  readonly kind: "owner" | "agent";
}

export interface SurfaceRequest {
  readonly request_id: string;
  readonly principal: SurfacePrincipal;
  readonly method: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly deadline_ms: number;
}

export type SurfaceResponse =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly retryable: boolean;
      };
    };

export interface SurfacePort extends Port {
  handle(request: SurfaceRequest): Promise<SurfaceResponse>;
}
