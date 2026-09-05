import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { archiveError } from "./errors";
import { nativeId } from "./ids";
import { mapPost } from "./map";
import { parseYtd, requiredObject } from "./ytd";

export const MAX_ACCOUNT_BYTES = 1024 * 1024;
export const MAX_PART_BYTES = 16 * 1024 * 1024;
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_TWEET_PARTS = 64;
export const MAX_POSTS = 100_000;
export const MAX_MEDIA_ENTRIES = 10_000;
export const MAX_DATA_ENTRIES = 1024;

export interface FileIdentity {
  dev: string;
  ino: string;
  size: number;
  mtime_ns: string;
  ctime_ns: string;
}

export interface FileDescriptor {
  name: string;
  path: string;
  identity: FileIdentity;
  sha256: string;
}

export interface MediaEntry {
  filename: string;
  byte_size: number;
  media_type: string;
  path: string;
  identity: FileIdentity;
}

export interface XArchiveIdentity {
  account_id: string;
  username: string | null;
}

export interface TweetPart {
  part: number;
  records: number;
  file: FileDescriptor;
}

export interface XArchiveSnapshot {
  root: { path: string; identity: FileIdentity };
  data: { path: string; identity: FileIdentity };
  account: FileDescriptor;
  identity: XArchiveIdentity;
  parts: TweetPart[];
  media: ReadonlyMap<string, readonly MediaEntry[]>;
  mediaDirectory: { path: string; identity: FileIdentity } | null;
  sha256: string;
  total_posts: number;
  coverage: XArchiveCoverage;
}

export interface XArchiveCoverage {
  posts: number;
  tweet_parts: number;
  media_references: number;
  media_bytes: "not_supported";
  likes: "not_inspected";
  bookmarks: "not_supported";
  direct_messages: "not_supported";
  deletions: "not_supported";
  zip: "not_supported";
}

const TWEETS = /^tweets(?:-part([1-9][0-9]*))?\.js$/;
const UNSUPPORTED_LIKES = /^like(?:-part[1-9][0-9]*)?\.js$/;
const UNSUPPORTED_DMS = /^direct-messages?(?:-group)?(?:-part[1-9][0-9]*)?\.js$/;
const PORTABLE_MEDIA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

function identityOf(info: BigIntStats): FileIdentity {
  if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw archiveError("misconfigured", "archive file size cannot be represented safely");
  }
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    size: Number(info.size),
    mtime_ns: String(info.mtimeNs),
    ctime_ns: String(info.ctimeNs),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtime_ns === right.mtime_ns &&
    left.ctime_ns === right.ctime_ns;
}

async function inspectDirectory(directory: string, label: string): Promise<FileIdentity> {
  let info: BigIntStats;
  try {
    info = await lstat(directory, { bigint: true });
  } catch (error) {
    throw archiveError("misconfigured", `cannot inspect ${label}`, error);
  }
  if (info.isSymbolicLink()) {
    throw archiveError("misconfigured", `refusing symlink ${label}`);
  }
  if (info.isFile()) {
    throw archiveError("not_supported", "ZIP archives are not supported; unzip the archive and pass its directory");
  }
  if (!info.isDirectory()) {
    throw archiveError("misconfigured", `${label} is not a directory`);
  }
  return identityOf(info);
}

async function openRegular(filePath: string, label: string): Promise<FileHandle> {
  let handle: FileHandle;
  try {
    handle = await open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    throw archiveError("misconfigured", `cannot open ${label}`, error);
  }
  let info: BigIntStats;
  try {
    info = await handle.stat({ bigint: true });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw archiveError("misconfigured", `cannot inspect ${label}`, error);
  }
  if (!info.isFile()) {
    await handle.close().catch(() => undefined);
    throw archiveError("misconfigured", `${label} is not a regular file`);
  }
  return handle;
}

async function readBounded(
  handle: FileHandle,
  maximum: number,
  label: string,
): Promise<{ bytes: Buffer; identity: FileIdentity }> {
  const before = identityOf(await handle.stat({ bigint: true }));
  if (before.size > maximum) {
    throw archiveError("misconfigured", `${label} exceeds ${maximum} bytes; split or reduce the archive export`);
  }
  const bytes = Buffer.alloc(before.size + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const read = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset > maximum) {
    throw archiveError("misconfigured", `${label} exceeds ${maximum} bytes; split or reduce the archive export`);
  }
  const after = identityOf(await handle.stat({ bigint: true }));
  if (!sameIdentity(before, after) || offset !== before.size) {
    throw archiveError("unavailable", "archive changed while it was being read; retry the import");
  }
  return { bytes: bytes.subarray(0, offset), identity: before };
}

function decode(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw archiveError("parse_error", `${label} is not valid UTF-8`, error);
  }
}

function digest(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function feed(hasher: Bun.CryptoHasher, label: string, bytes: Uint8Array | string): void {
  const size = typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength;
  hasher.update(`${label.length}:${label}:${size}:`);
  hasher.update(bytes);
}

async function closeDirectory(stream: Awaited<ReturnType<typeof opendir>>): Promise<void> {
  try {
    await stream.close();
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ERR_DIR_CLOSED") throw error;
  }
}

function parseAccount(source: string): XArchiveIdentity {
  const records = parseYtd(source, "account", 0);
  if (records.length !== 1) {
    throw archiveError("parse_error", "account part 0 must contain exactly one account");
  }
  const envelope = requiredObject(records[0], "account record");
  const account = requiredObject(envelope["account"], "account record.account");
  const accountId = nativeId(account["accountId"], "account id");
  const username = account["username"];
  if (username !== undefined &&
    (typeof username !== "string" || !/^[A-Za-z0-9_]{1,64}$/.test(username))) {
    throw archiveError("parse_error", "account username is invalid");
  }
  return { account_id: accountId, username: username ?? null };
}

function mediaType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  switch (extension) {
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp4": return "video/mp4";
    case ".mov": return "video/quicktime";
    default: return "application/octet-stream";
  }
}

async function scanMedia(directory: string): Promise<{
  directory: { path: string; identity: FileIdentity } | null;
  byPost: ReadonlyMap<string, readonly MediaEntry[]>;
  count: number;
}> {
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { directory: null, byPost: new Map(), count: 0 };
    }
    throw archiveError("misconfigured", "cannot inspect tweets_media", error);
  }
  const directoryIdentity = await inspectDirectory(directory, "tweets_media");
  const mutable = new Map<string, MediaEntry[]>();
  let entries = 0;
  let references = 0;
  const stream = await opendir(directory);
  try {
    for await (const entry of stream) {
      entries += 1;
      if (entries > MAX_MEDIA_ENTRIES) {
        throw archiveError("misconfigured", `tweets_media exceeds ${MAX_MEDIA_ENTRIES} entries; media references were not imported`);
      }
      if (!PORTABLE_MEDIA_NAME.test(entry.name)) {
        throw archiveError("misconfigured", "tweets_media contains a non-portable filename");
      }
      const itemPath = path.join(directory, entry.name);
      const info = await lstat(itemPath, { bigint: true });
      if (info.isSymbolicLink()) {
        throw archiveError("misconfigured", "refusing symlink in tweets_media");
      }
      if (!info.isFile()) continue;
      const separator = entry.name.indexOf("-");
      if (separator <= 0) continue;
      const prefix = entry.name.slice(0, separator);
      if (!/^[0-9]{1,20}$/.test(prefix)) continue;
      const media: MediaEntry = {
        filename: entry.name,
        byte_size: Number(info.size),
        media_type: mediaType(entry.name),
        path: itemPath,
        identity: identityOf(info),
      };
      references += 1;
      const found = mutable.get(prefix) ?? [];
      found.push(media);
      mutable.set(prefix, found);
    }
  } finally {
    await closeDirectory(stream);
  }
  for (const items of mutable.values()) {
    items.sort((a, b) => a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0);
    if (items.length > 256) {
      throw archiveError("parse_error", "one post has more than 256 media references");
    }
  }
  return {
    directory: { path: directory, identity: directoryIdentity },
    byPost: mutable,
    count: references,
  };
}

export async function scanArchive(rootPath: string): Promise<XArchiveSnapshot> {
  const root = path.resolve(rootPath);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    throw archiveError("misconfigured", "cannot resolve archive root", error);
  }
  if (canonicalRoot !== root) {
    throw archiveError("misconfigured", "refusing archive path with a symlink component");
  }
  const rootIdentity = await inspectDirectory(root, "archive root");
  const dataPath = path.join(root, "data");
  const dataIdentity = await inspectDirectory(dataPath, "archive data directory");
  let accountPath: string | null = null;
  const tweetPaths = new Map<number, string>();
  let likesPresent = false;
  let directMessagesPresent = false;
  let entries = 0;
  const stream = await opendir(dataPath);
  try {
    for await (const entry of stream) {
      entries += 1;
      if (entries > MAX_DATA_ENTRIES) {
        throw archiveError("misconfigured", `archive data directory exceeds ${MAX_DATA_ENTRIES} entries`);
      }
      if (entry.name === "account.js") accountPath = path.join(dataPath, entry.name);
      const tweets = TWEETS.exec(entry.name);
      if (tweets !== null) {
        const part = tweets[1] === undefined ? 0 : Number(tweets[1]);
        if (!Number.isSafeInteger(part) || part >= MAX_TWEET_PARTS || tweetPaths.has(part)) {
          throw archiveError("misconfigured", `tweet parts must be unique and numbered 0 through ${MAX_TWEET_PARTS - 1}`);
        }
        tweetPaths.set(part, path.join(dataPath, entry.name));
      }
      if (UNSUPPORTED_LIKES.test(entry.name)) likesPresent = true;
      if (UNSUPPORTED_DMS.test(entry.name)) directMessagesPresent = true;
    }
  } finally {
    await closeDirectory(stream);
  }
  if (accountPath === null) {
    throw archiveError("misconfigured", "archive has no data/account.js; posts cannot be attributed to an account");
  }
  if (tweetPaths.size === 0) {
    throw archiveError("misconfigured", "archive has no data/tweets.js");
  }
  const ordered = [...tweetPaths.entries()].sort(([a], [b]) => a - b);
  ordered.forEach(([part], ordinal) => {
    if (part !== ordinal) {
      throw archiveError("misconfigured", "tweet parts are not contiguous from data/tweets.js");
    }
  });

  const hasher = new Bun.CryptoHasher("sha256");
  const accountHandle = await openRegular(accountPath, "data/account.js");
  let accountRead: { bytes: Buffer; identity: FileIdentity };
  try {
    accountRead = await readBounded(accountHandle, MAX_ACCOUNT_BYTES, "data/account.js");
  } finally {
    await accountHandle.close().catch(() => undefined);
  }
  feed(hasher, "data/account.js", accountRead.bytes);
  const account: FileDescriptor = {
    name: "data/account.js",
    path: accountPath,
    identity: accountRead.identity,
    sha256: digest(accountRead.bytes),
  };
  const identity = parseAccount(decode(accountRead.bytes, "data/account.js"));

  const media = await scanMedia(path.join(dataPath, "tweets_media"));
  for (const items of media.byPost.values()) {
    for (const item of items) feed(hasher, `media:${item.filename}`, String(item.byte_size));
  }
  feed(hasher, "unsupported:likes", String(likesPresent));
  feed(hasher, "unsupported:direct_messages", String(directMessagesPresent));

  const seen = new Set<string>();
  const parts: TweetPart[] = [];
  let aggregateBytes = accountRead.bytes.byteLength;
  let totalPosts = 0;
  for (const [part, partPath] of ordered) {
    const label = part === 0 ? "data/tweets.js" : `data/tweets-part${part}.js`;
    const handle = await openRegular(partPath, label);
    let read: { bytes: Buffer; identity: FileIdentity };
    try {
      read = await readBounded(handle, MAX_PART_BYTES, label);
    } finally {
      await handle.close().catch(() => undefined);
    }
    aggregateBytes += read.bytes.byteLength;
    if (aggregateBytes > MAX_ARCHIVE_BYTES) {
      throw archiveError("misconfigured", `selected archive JSON exceeds ${MAX_ARCHIVE_BYTES} bytes; split the import or wait for streaming support`);
    }
    feed(hasher, label, read.bytes);
    const records = parseYtd(decode(read.bytes, label), "tweets", part);
    totalPosts += records.length;
    if (totalPosts > MAX_POSTS) {
      throw archiveError("misconfigured", `archive has more than ${MAX_POSTS} posts; split the import or wait for streaming support`);
    }
    records.forEach((record, index) => {
      const id = mapPost(record, part, index, identity, media.byPost, null)
        .event.source_record_id;
      if (seen.has(id)) {
        throw archiveError("parse_error", "archive contains a duplicate native post id");
      }
      seen.add(id);
    });
    parts.push({
      part,
      records: records.length,
      file: { name: label, path: partPath, identity: read.identity, sha256: digest(read.bytes) },
    });
  }
  const coverage: XArchiveCoverage = {
    posts: totalPosts,
    tweet_parts: parts.length,
    media_references: media.count,
    media_bytes: "not_supported",
    likes: "not_inspected",
    bookmarks: "not_supported",
    direct_messages: "not_supported",
    deletions: "not_supported",
    zip: "not_supported",
  };
  const snapshot: XArchiveSnapshot = {
    root: { path: root, identity: rootIdentity },
    data: { path: dataPath, identity: dataIdentity },
    account,
    identity,
    parts,
    media: media.byPost,
    mediaDirectory: media.directory,
    sha256: hasher.digest("hex"),
    total_posts: totalPosts,
    coverage,
  };
  await assertSnapshotStable(snapshot);
  return snapshot;
}

async function assertPathIdentity(pathname: string, expected: FileIdentity): Promise<void> {
  let current: BigIntStats;
  try {
    current = await lstat(pathname, { bigint: true });
  } catch (error) {
    throw archiveError("unavailable", "archive changed while it was being imported; retry", error);
  }
  if (current.isSymbolicLink() || !sameIdentity(identityOf(current), expected)) {
    throw archiveError("unavailable", "archive changed while it was being imported; retry");
  }
}

export async function readTweetPart(
  snapshot: XArchiveSnapshot,
  ordinal: number,
): Promise<unknown[]> {
  const descriptor = snapshot.parts[ordinal];
  if (descriptor === undefined) throw archiveError("parse_error", "cursor points outside the archive");
  await assertSnapshotStable(snapshot);
  const handle = await openRegular(descriptor.file.path, descriptor.file.name);
  let read: { bytes: Buffer; identity: FileIdentity };
  try {
    read = await readBounded(handle, MAX_PART_BYTES, descriptor.file.name);
  } finally {
    await handle.close().catch(() => undefined);
  }
  if (!sameIdentity(read.identity, descriptor.file.identity) || digest(read.bytes) !== descriptor.file.sha256) {
    throw archiveError("unavailable", "archive changed while it was being imported; retry");
  }
  return parseYtd(decode(read.bytes, descriptor.file.name), "tweets", descriptor.part);
}

export async function assertSnapshotStable(snapshot: XArchiveSnapshot): Promise<void> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(snapshot.root.path);
  } catch (error) {
    throw archiveError("unavailable", "archive changed while it was being imported; retry", error);
  }
  if (canonicalRoot !== snapshot.root.path) {
    throw archiveError("unavailable", "archive changed while it was being imported; retry");
  }
  await assertPathIdentity(snapshot.root.path, snapshot.root.identity);
  await assertPathIdentity(snapshot.data.path, snapshot.data.identity);
  await assertPathIdentity(snapshot.account.path, snapshot.account.identity);
  for (const part of snapshot.parts) await assertPathIdentity(part.file.path, part.file.identity);
  if (snapshot.mediaDirectory !== null) {
    await assertPathIdentity(snapshot.mediaDirectory.path, snapshot.mediaDirectory.identity);
  }
  for (const entries of snapshot.media.values()) {
    for (const entry of entries) await assertPathIdentity(entry.path, entry.identity);
  }
}

export async function assertMediaStable(entries: readonly MediaEntry[]): Promise<void> {
  for (const entry of entries) await assertPathIdentity(entry.path, entry.identity);
}

export function coverageDetail(coverage: XArchiveCoverage): string {
  return [
    `posts=${coverage.posts}`,
    `parts=${coverage.tweet_parts}`,
    `media_refs=${coverage.media_references}`,
    `media_bytes=${coverage.media_bytes}`,
    `likes=${coverage.likes}`,
    `bookmarks=${coverage.bookmarks}`,
    `direct_messages=${coverage.direct_messages}`,
    `deletions=${coverage.deletions}`,
    `zip=${coverage.zip}`,
  ].join("; ");
}
