import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
  return {
    descriptor: DESCRIPTOR,
    async health() {
      return { status: "ready", detail: { destination: "dashboards/" } };
    },
    async close() {},
    async notify(notification: Notification): Promise<NotificationReceipt> {
      const day = notification.notification_id.slice(0, 10);
      const path = notification.title.startsWith("brief:")
        ? briefPath(vaultPath, day)
        : join(vaultPath, "dashboards", `${notification.notification_id}.md`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, notification.body, { mode: 0o600 });
      return {
        notification_id: notification.notification_id,
        delivered_at: new Date().toISOString(),
        destination: "dashboards/",
        duplicate: false,
      };
    },
  };
}
