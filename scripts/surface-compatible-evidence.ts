/** Evaluate a separate candidate only when the loaded surface implementation,
 * producer and observed documentation are byte-identical to that candidate. */
import { realpathSync } from "node:fs";
import {
  CAPABILITY_PROOF_FILE, EVALUATOR_ROOT, SURFACE_OBSERVED_FILES,
  absolute, assertProductCheckoutCustody, consumeSurfaceReceipt, digest,
  evaluateSurfaceReceipt, expectedSurfaceInventory, reject,
} from "./release-evidence";

export function consumeCompatibleSurfaceReceipt(value: unknown, candidateRoot: string, candidateSha: string) {
  const root = realpathSync(absolute(candidateRoot));
  if (root !== candidateRoot) reject("candidate-root-alias");
  if (root === EVALUATOR_ROOT) return consumeSurfaceReceipt(value, root, candidateSha);
  const head = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", "-C", EVALUATOR_ROOT, "rev-parse", "HEAD"],
    { stdout: "pipe", stderr: "pipe", timeout: 10_000 });
  if (head.exitCode !== 0) reject("candidate-checkout-unreadable");
  const entrypoints = [CAPABILITY_PROOF_FILE];
  const candidate = assertProductCheckoutCustody(root, candidateSha, entrypoints, SURFACE_OBSERVED_FILES);
  const reviewed = assertProductCheckoutCustody(EVALUATOR_ROOT, digest(head.stdout.toString().trim(), 40), entrypoints, SURFACE_OBSERVED_FILES);
  const projection = (frame: typeof candidate) => frame.files.map(({ path, mode, sha256 }) => ({ path, mode, sha256 }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(projection(candidate)) !== JSON.stringify(projection(reviewed))) reject("surface-producer-or-product-unreviewed");
  // The live imports can describe this product because their complete source
  // closure and producer policy matched above. Only its Git identity differs.
  const expected = { ...expectedSurfaceInventory(reviewed), head_sha: candidate.head, checkout_sha: candidate.head };
  candidate.unchanged(); reviewed.unchanged();
  const evaluated = evaluateSurfaceReceipt(value, expected);
  candidate.unchanged(); reviewed.unchanged();
  return evaluated;
}
