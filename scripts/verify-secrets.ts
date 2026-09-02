export interface SecretFinding {
  path: string;
  line: number;
  rule: string;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

const SECRET_RULES: readonly { id: string; pattern: RegExp }[] = [
  { id: "pem-private-key", pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/ },
  { id: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "github-pat", pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { id: "github-fine-grained-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: "github-oauth", pattern: /\bgho_[A-Za-z0-9]{36}\b/ },
  { id: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

function scanLines(path: string, text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const rule of SECRET_RULES) {
      if (rule.pattern.test(line)) {
        findings.push({ path, line: index + 1, rule: rule.id });
      }
    }
  }
  return findings;
}

export function scanSecretText(path: string, text: string): SecretFinding[] {
  return scanLines(path, text);
}

export function scanCommitMessageText(
  commit: string,
  text: string,
): SecretFinding[] {
  return scanLines(`commit ${commit}`, text);
}

function requireFullHistory(): SecretFinding[] {
  const result = Bun.spawnSync({
    cmd: ["git", "rev-parse", "--is-shallow-repository"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    return [{
      path: ".",
      line: 0,
      rule: "history-producer",
    }];
  }
  const shallow = result.stdout.toString().trim();
  if (shallow === "true") {
    return [{ path: ".", line: 0, rule: "shallow-clone" }];
  }
  if (shallow !== "false") {
    return [{ path: ".", line: 0, rule: "history-unknown" }];
  }
  return [];
}

async function scanTrackedFiles(): Promise<SecretFinding[]> {
  const listed = Bun.spawnSync({
    cmd: ["git", "ls-files", "-z"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (listed.exitCode !== 0) {
    return [{ path: ".", line: 0, rule: "tracked-path-producer" }];
  }
  const findings: SecretFinding[] = [];
  const files = listed.stdout.toString().split("\0").filter((file) => file.length > 0);
  for (const file of files) {
    const handle = Bun.file(file);
    if (!(await handle.exists())) {
      findings.push({ path: file, line: 0, rule: "missing-tracked-file" });
      continue;
    }
    if (handle.size > MAX_FILE_BYTES) {
      findings.push({ path: file, line: 0, rule: "file-exceeds-scan-bound" });
      continue;
    }
    const bytes = await handle.arrayBuffer();
    if (new Uint8Array(bytes).includes(0)) continue;
    findings.push(...scanSecretText(file, new TextDecoder().decode(bytes)));
  }
  return findings;
}

function scanCommitMessages(): SecretFinding[] {
  const logged = Bun.spawnSync({
    cmd: ["git", "log", "--all", "--format=%H%x00%B%x1e"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (logged.exitCode !== 0) {
    return [{ path: ".", line: 0, rule: "commit-message-producer" }];
  }
  const raw = logged.stdout.toString();
  if (raw.trim().length === 0) {
    return [{ path: ".", line: 0, rule: "empty-commit-history" }];
  }
  const findings: SecretFinding[] = [];
  const records = raw.split("\x1e").filter((record) => record.trim().length > 0);
  if (records.length === 0) {
    return [{ path: ".", line: 0, rule: "empty-commit-history" }];
  }
  for (const record of records) {
    const splitAt = record.indexOf("\0");
    if (splitAt < 0) {
      return [{ path: ".", line: 0, rule: "commit-message-framing" }];
    }
    const commit = record.slice(0, splitAt).trim();
    const body = record.slice(splitAt + 1);
    if (commit.length === 0) {
      return [{ path: ".", line: 0, rule: "commit-message-framing" }];
    }
    findings.push(...scanCommitMessageText(commit, body));
  }
  return findings;
}

export async function scanTrackedSecrets(): Promise<SecretFinding[]> {
  const history = requireFullHistory();
  if (history.length > 0) return history;
  return [...(await scanTrackedFiles()), ...scanCommitMessages()];
}

function formatFinding(finding: SecretFinding): string {
  if (finding.line === 0) {
    return `${finding.path}: secret scan failed (${finding.rule})`;
  }
  return `${finding.path}:${finding.line}: ${finding.rule}`;
}

async function main(): Promise<void> {
  const findings = await scanTrackedSecrets();
  for (const finding of findings) {
    console.error(formatFinding(finding));
  }
  if (findings.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log("secret verification passed");
}

if (import.meta.main) {
  await main();
}
