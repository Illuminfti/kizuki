import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";

export const HISTORY_RECORD_LIMIT_BYTES = 64 * 1024 * 1024;
export const PUBLISHED_HISTORY_COMMIT_COUNT = 11;
export const PUBLISHED_HISTORY_OCCURRENCE_COUNT = 16;
const PUBLISHED_MAIN = "refs/remotes/origin/main";
const MASK = Buffer.from("[historical-policy-exception]");
const IDENTIFIER = new RegExp(
  "(^|[^0-9A-Za-z])ill" +
    "umi([^0-9A-Za-z]|$)|her" +
    "mes|ika-" +
    "hetzner|alb" +
    "edo|g" +
    "brain",
  "i",
);

export type HistoryPolicyCode =
  | "empty"
  | "limit"
  | "framing"
  | "digest"
  | "offset"
  | "missing"
  | "duplicate"
  | "nonancestor"
  | "replaced-object";

export type HistoryOccurrence = {
  readonly offset: number;
  readonly length: number;
};

export type HistoryPin = {
  readonly sha: string;
  readonly messageSha256: string;
  readonly occurrences: readonly HistoryOccurrence[];
};

export class HistoryPolicyError extends Error {
  override readonly name = "HistoryPolicyError";
  readonly code: HistoryPolicyCode;
  constructor(code: HistoryPolicyCode) {
    super("historical commit exception validation failed");
    this.code = code;
  }
}

export const PUBLISHED_HISTORY_PINS: readonly HistoryPin[] = [
  {
    sha: "74d4e96b89e261ee5102fd52cc09d3a65aa67637",
    messageSha256: "c3c79f93fc4b9ccdc6e6cde9b238fa91f08074a9b02cea482fa36a7b7932ab27",
    occurrences: [
      { offset: 68, length: 6 },
      { offset: 209, length: 6 },
      { offset: 217, length: 6 },
    ],
  },
  {
    sha: "7505a1038dbf47980a5c153f675ef3bf45973ef1",
    messageSha256: "75d8cd1f3cc9209ec58dabc08915d523762ca6b01b71547b90994cee9af5f5be",
    occurrences: [
      { offset: 80, length: 6 },
      { offset: 280, length: 6 },
      { offset: 288, length: 6 },
    ],
  },
  {
    sha: "0e3bb2216c9f1a1b3f33191d44eae5c39a6007f1",
    messageSha256: "13907273fd26ca25999988064d376a9d6576fb39d296fee54df6bf178cb4f287",
    occurrences: [{ offset: 389, length: 6 }],
  },
  {
    sha: "519f88cb41902cf29e15d9fb7f8b2b2d03c15cdf",
    messageSha256: "f9871b623bc0cdaa93423671ee77f833cbb112181d215796dbb1e30f28f8a45d",
    occurrences: [{ offset: 699, length: 6 }],
  },
  {
    sha: "f4eb5feaa37d031fc28fa2d0083f385f7340c787",
    messageSha256: "b41c3d3365351742810d6fe936996d88c82144ceddd9a34eb79f20e154a310a0",
    occurrences: [{ offset: 392, length: 6 }],
  },
  {
    sha: "79cf67072ef3f2c126fb17bfcf324d2ba1d3472f",
    messageSha256: "d7040eacc98daac282637cfbd7101190ae751d05e8c75ae7cd1098777ea680d1",
    occurrences: [
      { offset: 1628, length: 6 },
      { offset: 1805, length: 6 },
    ],
  },
  {
    sha: "e787f7bc0fb71347de33c340adcd22e005e4541e",
    messageSha256: "3246e5f733387bf421148512671d0a995cbf0cad9af78acd74c6352373e97c53",
    occurrences: [{ offset: 528, length: 6 }],
  },
  {
    sha: "0969805c31442b98532b1eb6250f299ba2524ae7",
    messageSha256: "04369010f037fe01618f61877ccb469482b9d1fc0489e0194c856a3166edc723",
    occurrences: [{ offset: 424, length: 6 }],
  },
  {
    sha: "01e22627388a6d5f9b89f2a9aca0e116d094487a",
    messageSha256: "14f34a642951e8287c9832f49361334fe264f2d4153fc7acfd30a1e6970998ce",
    occurrences: [{ offset: 548, length: 6 }],
  },
  {
    sha: "092d27bfeb9d84b21d0e843b0706273bd0314290",
    messageSha256: "30a75bcc2c3763e04c0ea16f084a16e082d39f885c714c7ad9b299e7edeeb95c",
    occurrences: [{ offset: 140, length: 6 }],
  },
  {
    sha: "1c919f00570c3bb70088114083d8598c01c77903",
    messageSha256: "55b26c12cbb2bce514245e95ae7365fcc1d3287a6dbd664552f47e773cea0f6b",
    occurrences: [{ offset: 1736, length: 6 }],
  },
];

export type FramedCommitRecord = {
  readonly sha: string;
  readonly message: Buffer;
};

function fail(code: HistoryPolicyCode): never {
  throw new HistoryPolicyError(code);
}

function gitExitCode(status: number | null): number {
  return typeof status === "number" ? status : 1;
}

function spawnGit(args: readonly string[]): { exitCode: number; stdout: Buffer } {
  const result = Bun.spawnSync({
    cmd: ["git", ...args],
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: gitExitCode(result.exitCode),
    stdout: Buffer.from(result.stdout),
  };
}

export function formatAppliedPinReceipt(pins: readonly HistoryPin[] = PUBLISHED_HISTORY_PINS): string {
  const occurrences = pins.reduce((count, pin) => count + pin.occurrences.length, 0);
  const body = pins.map((pin) => `${pin.sha}:${pin.occurrences.length}`).join(" ");
  return `applied-history-pins commits=${pins.length} occurrences=${occurrences} ${body}`;
}

export function assertProductionHistoryInventory(
  pins: readonly HistoryPin[] = PUBLISHED_HISTORY_PINS,
): void {
  if (pins.length !== PUBLISHED_HISTORY_COMMIT_COUNT) fail("missing");
  const shas = new Set<string>();
  let occurrences = 0;
  for (const pin of pins) {
    if (shas.has(pin.sha)) fail("duplicate");
    shas.add(pin.sha);
    if (pin.occurrences.length === 0) fail("offset");
    occurrences += pin.occurrences.length;
  }
  if (occurrences !== PUBLISHED_HISTORY_OCCURRENCE_COUNT) fail("offset");
}

export function parseFramedCommitRecords(records: Uint8Array): FramedCommitRecord[] {
  if (records.length === 0) fail("empty");
  if (records.length > HISTORY_RECORD_LIMIT_BYTES) fail("limit");
  const buf = Buffer.from(records);
  const parsed: FramedCommitRecord[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset < buf.length) {
    const idEnd = buf.indexOf(0, offset);
    if (idEnd < offset) fail("framing");
    const messageEnd = buf.indexOf(0, idEnd + 1);
    if (messageEnd < 0) fail("framing");
    const sha = buf.toString("utf8", offset, idEnd);
    if (!/^[a-f0-9]{40}$/.test(sha)) fail("framing");
    if (seen.has(sha)) fail("duplicate");
    seen.add(sha);
    parsed.push({
      sha,
      message: Buffer.from(buf.subarray(idEnd + 1, messageEnd)),
    });
    offset = messageEnd + 1;
  }
  if (offset !== buf.length || parsed.length === 0) fail("framing");
  return parsed;
}

function pinMap(pins: readonly HistoryPin[]): Map<string, HistoryPin> {
  const mapped = new Map<string, HistoryPin>();
  for (const pin of pins) {
    if (!/^[a-f0-9]{40}$/.test(pin.sha) || !/^[a-f0-9]{64}$/.test(pin.messageSha256)) fail("digest");
    if (mapped.has(pin.sha)) fail("duplicate");
    mapped.set(pin.sha, pin);
  }
  if (mapped.size === 0) fail("missing");
  return mapped;
}

function occurrenceMatchesIdentifier(message: Buffer, offset: number, length: number): boolean {
  const slice = message.subarray(offset, offset + length).toString("latin1");
  const match = IDENTIFIER.exec(slice);
  const matched = match?.[0];
  return match !== null && match.index === 0 && matched !== undefined && matched.length === slice.length;
}

function validateOccurrences(message: Buffer, occurrences: readonly HistoryOccurrence[]): void {
  if (occurrences.length === 0) fail("offset");
  const ordered = occurrences
    .map((item, index) => ({ offset: item.offset, length: item.length, index }))
    .sort((left, right) => left.offset - right.offset || left.index - right.index);
  let previousEnd = 0;
  for (const [position, item] of ordered.entries()) {
    if (
      item === undefined ||
      !Number.isInteger(item.offset) ||
      !Number.isInteger(item.length) ||
      item.offset < 0 ||
      item.length <= 0 ||
      item.offset + item.length > message.length
    ) {
      fail("offset");
    }
    if (position > 0 && item.offset < previousEnd) fail("offset");
    if (!occurrenceMatchesIdentifier(message, item.offset, item.length)) fail("offset");
    previousEnd = item.offset + item.length;
  }
}

function replaceOccurrences(message: Buffer, occurrences: readonly HistoryOccurrence[]): Buffer {
  const ordered = [...occurrences].sort((left, right) => left.offset - right.offset);
  const parts: Buffer[] = [];
  let cursor = 0;
  for (const item of ordered) {
    parts.push(message.subarray(cursor, item.offset));
    parts.push(MASK);
    cursor = item.offset + item.length;
  }
  parts.push(message.subarray(cursor));
  return Buffer.concat(parts);
}

function resolvePublishedMain(): string {
  const result = spawnGit([
    "--no-replace-objects",
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${PUBLISHED_MAIN}^{commit}`,
  ]);
  const sha = result.stdout.toString("utf8").trim();
  if (result.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(sha)) fail("nonancestor");
  return sha;
}

function assertAncestorOfPublishedMain(sha: string, publishedMain: string): void {
  const result = spawnGit(["--no-replace-objects", "merge-base", "--is-ancestor", sha, publishedMain]);
  if (result.exitCode !== 0) fail("nonancestor");
}

function assertUnreplacedObject(sha: string, message: Buffer): void {
  const replaceRef = spawnGit([
    "--no-replace-objects",
    "show-ref",
    "--verify",
    "--quiet",
    `refs/replace/${sha}`,
  ]);
  if (replaceRef.exitCode === 0) fail("replaced-object");
  const raw = spawnGit(["--no-replace-objects", "cat-file", "commit", sha]);
  if (raw.exitCode !== 0) fail("replaced-object");
  const separator = raw.stdout.indexOf("\n\n");
  if (separator < 0) fail("replaced-object");
  if (!raw.stdout.subarray(separator + 2).equals(message)) fail("replaced-object");
  const replaced = spawnGit(["cat-file", "commit", sha]);
  if (replaced.exitCode !== 0 || !replaced.stdout.equals(raw.stdout)) fail("replaced-object");
}

export function sanitizeHistoricalCommitRecords(
  records: Uint8Array,
  pins: readonly HistoryPin[] = PUBLISHED_HISTORY_PINS,
): Buffer {
  if (records.length === 0) fail("empty");
  if (records.length > HISTORY_RECORD_LIMIT_BYTES) fail("limit");
  const parsed = parseFramedCommitRecords(records);
  const mapped = pinMap(pins);
  const seen = new Set<string>();
  const chunks: Buffer[] = [];
  const newline = Buffer.from("\n");
  let publishedMain: string | undefined;
  for (const record of parsed) {
    const pin = mapped.get(record.sha);
    if (pin === undefined) {
      chunks.push(record.message, newline);
      continue;
    }
    if (createHash("sha256").update(record.message).digest("hex") !== pin.messageSha256) {
      fail("digest");
    }
    validateOccurrences(record.message, pin.occurrences);
    assertUnreplacedObject(record.sha, record.message);
    publishedMain ??= resolvePublishedMain();
    assertAncestorOfPublishedMain(record.sha, publishedMain);
    seen.add(record.sha);
    chunks.push(replaceOccurrences(record.message, pin.occurrences), newline);
  }
  if (seen.size !== mapped.size) fail("missing");
  return Buffer.concat(chunks);
}

function main(): void {
  const input = process.argv[2];
  const output = process.argv[3];
  try {
    if (input === undefined || output === undefined || input.length === 0 || output.length === 0) {
      fail("framing");
    }
    const stat = statSync(input);
    if (!stat.isFile()) fail("framing");
    if (stat.size === 0) fail("empty");
    if (stat.size > HISTORY_RECORD_LIMIT_BYTES) fail("limit");
    const records = readFileSync(input);
    if (records.length > HISTORY_RECORD_LIMIT_BYTES) fail("limit");
    assertProductionHistoryInventory();
    const sanitized = sanitizeHistoricalCommitRecords(records, PUBLISHED_HISTORY_PINS);
    writeFileSync(output, sanitized);
    process.stdout.write(`${formatAppliedPinReceipt()}\n`);
  } catch {
    process.stderr.write("verification failed: historical commit exception validation failed\n");
    process.exit(2);
  }
}

if (import.meta.main) {
  main();
}
