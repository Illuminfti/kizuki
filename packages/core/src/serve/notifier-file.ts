import { basename, dirname, join, relative, resolve } from "node:path";
import { PortError } from "../contracts/ports";
import { withMutationFilesSync } from "../vault/mutation-files";
import { assertVaultMutationScope, VaultMutationError, withVaultMutationSync, type VaultMutationScope, type VaultMutationTarget } from "../vault/mutation-scope";
import { assertCanonFiles, type CanonFiles } from "../vault/canon-files";
import { ulid } from "../util/ulid";
import {
  NOTIFIER_CAPABILITIES,
  NOTIFIER_CONTRACT,
  NOTIFIER_CONTRACT_MINOR,
} from "../contracts/notifier";
import type {
  Notification,
  NotificationReceipt,
  NotifierPort,
} from "../contracts/notifier";
import type { PortDescriptor } from "../contracts/ports";

export const FILE_NOTIFIER_ID = "kizuki.notifier.file";

const DESCRIPTOR: PortDescriptor = Object.freeze({
  id: FILE_NOTIFIER_ID,
  kind: "notifier",
  contract: NOTIFIER_CONTRACT,
  contract_minor: NOTIFIER_CONTRACT_MINOR,
  supports: NOTIFIER_CAPABILITIES,
  requires_lease: false,
  optional_package: null,
});

export function briefPath(vaultPath: string, day: string): string {
  return join(vaultPath, "dashboards", `brief-${day}.md`);
}

export function createFileNotifier(vaultPath: string): NotifierPort {
  const target = Object.freeze({ vault_path: resolve(vaultPath) });
  return {
    descriptor: DESCRIPTOR,
    async health() {
      return { status: "ready", detail: { destination: "dashboards/" } };
    },
    async close() {},
    async notify(notification: Notification): Promise<NotificationReceipt> {
      const { notification_id, title, body } = notification;
      try {
        return withVaultMutationSync(target, scope => withMutationFilesSync(scope, target, files =>
          notifyOwned(scope, target, files, { notification_id, title, body })));
      } catch (error) {
        if (error instanceof VaultMutationError && error.code === "writer_busy") {
          throw new PortError("unavailable", "canon writer is busy; retry notification", true);
        }
        throw error;
      }
    },
  };
}

function notifyOwned(
  scope: VaultMutationScope,
  target: VaultMutationTarget,
  files: CanonFiles,
  notification: Pick<Notification, "notification_id" | "title" | "body">,
): NotificationReceipt {
  assertVaultMutationScope(scope, target);
  assertCanonFiles(files, target.vault_path);
  const day = notification.notification_id.slice(0, 10);
  const path = notification.title.startsWith("brief:")
    ? briefPath(target.vault_path, day)
    : join(target.vault_path, "dashboards", `${notification.notification_id}.md`);
  const name = relative(target.vault_path, path).split("\\").join("/");
  files.ensureDirectory("dashboards");
  const prior = files.read(name);
  const bytes = Buffer.from(notification.body);
  if (prior === null) files.create(name, bytes).close();
  else {
    const temporary = `${dirname(name)}/.${basename(name)}.${ulid()}.tmp`;
    try {
      const created = files.create(temporary, bytes);
      try { files.replace(created, prior).close(); }
      catch (error) {
        try { files.remove(created); } catch { /* Preserve a changed temporary and the original failure. */ }
        throw error;
      }
      finally { created.close(); }
    } finally { prior.close(); }
  }
  return { notification_id: notification.notification_id, delivered_at: new Date().toISOString(), destination: "dashboards/", duplicate: false };
}
