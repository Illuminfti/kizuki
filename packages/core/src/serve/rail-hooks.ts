import type { ClaimsIo } from "../claims/store";
import type { ProducerPort } from "../contracts/producer";
import type { ProducerV2Port } from "../contracts/producer-v2";

export interface RailSyncResult {
  readonly events_synced: number;
  readonly events_stored: number;
  readonly events_duplicate: number;
  readonly events_self_skipped: number;
  readonly errors: readonly string[];
}

/** One bounded derived catch-up pass reported back to the rail. */
export interface RailRefreshReport {
  /** Derived records this pass brought current. */
  readonly indexed: number;
  /** Records still behind afterwards. Zero only when derived state is current. */
  readonly remaining: number;
  readonly degraded: readonly string[];
}

interface RailHooksBase {
  readonly sync?: () => Promise<RailSyncResult>;
  /** Host-owned derived stores refresh after a successful or partial write pass. */
  readonly refresh?: () => Promise<RailRefreshReport>;
  readonly claims?: ClaimsIo;
  readonly model_ref?: string | null;
  readonly embedding_backlog?: number;
  /**
   * True when the vault configures an embedding port. The host sets it from
   * the same configuration `kizuki doctor` reads, so the sweep judges
   * `embed-backfill` by the rule the report does.
   */
  readonly embedding_configured?: boolean;
}

export interface RailHooks extends RailHooksBase {
  readonly producer?: ProducerPort;
}

export interface RailHooksV2 extends RailHooksBase {
  /** The runtime selects v1 for epoch-zero journals and v2 for managed sources. */
  readonly producer?: ProducerPort | ProducerV2Port;
}

export type AnyRailHooks = RailHooks | RailHooksV2;

/** One host binding, owned and released by exactly one rail attempt. */
export interface RailRuntime {
  readonly hooks: RailHooks;
  close(): Promise<void>;
}

export interface RailRuntimeV2 {
  readonly hooks: RailHooksV2;
  close(): Promise<void>;
}
