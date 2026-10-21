import { assertPositiveAuthorityMutationAllowed } from "../canon/positive-authority";
import { recordNativeCorrectionEvent } from "../ledger/ledger";

/** A correction's capture belongs to the positive authority operation. The
 * native writer calls this guard in its immediate transaction after replay. */
export function recordNativeCorrection(
  db: Parameters<typeof recordNativeCorrectionEvent>[0],
  input: Parameters<typeof recordNativeCorrectionEvent>[1],
  requestDigest: string,
  beforeRecord?: () => void,
): ReturnType<typeof recordNativeCorrectionEvent> {
  return recordNativeCorrectionEvent(db, input, requestDigest, () => {
    beforeRecord?.();
    assertPositiveAuthorityMutationAllowed(db);
  });
}
