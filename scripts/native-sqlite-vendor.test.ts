import { expect, test } from "bun:test";
import { captureNativeSqliteVendor, collectSqliteVendor, parseVendorHeader, parseVendorIdentity, SqliteVendorError,
  type VendorIO } from "./native-sqlite-vendor";

const ID = { sqlite_version: "3.43.2", sqlite_source_id: "2023-10-10 13:08:14 1b37c146ee9ebb7acd0160c0ab1fd11017a419fa8a3187386ed8cb32b709aapl" };
const SDK = "/Applications/Xcode Test.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX15.5.sdk";
const header = (version = "3.43.2", source = ID.sqlite_source_id) => `#define SQLITE_VERSION "${version}"\n#define SQLITE_SOURCE_ID "${source}"\n`;
function fixture() {
  const calls: string[][] = [], reads: string[] = [];
  const io: VendorIO = {
    run(command) {
      calls.push([...command]);
      let stdout = "", stderr = "";
      if (command[0] === "/usr/bin/sqlite3") stdout = `${ID.sqlite_version}\t${ID.sqlite_source_id}\n`;
      else if (command.includes("--display")) stderr = "Executable=/usr/bin/sqlite3\nIdentifier=com.apple.sqlite3\n";
      else if (command.includes("-productVersion")) stdout = "15.6\n";
      else if (command.includes("-buildVersion")) stdout = "24G84\n";
      else if (command.includes("--show-sdk-path")) stdout = SDK + "\n";
      else if (command.includes("--show-sdk-version")) stdout = "15.5\n";
      return { status: 0, stdout, stderr };
    },
    read(path) { reads.push(path); return Buffer.from(path.endsWith("sqlite3.h") ? header("3.49.0", "different SDK source") : "synthetic signed CLI bytes"); },
    runtime: () => ({ ...ID }), kernel: () => "24.6.0",
  };
  return { io, calls, reads };
}

test("vendor parser preserves the complete Apple suffix and refuses ambiguous output", () => {
  expect(parseVendorIdentity(`${ID.sqlite_version}\t${ID.sqlite_source_id}\n`)).toEqual(ID);
  for (const text of ["", "3.43\tx", "3.43.2|x", "3.43.2\tx\nextra", "3.43.2\tx\tmore", "3.43.2\t\0", "3.43.2\t" + "x".repeat(257)]) {
    expect(() => parseVendorIdentity(text)).toThrow("vendor-invalid-output");
  }
});

test("SDK header parser requires one exact version and source definition", () => {
  expect(parseVendorHeader(header())).toEqual(ID);
  for (const text of ["", header() + header(), header().replace('"3.43.2"', '3.43.2'), header().replace("SQLITE_SOURCE_ID", "UNRELATED")]) {
    expect(() => parseVendorHeader(text)).toThrow("vendor-invalid-header");
  }
});

test("signed system identity is compared with Bun while a distinct SDK remains independent", () => {
  const f = fixture(), result = collectSqliteVendor(f.io);
  expect(result.system_cli.runtime).toEqual(ID);
  expect(result.bun_runtime).toMatchObject(ID);
  expect(result.system_cli.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.system_cli.apple_anchor_verified).toBe(true);
  expect(result.sdk).toMatchObject({ status: "available", path: SDK, version: "15.5", header_identity: { sqlite_version: "3.49.0" } });
  expect(result.scope).toBe("apple-signed-system-cli-identity-not-loaded-library");
  expect(f.calls[0]).toEqual(["/usr/bin/codesign", "--verify", "--strict", "-R", "anchor apple", "/usr/bin/sqlite3"]);
  expect(f.calls[2]).toEqual(["/usr/bin/sqlite3", "-batch", "-noheader", "-init", "/dev/null", ":memory:", "SELECT sqlite_version() || char(9) || sqlite_source_id();"]);
  expect(f.reads).toEqual(["/usr/bin/sqlite3", SDK + "/usr/include/sqlite3.h", "/usr/bin/sqlite3"]);
});

for (const failure of ["status", "timeout", "overflow"] as const) {
  test(`signature ${failure} refuses before system SQLite or Bun executes`, () => {
    const f = fixture(); let queried = false;
    f.io.run = () => failure === "status" ? { status: 1, stdout: "", stderr: "synthetic rejection" }
      : failure === "timeout" ? { status: null, stdout: "", stderr: "", error: "timeout" }
        : { status: 0, stdout: "", stderr: "x".repeat(16385) };
    f.io.runtime = () => { queried = true; return ID; };
    expect(() => collectSqliteVendor(f.io)).toThrow(failure === "overflow" ? "vendor-output-limit" : failure === "timeout" ? "vendor-command-timeout" : "vendor-signature-refused");
    expect(queried).toBe(false);
    expect(f.reads).toEqual(["/usr/bin/sqlite3"]);
  });
}

test("a missing codesign display remains a failed capture", () => {
  const f = fixture(), run = f.io.run;
  f.io.run = command => command.includes("--display") ? { status: 0, stdout: "", stderr: "" } : run(command);
  expect(() => collectSqliteVendor(f.io)).toThrow("vendor-signature-display-invalid");
});

test("command output limits count UTF-8 bytes, not JavaScript characters", () => {
  const f = fixture(); f.io.run = () => ({ status: 0, stdout: "", stderr: "é".repeat(8193) });
  expect(() => collectSqliteVendor(f.io)).toThrow("vendor-output-limit");
});

test.skipIf(process.platform === "darwin" && process.arch === "arm64")("native capture refuses unsupported hosts before issuing commands", () => {
  expect(() => captureNativeSqliteVendor()).toThrow("vendor-native-host-required");
});

for (const field of ["sqlite_version", "sqlite_source_id"] as const) {
  test(`a matching signature cannot excuse a different ${field}`, () => {
    const f = fixture(); f.io.runtime = () => ({ ...ID, [field]: field === "sqlite_version" ? "3.53.0" : "different source" });
    expect(() => collectSqliteVendor(f.io)).toThrow("vendor-runtime-mismatch");
  });
}

test("a replaced system CLI cannot reuse the original signature observation", () => {
  const f = fixture(), read = f.io.read; let count = 0;
  f.io.read = (path, limit) => path === "/usr/bin/sqlite3" && count++ > 0 ? Buffer.from("changed") : read(path, limit);
  expect(() => collectSqliteVendor(f.io)).toThrow("vendor-system-cli-changed");
});

test("SDK absence is explicit and never substitutes for the system identity", () => {
  const f = fixture(), run = f.io.run;
  f.io.run = command => command[0] === "/usr/bin/xcrun" ? { status: 1, stdout: "", stderr: "synthetic missing SDK" } : run(command);
  expect(collectSqliteVendor(f.io).sdk).toEqual({ status: "unavailable", reason: "vendor-sdk-path-unavailable" });
  expect(f.reads).toEqual(["/usr/bin/sqlite3", "/usr/bin/sqlite3"]);
});

for (const path of ["/tmp/foreign.sdk", "/Applications/../foreign.sdk", "/Applications/Xcode.sdk\nforeign"]) {
  test(`an invalid SDK path never becomes a file read: ${JSON.stringify(path)}`, () => {
    const f = fixture(), run = f.io.run;
    f.io.run = command => command.includes("--show-sdk-path") ? { status: 0, stdout: path, stderr: "" } : run(command);
    expect(collectSqliteVendor(f.io).sdk.status).toBe("unavailable");
    expect(f.reads).toEqual(["/usr/bin/sqlite3", "/usr/bin/sqlite3"]);
  });
}

test.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("native Apple-signed SQLite vendor identity matches current Bun", () => {
  try {
    const evidence = captureNativeSqliteVendor();
    console.log(JSON.stringify(evidence));
    expect(evidence.status).toBe("PASS");
  } catch (error) {
    console.log(JSON.stringify({ schema: "kizuki.sqlite-vendor-observation/v1", status: "FAIL",
      reason: error instanceof SqliteVendorError ? error.code : "vendor-capture-failed",
      ...(error instanceof SqliteVendorError && error.diagnostic ? { diagnostic: error.diagnostic } : {}) }));
    throw new Error(error instanceof SqliteVendorError ? error.code : "vendor-capture-failed");
  }
}, 35_000);


test("signature refusal retains bounded public diagnostics and never queries SQLite", () => {
  const f = fixture(); let queried = false;
  f.io.runtime = () => { queried = true; return ID; };
  f.io.run = command => command.includes("--verify")
    ? { status: 1, stdout: "", stderr: "synthetic signature requirement refusal" }
    : { status: 0, stdout: "", stderr: "Executable=/usr/bin/sqlite3\nSignature=synthetic\n" };
  let failure: SqliteVendorError | undefined;
  try { collectSqliteVendor(f.io); } catch (error) { failure = error as SqliteVendorError; }
  expect(failure?.code).toBe("vendor-signature-refused");
  expect(failure?.diagnostic?.verification.status).toBe(1);
  expect(failure?.diagnostic?.display.stderr).toContain("Executable=/usr/bin/sqlite3");
  expect(failure?.diagnostic?.system_cli_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(queried).toBe(false);
  f.io.run = () => ({ status: 1, stdout: "x".repeat(16385), stderr: "x".repeat(16385) });
  try { collectSqliteVendor(f.io); } catch (error) { failure = error as SqliteVendorError; }
  expect(failure?.code).toBe("vendor-output-limit");
  expect(failure?.diagnostic?.verification.stdout).toBe("[output limit exceeded]");
  expect(failure?.diagnostic?.display.stderr).toBe("[output limit exceeded]");
  expect(queried).toBe(false);
});
