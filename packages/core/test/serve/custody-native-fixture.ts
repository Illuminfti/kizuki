// Synthetic child process: real sockets and kernel descriptors, never an account.
import { constants, openSync, closeSync, readdirSync, fstatSync, fchmodSync, writeFileSync, fsyncSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";
import { custodyNative } from "../../src/util/custody-native";

const [mode, directory, parent, bindingHex, variant = ""] = process.argv.slice(2);
if (mode === "close-watch-worker") {
  self.onmessage = () => {};
  postMessage("worker-ready");
  while (!await Bun.file(parent! + "/close-watch").exists()) await Bun.sleep(5);
  closeSync(Number(directory)); postMessage("closed");
} else if (mode === "worker") {
  const libc = dlopen("libc.so.6", { socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  postMessage("worker-ready");
  self.onmessage = () => { const fd = libc.symbols.socket(2, 1, 0); postMessage(fd); if (fd >= 0) closeSync(fd); };
} else if (mode === "restrict") {
  const worker = new Worker(new URL(import.meta.url).href, { argv: ["worker"] });
  await new Promise<void>((resolve) => { worker.onmessage = () => resolve(); });
  const beforeWorker = new Promise<number>((resolve) => { worker.onmessage = (event) => resolve(event.data); });
  worker.postMessage("before"); const workerBefore = await beforeWorker;
  const result = new Promise<number>((resolve) => { worker.onmessage = (event) => resolve(event.data); });
  const libc = dlopen("libc.so.6", {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    socketpair: { args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr], returns: FFIType.i32 },
  });
  const before = libc.symbols.socket(2, 1, 0); if (before >= 0) closeSync(before);
  custodyNative().restrictBroker();
  worker.postMessage("probe");
  const unix = libc.symbols.socket(1, 5, 0);
  const pair = Buffer.alloc(8);
  console.log(JSON.stringify({ before: before >= 0, workerBefore: workerBefore >= 0, inet: libc.symbols.socket(2, 1, 0), inet6: libc.symbols.socket(10, 1, 0),
    netlink: libc.symbols.socket(16, 3, 0), inetPair: libc.symbols.socketpair(2, 1, 0, ptr(pair)), unix: unix >= 0, worker: await result }));
  if (unix >= 0) closeSync(unix);
  worker.terminate();
} else if (mode === "draining-main") {
  const api = custodyNative(); const control = openSync(directory!, constants.O_RDONLY | constants.O_DIRECTORY);
  const bytes = Buffer.from("1234567890abcdef1234567890abcdef", "hex");
  let requestedStop!: () => void; const stopRequested = new Promise<void>(resolve => { requestedStop = resolve; });
  const broker = Bun.spawn([process.execPath, new URL(import.meta.url).pathname, "server", directory!, String(process.pid), bytes.toString("hex")],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const stopMain = () => { broker.kill("SIGTERM"); requestedStop(); };
  process.on("SIGTERM", stopMain);
  const reader = broker.stdout.getReader(); let output = "", socket = -1;
  const until = async (marker: string) => { while (!output.includes(marker)) {
    const chunk = await reader.read(); if (chunk.done) throw new Error("synthetic broker stopped before marker");
    output += new TextDecoder().decode(chunk.value);
  } };
  try {
    await until("LISTEN\n"); socket = api.connect(control, "broker.sock"); api.stat(socket, control, bytes);
    await until("READY\n");
    console.log(JSON.stringify({ main_pid: process.pid, broker_pid: broker.pid }));
    await stopRequested;
    const started = performance.now(); await Bun.sleep(700); // A held synthetic rail outlives the broker poll interval.
    const observed = api.stat(socket, control, bytes);
    const local = fstatSync(control, { bigint: true });
    const receipt = { synthetic: true, final_rpc: observed.ino === local.ino && observed.dev === local.dev, held_ms: performance.now() - started };
    const receiptFd = openSync(directory! + "/cleanup-receipt.json", constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { writeFileSync(receiptFd, JSON.stringify(receipt)); fsyncSync(receiptFd); } finally { closeSync(receiptFd); }
    closeSync(socket); socket = -1;
    while (true) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
    const brokerResult = JSON.parse(output.trim().split("\n").at(-1)!);
    console.log(JSON.stringify({ ...receipt, broker_result: brokerResult.result, broker_exit: await broker.exited }));
  } catch {
    console.log(JSON.stringify({ synthetic: true, final_rpc: false, cleanup: false })); process.exitCode = 1;
  } finally {
    if (socket >= 0) closeSync(socket);
    if (broker.exitCode === null) { broker.kill("SIGKILL"); await broker.exited; }
    closeSync(control); process.off("SIGTERM", stopMain);
  }
} else {
  const api = custodyNative();
  const control = openSync(directory!, constants.O_RDONLY | constants.O_DIRECTORY);
  const listener = api.listen(control, "broker.sock");
  const pid = Number(parent);
  const watch = api.watchPid(variant.startsWith("watch:") ? Number(variant.slice(6)) : pid);
  let watcher: Worker | undefined;
  if (variant === "closed-watch") {
    watcher = new Worker(new URL(import.meta.url).href, { argv: ["close-watch-worker", String(watch), directory!] });
    await new Promise<void>(resolve => { watcher!.onmessage = () => resolve(); });
  }
  const before = readdirSync("/proc/self/fd").length;
  console.log("LISTEN");
  api.restrictBroker();
  let result: number;
  if (variant.startsWith("reply:")) {
    const socket = await accept(listener);
    const request = receivePacket(socket);
    const expected = fstatSync(request.fds[0]!, { bigint: true });
    const response = Buffer.alloc(80); request.data.copy(response, 0, 0, 32);
    [expected.dev, expected.ino, expected.mode, expected.uid, expected.gid, expected.ctimeNs].forEach((value, i) => response.writeBigUInt64LE(value, 32 + i * 8));
    if (variant === "reply:forged") response.writeBigUInt64LE(expected.ino + 1n, 40);
    if (variant === "reply:mutation") fchmodSync(request.fds[0]!, 0o750);
    sendPacket(socket, response, variant === "reply:descriptor" ? [control] : []);
    request.fds.forEach(closeSync); closeSync(socket); result = 0;
  } else result = api.serve(listener, variant === "wrong-peer" ? pid + 100000 : pid,
    (process.getuid?.() ?? 0) + (variant === "wrong-owner" ? 1 : 0),
    Buffer.from(bindingHex!, "hex"), 1, watch);
  const after = readdirSync("/proc/self/fd").length;
  console.log(JSON.stringify({ result, descriptor_delta: after - before }));
  watcher?.terminate(); if (variant !== "closed-watch") closeSync(watch); closeSync(listener); closeSync(control);
}

function packetLibc() { return dlopen("libc.so.6", {
  accept4: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  recvmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
  sendmsg: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i64_fast },
}); }
async function accept(listener: number): Promise<number> {
  const lib = packetLibc();
  try { for (let i = 0; i < 1000; i++) { const fd = lib.symbols.accept4(listener, null, null, 0x80000);
    if (fd >= 0) return fd; await Bun.sleep(1); } throw new Error("synthetic accept timeout");
  } finally { lib.close(); }
}
function receivePacket(socket: number): { data: Buffer; fds: number[] } {
  const lib = packetLibc(); const data = Buffer.alloc(80), control = Buffer.alloc(2048), io = Buffer.alloc(16), message = Buffer.alloc(56);
  io.writeBigUInt64LE(BigInt(ptr(data))); io.writeBigUInt64LE(BigInt(data.length), 8);
  message.writeBigUInt64LE(BigInt(ptr(io)), 16); message.writeBigUInt64LE(1n, 24);
  message.writeBigUInt64LE(BigInt(ptr(control)), 32); message.writeBigUInt64LE(BigInt(control.length), 40);
  try {
    const size = Number(lib.symbols.recvmsg(socket, ptr(message), 0x40000000)); if (size < 0) throw new Error("synthetic recv failed");
    const fds: number[] = []; const length = Number(message.readBigUInt64LE(40));
    for (let offset = 0; offset + 16 <= length;) {
      const n = Number(control.readBigUInt64LE(offset)); if (n < 16 || offset + n > length) throw new Error("synthetic malformed control");
      for (let j = offset + 16; j + 4 <= offset + n; j += 4) fds.push(control.readInt32LE(j)); offset += n + 7 & ~7;
    }
    return { data: data.subarray(0, size), fds };
  } finally { lib.close(); }
}
function sendPacket(socket: number, data: Buffer, fds: number[]): void {
  const lib = packetLibc(); const io = Buffer.alloc(16), message = Buffer.alloc(56), control = Buffer.alloc(16 + fds.length * 4 + 7 & ~7);
  io.writeBigUInt64LE(BigInt(ptr(data))); io.writeBigUInt64LE(BigInt(data.length), 8);
  message.writeBigUInt64LE(BigInt(ptr(io)), 16); message.writeBigUInt64LE(1n, 24);
  if (fds.length) {
    control.writeBigUInt64LE(BigInt(16 + fds.length * 4)); control.writeInt32LE(1, 8); control.writeInt32LE(1, 12);
    fds.forEach((fd, i) => control.writeInt32LE(fd, 16 + i * 4));
    message.writeBigUInt64LE(BigInt(ptr(control)), 32); message.writeBigUInt64LE(BigInt(control.length), 40);
  }
  try { if (Number(lib.symbols.sendmsg(socket, ptr(message), 0x4000)) !== data.length) throw new Error("synthetic send failed"); }
  finally { lib.close(); }
}
