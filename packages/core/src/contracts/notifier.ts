import type { Sensitivity } from "../agents/types";
import type { Port } from "./ports";

export const NOTIFIER_CONTRACT = "kizuki.notifier/v1" as const;
export const NOTIFIER_CONTRACT_MINOR = 0;
export const NOTIFIER_CAPABILITIES = ["deliver"] as const;
export type NotifierCapability =
  (typeof NOTIFIER_CAPABILITIES)[number];

export interface Notification {
  readonly notification_id: string;
  readonly title: string;
  readonly body: string;
  readonly sensitivity: Sensitivity;
  readonly provenance: readonly string[];
}

export interface NotificationReceipt {
  readonly notification_id: string;
  readonly delivered_at: string;
  readonly destination: string;
  readonly duplicate: boolean;
}

export interface NotifierPort extends Port {
  notify(notification: Notification): Promise<NotificationReceipt>;
}
