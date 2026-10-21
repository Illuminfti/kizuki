import type { MassWithdrawalHold } from "@kizuki/core";
import { INVOCATION } from "./runtime";

/** The one command that releases a held mass withdrawal of exactly this size. */
export function withdrawalReleaseCommand(
  connectorId: string,
  sourceKey: string,
  hold: Pick<MassWithdrawalHold, "withdrawn">,
): string {
  const name = connectorId.startsWith("kizuki.") ? connectorId.slice("kizuki.".length) : connectorId;
  return `${INVOCATION} sync ${name} --source ${sourceKey} --confirm-withdrawals ${hold.withdrawn}`;
}

/** What a held pass means and what to do about it; counts only, never a path. */
export function withdrawalHoldLine(
  connectorId: string,
  sourceKey: string,
  hold: MassWithdrawalHold,
): string {
  return `${hold.state}: this sync would withdraw ${hold.withdrawn} of ${hold.total} records, so it withdrew none. ` +
    `If the source really lost them, release once with: ${withdrawalReleaseCommand(connectorId, sourceKey, hold)}. ` +
    `If the folder is unmounted or half restored, restore it and the next sync clears this.`;
}
