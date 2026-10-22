import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { WORLD_VOCABULARY_MODULES } from "./candidate-modules";
import { candidateRegistry, verifyQualificationReceipt } from "./registry";

function readReport(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > 32 * 1024 * 1024) throw new Error("invalid qualification report");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2), value = (flag: string) => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
    const allowed = ["--report", "--report-sha256", "--review-file", "--review-sha256", "--endpoint-evidence"];
    for (let index = 0; index < args.length; index++) {
      const flag = args[index]!;
      if (!allowed.includes(flag) || args.indexOf(flag) !== index || args[++index] === undefined || args[index]!.startsWith("--")) throw new Error("invalid arguments");
    }
    const report = value("--report"), reportSha256 = value("--report-sha256"), reviewFile = value("--review-file"), reviewSha256 = value("--review-sha256"), endpointEvidence = value("--endpoint-evidence");
    if ([report, reportSha256, reviewFile, reviewSha256, endpointEvidence].some(item => item === undefined)) throw new Error("required arguments missing");
    const checked = verifyQualificationReceipt(readReport(report!), { file: report!.split("/").at(-1)!, sha256: reportSha256!, endpoint_evidence: endpointEvidence!,
      body_review: { file: reviewFile!, sha256: reviewSha256! } }, candidateRegistry(WORLD_VOCABULARY_MODULES, ["concept", "situation"]));
    console.log(JSON.stringify({ status: "passed", report_sha256: checked.report_sha256,
      body_review_sha256: reviewSha256, endpoint_evidence_sha256: endpointEvidence,
      registry_sha256: checked.registry_sha256, kinds: checked.kinds, predicates: checked.predicates }));
  } catch { console.error("core semantic verification failed"); process.exitCode = 1; }
}
