import { inspectSourceGrant, listConnections, resumeSourceRevocation, revokeSourceGrant, setSourceGrant } from "@kizuki/core";
import { createOwnedRetrievalInventory, OwnedRetrievalInventoryError } from "../owned-retrieval-inventory";
import { parseArguments, UsageError } from "../args";
import { withVault } from "../context";
import { jsonEnvelope } from "../output";
import { CONSENT_OPTIONS, consentHint, expectedRevision, readSourcePolicy } from "../source-consent";
import type { CliIo } from "./index";

export async function runConnectConsent(io: CliIo, args: string[]): Promise<number> {
  const action = args[0];
  const options = action === "grant" ? ["--source", ...CONSENT_OPTIONS] :
    action === "revoke" ? ["--source", "--expected-revision", "--operation-id"] :
    action === "resume-revocation" ? ["--source", "--operation-id"] : ["--source"];
  const parsed = parseArguments(args.slice(1), { options, flags: ["--json"] });
  const source = parsed.options.get("--source");
  if (parsed.positionals.length !== 0 || source === undefined || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(source)) throw new UsageError("connect consent requires --source KEY");
  const operation = parsed.options.get("--operation-id");
  if (action !== "status" && (operation === undefined || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(operation) || operation.startsWith("complete:"))) throw new UsageError("--operation-id requires a unique identifier (1-128 ASCII letters, digits, _, ., :, -)");
  const revision = action === "grant" || action === "revoke" ? expectedRevision(parsed.options.get("--expected-revision")) : undefined;
  const file = parsed.options.get("--policy");
  if (action === "grant" && file === undefined) throw new UsageError("connect grant requires --policy FILE");
  const policy = file === undefined ? undefined : readSourcePolicy(file);
  return withVault(io, async (ctx) => {
    if (!listConnections(ctx.db).some((connection) => connection.source_key === source)) throw new Error("source_not_enrolled");
    let receipt;
    if (action === "grant") receipt = setSourceGrant(ctx.db, { source_key: source, expected_revision: revision!, operation_id: operation!, policy });
    if (action === "revoke") receipt = revokeSourceGrant(ctx.db, { source_key: source, expected_revision: revision!, operation_id: operation! });
    let maintenanceError: string | null = null;
    let grant = inspectSourceGrant(ctx.db, source);
    if (action === "resume-revocation") {
      if (grant === null || grant.revoke_operation !== operation) throw new Error("source_revocation_scope_mismatch");
      const inventory = createOwnedRetrievalInventory(ctx.vaultPath);
      try { grant = await resumeSourceRevocation(ctx.db, ctx.vaultPath, operation!, { ownedRetrieval: inventory }); }
      catch (error) {
        if (!(error instanceof OwnedRetrievalInventoryError)) throw error;
        maintenanceError = "owned_retrieval_inventory_unavailable";
        grant = inspectSourceGrant(ctx.db, source);
      } finally {
        try { await inventory.close(); } catch { maintenanceError = "owned_retrieval_shutdown_unavailable"; }
        maintenanceError = inventory.diagnostic() ?? maintenanceError;
      }
    }
    const purge = maintenanceError !== null ? "pending" : grant?.status === "purged" && grant.purge_blockers.length === 0 ? "complete" : grant?.status === "denied" ? "pending" : "not_requested";
    const pending = action === "resume-revocation" && (purge !== "complete" || maintenanceError !== null);
    if (parsed.flags.has("--json")) io.out(jsonEnvelope("connect", pending ? "degraded" : "ok", { source_key: source, receipt: receipt ?? null, grant, purge, maintenance_error: maintenanceError }));
    else {
      io.out(`source=${source} consent=${grant?.status ?? "required"} revision=${grant?.revision ?? 0} purge=${purge}`);
      if (maintenanceError !== null) io.out(maintenanceError);
      if (receipt !== undefined) io.out(`operation_id=${receipt.operation_id} receipt_revision=${receipt.revision}`);
      if (grant === null) io.out(consentHint(ctx.db, source));
      if (grant?.status === "denied") {
        io.out(`purge_blockers=${grant.purge_blockers.join(",") || "resume_required"}`);
        io.out(`Resume physical purge separately: kizuki connect resume-revocation --source ${source} --operation-id ${grant.revoke_operation}`);
      }
    }
    return pending ? 1 : 0;
  }, { retrieval: "none" });
}
