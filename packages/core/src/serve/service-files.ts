import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Service definitions and transaction snapshots are private, bounded local files. */
export function serviceFile(path: string): string | null {
  let before;
  try { before = lstatSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("unsafe service file");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("unsafe service file"); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 512 * 1024 || stat.ino !== before.ino || stat.dev !== before.dev ||
      stat.uid !== process.geteuid?.() || (stat.mode & 0o022) !== 0) throw new Error("unsafe service file");
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
  } finally { closeSync(fd); }
}

export function serviceDirectory(anchor: string, directory: string): void {
  if (!isAbsolute(anchor)) throw new Error("service home must be an absolute directory");
  const rel = relative(anchor, directory);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("service path escapes its owner directory");
  let current = resolve(anchor);
  for (const part of ["", ...rel.split("/").filter(Boolean)]) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.() || (stat.mode & 0o022) !== 0) throw new Error("unsafe service directory");
  }
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function replaceServiceFile(path: string, body: string | null): void {
  const previous = serviceFile(path);
  if (body === null) {
    if (previous !== null) { unlinkSync(path); syncDirectory(dirname(path)); }
    return;
  }
  if (Buffer.byteLength(body) > 512 * 1024) throw new Error("service file exceeds its bound");
  const temporary = join(dirname(path), `.kizuki-service-${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let published = false;
  let closed = false;
  try {
    writeFileSync(fd, body, "utf8"); fsyncSync(fd); closeSync(fd); closed = true;
    if (serviceFile(path) !== previous) throw new Error("service file changed during replacement");
    renameSync(temporary, path); published = true; syncDirectory(dirname(path));
  } finally {
    if (!closed) closeSync(fd);
    if (!published) unlinkSync(temporary);
  }
}
