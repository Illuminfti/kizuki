import { describe, expect, test } from "bun:test";
import { constants, openSync, closeSync, mkdtempSync, rmSync, fstatSync, writeFileSync, symlinkSync, lstatSync, readdirSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { custodyNative } from "../../src/util/custody-native";

const supported = process.platform === "linux" && process.arch === "x64";
const native = describe.skipIf(!supported);
const fixture = new URL("./custody-native-fixture.ts", import.meta.url).pathname;
const binding = Buffer.from("1234567890abcdef1234567890abcdef", "hex");
const libc = supported ? dlopen("libc.so.6", {
  sendmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
}) : null;

function raw(socket: number, descriptors: number[], change: "none" | "extra" | "kind" | "binding" | "short" | "empty" = "none") {
  const bytes = Buffer.alloc(change === "empty" ? 0 : change === "extra" ? 33 : change === "short" ? 2 : 32);
  if (bytes.length >= 32) { bytes.writeUInt32LE(0x4b435331); bytes.writeUInt32LE(1, 4); bytes.writeUInt32LE(change === "kind" ? 2 : 1, 8); binding.copy(bytes, 16); }
  if (change === "binding") bytes[16] = 0;
  const io = Buffer.alloc(16); io.writeBigUInt64LE(BigInt(ptr(bytes.length ? bytes : Buffer.alloc(1))), 0); io.writeBigUInt64LE(BigInt(bytes.length), 8);
  const control = Buffer.alloc(16 + descriptors.length * 4 + 7 & ~7);
  control.writeBigUInt64LE(BigInt(16 + descriptors.length * 4)); control.writeInt32LE(1, 8); control.writeInt32LE(1, 12);
  descriptors.forEach((fd, i) => control.writeInt32LE(fd, 16 + i * 4));
  const message = Buffer.alloc(56); message.writeBigUInt64LE(BigInt(ptr(io)), 16); message.writeBigUInt64LE(1n, 24);
  if (descriptors.length) { message.writeBigUInt64LE(BigInt(ptr(control)), 32); message.writeBigUInt64LE(BigInt(control.length), 40); }
  expect(Number(libc!.symbols.sendmsg(socket, ptr(message), 0x4000))).toBe(bytes.length);
}

async function setup(variant = "") {
  const directory = mkdtempSync(join(tmpdir(), "kizuki-custody-"));
  const control = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  const child = Bun.spawn([process.execPath, fixture, "server", directory, String(process.pid), binding.toString("hex"), variant],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const reader = child.stdout.getReader();
  let output = "";
  for (;;) {
    const chunk = await reader.read(); if (chunk.done) throw new Error(`broker exited before listen: ${await new Response(child.stderr).text()}`);
    output += new TextDecoder().decode(chunk.value);
    if (output.includes("LISTEN\n")) break;
  }
  const api = custodyNative();
  const socket = api.connect(control, "broker.sock");
  let closed = false;
  return { directory, control, child, socket, api,
    async signalHandler() {
      expect(JSON.parse(output.split("\n")[0]!).term_caught_before_serve).toBe(false);
      const deadline = performance.now() + 2000;
      while (performance.now() < deadline && child.exitCode === null) {
        const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
        const caught = /^SigCgt:\s*([0-9a-f]+)$/mi.exec(status)?.[1];
        if (caught && (BigInt(`0x${caught}`) & (1n << 14n)) !== 0n) return;
        await Bun.sleep(5);
      }
      throw new Error("synthetic broker did not install its SIGTERM handler");
    },
    async ready() {
      while (!output.includes("READY\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("synthetic broker ended before READY"); output += new TextDecoder().decode(chunk.value); }
    },
    closeSocket() { if (!closed) { closeSync(socket); closed = true; } },
    async finish() {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
      const exit = await child.exited; const stderr = await new Response(child.stderr).text();
      expect(stderr).toBe(""); expect(exit).toBe(0);
      const result = JSON.parse(output.trim().split("\n").at(-1)!);
      expect(result.descriptor_delta).toBe(variant === "closed-watch" ? -1 : 0);
      return { ...result, ready: output.includes("READY\n") };
    },
    async cleanup() { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } if (!closed) closeSync(socket); closeSync(control); rmSync(directory, { recursive: true, force: true }); },
  };
}

native("Linux custody descriptor transport", () => {
  test("exchanges actual directory metadata, authenticates peer and closes on EOF", async () => {
    const f = await setup();
    try {
      expect(f.api.peer(f.socket)).toEqual({ pid: f.child.pid, uid: process.getuid!(), gid: process.getgid!() });
      expect(lstatSync(join(f.directory, "broker.sock")).mode & 0o777).toBe(0o600);
      const expected = fstatSync(f.control, { bigint: true });
      for (let i = 0; i < 8; i++) expect(f.api.stat(f.socket, f.control, binding)).toEqual({ dev: expected.dev, ino: expected.ino,
        mode: expected.mode, uid: expected.uid, gid: expected.gid, ctimeNs: expected.ctimeNs });
      expect(f.api.healthy(f.socket)).toBe(true);
      f.closeSocket(); expect(await f.finish()).toMatchObject({ result: 0, ready: true });
    } finally { await f.cleanup(); }
  });

  for (const variant of ["wrong-peer", "wrong-owner"]) test(`refuses ${variant} before READY`, async () => {
    const f = await setup(variant);
    try { expect(() => f.api.stat(f.socket, f.control, binding)).toThrow("custody_native_unavailable");
      expect(await f.finish()).toMatchObject({ result: -1, ready: false });
    } finally { await f.cleanup(); }
  });

  for (const change of ["none", "extra", "kind", "binding", "short"] as const) test(`rejects malformed ${change} request with no descriptor leak`, async () => {
    const f = await setup();
    try { raw(f.socket, change === "none" ? [] : [f.control], change);
      expect(await f.finish()).toMatchObject({ result: -1, ready: false });
      expect(f.api.healthy(f.socket)).toBe(false);
    } finally { await f.cleanup(); }
  });

  for (const count of [2, 253]) test(`closes all ${count} supplied descriptors on refusal`, async () => {
    const f = await setup();
    try { raw(f.socket, Array(count).fill(f.control));
      expect(await f.finish()).toMatchObject({ result: -1, ready: false });
    } finally { await f.cleanup(); }
  });

  for (const kind of ["regular", "symlink"] as const) test(`server refuses ${kind} descriptors`, async () => {
    const f = await setup(); let fd = -1;
    try {
      const path = join(f.directory, "input");
      if (kind === "regular") { writeFileSync(path, "synthetic"); fd = openSync(path, constants.O_RDONLY); }
      else { symlinkSync(f.directory, path); fd = openSync(path, 0x200000 | constants.O_NOFOLLOW); }
      raw(f.socket, [fd]); expect(await f.finish()).toMatchObject({ result: -1, ready: false });
    } finally { if (fd >= 0) closeSync(fd); await f.cleanup(); }
  });

  test("SIGTERM exits C loop and runs JavaScript cleanup without READY", async () => {
    const f = await setup();
    try { await f.signalHandler(); f.child.kill("SIGTERM"); expect(await f.finish()).toMatchObject({ result: 0, ready: false }); }
    finally { await f.cleanup(); }
  });

  test("SIGTERM drains an established idle loop until the main closes", async () => {
    const f = await setup();
    try { f.api.stat(f.socket, f.control, binding); await f.ready(); f.child.kill("SIGTERM"); await Bun.sleep(600);
      expect(f.api.healthy(f.socket)).toBe(true); f.api.stat(f.socket, f.control, binding); f.closeSocket();
      expect(await f.finish()).toMatchObject({ result: 0, ready: true }); }
    finally { await f.cleanup(); }
  });

  test("two owned child PIDs drain a held rail, final RPC and durable cleanup before main EOF", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-custody-drain-"));
    const main = Bun.spawn([process.execPath, fixture, "draining-main", directory], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let brokerPid: number | undefined;
    try {
      const reader = main.stdout.getReader(); let output = "";
      while (!output.includes("\n")) { const chunk = await reader.read(); if (chunk.done) throw new Error("synthetic main ended before readiness"); output += new TextDecoder().decode(chunk.value); }
      const identity = JSON.parse(output.trim().split("\n")[0]!); brokerPid = identity.broker_pid;
      expect(identity.main_pid).toBe(main.pid); expect(brokerPid).not.toBe(main.pid);
      main.kill("SIGTERM"); // The synthetic main relays TERM through its owned broker Subprocess handle.
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
      const result = JSON.parse(output.trim().split("\n").at(-1)!);
      expect({ exit: await main.exited, result }).toMatchObject({ exit: 0, result: { synthetic: true, final_rpc: true, broker_result: 0, broker_exit: 0 } });
      expect(result.held_ms).toBeGreaterThanOrEqual(650);
      const receipt = JSON.parse(readFileSync(join(directory, "cleanup-receipt.json"), "utf8"));
      expect(receipt).toEqual({ synthetic: true, final_rpc: true, held_ms: result.held_ms });
      expect(await new Response(main.stderr).text()).toBe("");
    } finally {
      if (main.exitCode === null) { main.kill("SIGKILL"); await main.exited; }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("unexpected broker death makes further custody checks fail", async () => {
    const f = await setup();
    try { f.api.stat(f.socket, f.control, binding); await f.ready(); f.child.kill("SIGKILL"); await f.child.exited;
      expect(f.api.healthy(f.socket)).toBe(false);
      expect(() => f.api.stat(f.socket, f.control, binding)).toThrow("custody_native_unavailable"); }
    finally { await f.cleanup(); }
  });

  test("does not mistake an empty packet for orderly EOF after READY", async () => {
    const f = await setup();
    try { f.api.stat(f.socket, f.control, binding); raw(f.socket, [], "empty");
      expect(await f.finish()).toMatchObject({ result: -1, ready: true }); }
    finally { await f.cleanup(); }
  });

  test("watched process exit stops the server while authenticated socket stays open", async () => {
    const watched = Bun.spawn([process.execPath, "-e", "setInterval(() => {},1000)"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    const f = await setup(`watch:${watched.pid}`);
    try { f.api.stat(f.socket, f.control, binding); await f.ready(); watched.kill("SIGTERM"); await watched.exited;
      expect(await f.finish()).toMatchObject({ result: 0, ready: true }); expect(f.api.healthy(f.socket)).toBe(false); }
    finally { if (watched.exitCode === null) { watched.kill("SIGKILL"); await watched.exited; } await f.cleanup(); }
  });

  for (const variant of ["forged", "mutation", "descriptor"]) test(`client refuses ${variant} response and closes unexpected rights`, async () => {
    const f = await setup(`reply:${variant}`);
    try { const before = readdirSync("/proc/self/fd").length;
      expect(() => f.api.stat(f.socket, f.control, binding)).toThrow("custody_native_unavailable");
      expect(readdirSync("/proc/self/fd").length).toBe(before); expect(f.api.healthy(f.socket)).toBe(false);
      expect(await f.finish()).toMatchObject({ result: 0, ready: false }); }
    finally { await f.cleanup(); }
  });

  test("draining does not turn a malformed request into clean shutdown", async () => {
    const f = await setup();
    try { f.api.stat(f.socket, f.control, binding); await f.ready(); f.child.kill("SIGTERM"); await Bun.sleep(600);
      raw(f.socket, [f.control], "kind"); expect(await f.finish()).toMatchObject({ result: -1, ready: true }); }
    finally { await f.cleanup(); }
  });

  test("draining refuses an invalidated pidfd as an error rather than main exit", async () => {
    const f = await setup("closed-watch");
    try { f.api.stat(f.socket, f.control, binding); await f.ready(); f.child.kill("SIGTERM"); await Bun.sleep(600);
      writeFileSync(join(f.directory, "close-watch"), "synthetic");
      expect(await f.finish()).toMatchObject({ result: -1, ready: true }); }
    finally { await f.cleanup(); }
  });

  test("bounds client receive timeout and seals a stalled channel", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-custody-timeout-"));
    const api = custodyNative(); const control = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const listener = api.listen(control, "broker.sock"); const socket = api.connect(control, "broker.sock");
    try { const start = performance.now(); expect(() => api.stat(socket, control, binding)).toThrow("custody_native_unavailable");
      expect(performance.now() - start).toBeGreaterThanOrEqual(900); expect(performance.now() - start).toBeLessThan(2000); expect(api.healthy(socket)).toBe(false); }
    finally { closeSync(socket); closeSync(listener); closeSync(control); rmSync(directory, { recursive: true, force: true }); }
  });

  test("rejects endpoint aliases, existing files, wrong types and malformed arguments", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-custody-path-"));
    const api = custodyNative(); const control = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      for (const name of ["", ".", "..", "../escape", "/absolute", "nul\0tail", "x".repeat(65)]) expect(() => api.listen(control, name)).toThrow("custody_native_unavailable");
      writeFileSync(join(directory, "regular"), "synthetic"); symlinkSync("regular", join(directory, "alias"));
      for (const name of ["regular", "alias"]) { expect(() => api.listen(control, name)).toThrow("custody_native_unavailable"); expect(() => api.connect(control, name)).toThrow("custody_native_unavailable"); }
      expect(() => api.peer(control)).toThrow("custody_native_unavailable"); expect(() => api.watchPid(-1)).toThrow("custody_native_unavailable");
      expect(() => api.stat(control, control, Buffer.alloc(15))).toThrow("custody_native_unavailable");
    } finally { closeSync(control); rmSync(directory, { recursive: true, force: true }); }
  });

  test("uses a held control directory beyond Unix socket pathname length and restores umask", () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-custody-long-")); const directory = join(root, "a".repeat(70), "b".repeat(70));
    mkdirSync(directory, { recursive: true }); const control = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const api = custodyNative(); const oldMask = process.umask(); let listener = -1, socket = -1;
    try { listener = api.listen(control, "broker.sock"); expect(process.umask()).toBe(oldMask);
      socket = api.connect(control, "broker.sock"); expect(socket).toBeGreaterThanOrEqual(0);
      expect(lstatSync(join(directory, "broker.sock")).mode & 0o777).toBe(0o600);
      expect(() => api.listen(control, "broker.sock")).toThrow("custody_native_unavailable");
    } finally { if (socket >= 0) closeSync(socket); if (listener >= 0) closeSync(listener); closeSync(control); rmSync(root, { recursive: true, force: true }); }
  });

  test("seccomp refuses new nonlocal sockets on main and pre-existing worker threads", async () => {
    const child = Bun.spawn([process.execPath, fixture, "restrict"], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    try { const output = await new Response(child.stdout).text(); const errors = await new Response(child.stderr).text();
      expect(await child.exited).toBe(0); expect(errors).toBe("");
      expect(JSON.parse(output)).toEqual({ before: true, workerBefore: true, inet: -1, inet6: -1, netlink: -1, inetPair: -1, unix: true, worker: -1 });
    } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
  });
});

test.skipIf(supported)("custody transport refuses unsupported native platforms", () => {
  expect(() => custodyNative()).toThrow("custody_native_unavailable");
});
