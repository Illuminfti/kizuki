import { HealthReport, KizukiError, freezeManifest } from "@kizuki/core";
import { notSupported } from "./errors";
import type {
  CaptureEventInput,
  Connector,
  Manifest,
  SignInDisplay,
  SignInIo,
  ConnectionStateWriter,
} from "@kizuki/core";

const BASE_MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1",
  connector_id: "kizuki.conformance-fixture",
  version: "1",
  contract_minor: 1,
  implementation: "@kizuki/connectors/testkit",
  allowed_egress: [],
  cursor_schema: "kizuki.conformance-fixture.cursor/v1",
  kinds: ["message"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: false,
    purge: false,
    fixture: false,
  },
  required_secrets: [],
  emits_sensitivity_hint: false,
  default_sensitivity: "private",
  sensitivity_floor: "personal",
  auth_modes: ["none"],
});

const EVENT: CaptureEventInput = {
  schema: "kizuki.event/v1",
  connector_id: "kizuki.conformance-fixture",
  source_record_id: "fixture-1",
  kind: "message",
  occurred_at: "2026-01-01T00:00:00.000Z",
  observed_at: "2026-01-01T00:00:00.000Z",
  subjects: [],
  text: "fixture",
  sensitivity_hint: "private",
  deleted: false,
  attachments: [],
  metadata: {},
};

function base(overrides: Partial<Connector> = {}): Connector {
  return {
    manifest: () => ({ ...BASE_MANIFEST }),
    health: async () =>
      new HealthReport({
        state: "ok",
        checked_at: "2026-01-01T00:00:00.000Z",
      }),
    connect: async () => undefined,
    backfill: async () => ({ events: [EVENT], cursor: null }),
    sync: async () => ({ events: [], cursor: null }),
    revoke: async () => undefined,
    purgeSource: async () => notSupported("kizuki.conformance-fixture", "purge"),
    fixture: async () => notSupported("kizuki.conformance-fixture", "fixture"),
    ...overrides,
  };
}

/** Shared mutable manifest: consumers can rewrite policy at runtime. */
export function mutableManifestConnector(): Connector {
  const manifest: Manifest = {
    ...BASE_MANIFEST,
    kinds: ["message"],
    auth_modes: ["none"],
    capabilities: { ...BASE_MANIFEST.capabilities },
    required_secrets: [],
  };
  return base({ manifest: () => manifest });
}

/** Declares purge absent but returns an empty plan. */
export function dishonestPurgeConnector(): Connector {
  return base({
    purgeSource: async (subject_id) => ({
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    }),
  });
}

/** Missing source returns an empty page and advances the cursor. */
export function emptyOnUnavailableConnector(): Connector {
  return base({
    backfill: async () => ({ events: [], cursor: "advanced" }),
    health: async () =>
      new HealthReport({
        state: "ok",
        checked_at: "2026-01-01T00:00:00.000Z",
        detail: "nothing here",
      }),
  });
}

/** Health, sign-in, sync, revoke and purge never resolve. */
export function hangingConnector(): Connector {
  const hang = <T>() => new Promise<T>(() => {});
  return base({
    health: hang,
    backfill: hang,
    sync: hang,
    revoke: hang,
    purgeSource: hang,
    signIn: hang,
  });
}

/** Declares sign-in and answers a cancellable synthetic host. */
export function scriptedSignInConnector(): Connector {
  let revoked = false;
  return base({
    manifest: () =>
      freezeManifest({
        ...BASE_MANIFEST,
        cursor_schema: null,
        auth_modes: ["sign_in"],
      }),
    health: async () =>
      new HealthReport({
        state: revoked ? "unauthenticated" : "ok",
        checked_at: "2026-01-01T00:00:00.000Z",
      }),
    backfill: async () => {
      if (revoked) {
        throw new KizukiError("unauthenticated", "revoked", {
          retryable: false,
        });
      }
      return { events: [EVENT], cursor: null };
    },
    revoke: async () => {
      revoked = true;
    },
    async signIn(
      io: SignInIo,
      _state: ConnectionStateWriter,
    ): Promise<SignInDisplay> {
      io.notify("open the provider");
      await io.prompt("code:");
      return { display: "fixture" };
    },
  });
}

/** Events carry no label and the manifest declares no policy. */
export function unlabeledEventsConnector(): Connector {
  const unlabeled = { ...EVENT };
  delete unlabeled.sensitivity_hint;
  return base({
    manifest: () => {
      const manifest = { ...BASE_MANIFEST };
      delete manifest.default_sensitivity;
      delete manifest.sensitivity_floor;
      return manifest;
    },
    backfill: async () => ({ events: [unlabeled], cursor: null }),
  });
}
