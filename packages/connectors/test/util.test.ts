import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KizukiError } from "../src/errors";
import {
  isoToRfc3339,
  mediaTypeFor,
  readBoundedUtf8,
  readBoundedUtf8File,
  readFirstLine,
  requireKnownKeys,
  resolveSensitivity,
  safeFilename,
  statRegularFile,
  subjectSlug,
  unixSecondsToIso,
} from "../src/util";

async function withTempRoot<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-util-"));
  try {
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function thrown(body: () => unknown): KizukiError {
  try {
    body();
  } catch (error) {
    if (error instanceof KizukiError) return error;
    throw error;
  }
  throw new Error("expected a KizukiError");
}

async function rejected(body: () => Promise<unknown>): Promise<KizukiError> {
  try {
    await body();
  } catch (error) {
    if (error instanceof KizukiError) return error;
    throw error;
  }
  throw new Error("expected a KizukiError");
}

test("unixSecondsToIso accepts seconds as a number or a digit string", () => {
  expect(unixSecondsToIso(1_767_225_600, "row 1")).toBe(
    "2026-01-01T00:00:00.000Z",
  );
  expect(unixSecondsToIso("1767225600", "row 1")).toBe(
    "2026-01-01T00:00:00.000Z",
  );
});

test("unixSecondsToIso refuses anything outside the seconds range", () => {
  for (const value of [0, -1, 2 ** 41, "", "12x", "1.5", null, undefined]) {
    const error = thrown(() =>
      unixSecondsToIso(value, "part_000000.csv row 7"),
    );
    expect(error.code).toBe("parse_error");
    expect(error.message).toBe("part_000000.csv row 7: invalid unix timestamp");
  }
});

test("isoToRfc3339 normalizes an offset timestamp to UTC", () => {
  expect(isoToRfc3339("2026-01-02T10:00:00+02:00", "item 0")).toBe(
    "2026-01-02T08:00:00.000Z",
  );
  const error = thrown(() => isoToRfc3339("not-a-date", "item 0"));
  expect(error.code).toBe("parse_error");
  expect(error.message).toBe("item 0: invalid timestamp");
});

test("readBoundedUtf8 strips a leading BOM and normalizes newlines", async () => {
  await withTempRoot(async (root) => {
    const file = path.join(root, "export.txt");
    await writeFile(file, "﻿one\r\ntwo\rthree\n");
    expect(await readBoundedUtf8(file, "kizuki.test")).toBe(
      "one\ntwo\nthree\n",
    );
  });
});

test("readBoundedUtf8 refuses an oversize file before reading it", async () => {
  await withTempRoot(async (root) => {
    const file = path.join(root, "export.txt");
    await writeFile(file, "x".repeat(64));
    const error = await rejected(() =>
      readBoundedUtf8(file, "kizuki.test", 16),
    );
    expect(error.code).toBe("misconfigured");
    expect(error.message).toContain("exceeds the 16 byte import limit");
  });
});

test("readBoundedUtf8 refuses a symlink and a directory", async () => {
  await withTempRoot(async (root) => {
    const target = path.join(root, "target.txt");
    const link = path.join(root, "link.txt");
    const directory = path.join(root, "sub");
    await writeFile(target, "payload\n");
    await symlink(target, link);
    await mkdir(directory);
    for (const candidate of [link, directory]) {
      const error = await rejected(() =>
        readBoundedUtf8(candidate, "kizuki.test"),
      );
      expect(error.code).toBe("misconfigured");
      expect(error.message).toContain("not a regular file");
    }
  });
});

test("readBoundedUtf8 rejects invalid UTF-8 without quoting the bytes", async () => {
  await withTempRoot(async (root) => {
    const file = path.join(root, "export.txt");
    await writeFile(file, Buffer.from([0x41, 0xff, 0x42]));
    const error = await rejected(() => readBoundedUtf8(file, "kizuki.test"));
    expect(error.code).toBe("parse_error");
    expect(error.message).toBe("kizuki.test: export.txt is not valid UTF-8");
  });
});

test("readFirstLine reads one line without paying for the file", async () => {
  await withTempRoot(async (root) => {
    const file = path.join(root, "part_000000.csv");
    await writeFile(file, "\ufefftitle,url\r\nrow,two\n");
    expect(await readFirstLine(file, "kizuki.test")).toBe("title,url");

    await writeFile(file, "no line break here");
    expect(await readFirstLine(file, "kizuki.test")).toBe("no line break here");
    const unbroken = await rejected(() =>
      readFirstLine(file, "kizuki.test", 4),
    );
    expect(unbroken.code).toBe("parse_error");
    expect(unbroken.message).toContain("no line break");

    await symlink(file, path.join(root, "link.csv"));
    const linked = await rejected(() =>
      readFirstLine(path.join(root, "link.csv"), "kizuki.test"),
    );
    expect(linked.code).toBe("misconfigured");
    expect(linked.message).toContain("not a regular file");
  });
});

test("statRegularFile sizes plain files and ignores everything else", async () => {
  await withTempRoot(async (root) => {
    const file = path.join(root, "photo.jpg");
    await writeFile(file, "0123456789");
    await symlink(file, path.join(root, "link.jpg"));
    await mkdir(path.join(root, "sub"));
    expect(await statRegularFile(file)).toEqual({ byte_size: 10 });
    expect(await statRegularFile(path.join(root, "link.jpg"))).toBeNull();
    expect(await statRegularFile(path.join(root, "sub"))).toBeNull();
    expect(await statRegularFile(path.join(root, "missing.jpg"))).toBeNull();
  });
});

test("safeFilename accepts bare names only", () => {
  expect(safeFilename("IMG-20260104-WA0001.jpg")).toBe(
    "IMG-20260104-WA0001.jpg",
  );
  for (const name of [
    "",
    ".",
    "..",
    "../../etc/passwd",
    "a/b.jpg",
    "a\\b.jpg",
    "-rf.jpg",
    "bad\u0000name.jpg",
    "bad\u001bname.jpg",
    "x".repeat(256),
  ]) {
    expect(safeFilename(name)).toBeNull();
  }
});

test("subjectSlug folds a display name into one readable segment", () => {
  expect(subjectSlug("Ada")).toBe("ada");
  expect(subjectSlug("  Acme Planning  ")).toBe("acme-planning");
  expect(subjectSlug("‮ada‬")).toBe("ada");
  expect(subjectSlug("+1 (555) 010-9999")).toBe("1-555-010-9999");
  expect(subjectSlug("!!!")).toBe("unknown");
  expect(subjectSlug("a".repeat(200))).toBe("a".repeat(128));
});

test("requireKnownKeys names the offending key", () => {
  expect(() =>
    requireKnownKeys({ path: "/x" }, "kizuki.test", ["path"]),
  ).not.toThrow();
  const error = thrown(() =>
    requireKnownKeys({ path: "/x", tz: "+02:00" }, "kizuki.test", ["path"]),
  );
  expect(error.code).toBe("misconfigured");
  expect(error.message).toBe("kizuki.test: unknown config key tz");
});

test("mediaTypeFor declares a type from the extension alone", () => {
  expect(mediaTypeFor("IMG-20260104-WA0001.jpg")).toBe("image/jpeg");
  expect(mediaTypeFor("clip.MP4")).toBe("video/mp4");
  expect(mediaTypeFor("voice.opus")).toBe("audio/ogg");
  expect(mediaTypeFor("card.vcf")).toBe("text/vcard");
  expect(mediaTypeFor("notes")).toBe("application/octet-stream");
  expect(mediaTypeFor("archive.tar.zst")).toBe("application/octet-stream");
});

test("a bounded read reports the bytes it cost, not the bytes it kept", async () => {
  await withTempRoot(async (root) => {
    const file = path.join(root, "crlf.csv");
    const raw = "\ufeffa,b\r\nc,d\r\n";
    await writeFile(file, raw);
    const read = await readBoundedUtf8File(file, "kizuki.test");
    expect(read.text).toBe("a,b\nc,d\n");
    expect(read.byte_size).toBe(Buffer.byteLength(raw, "utf8"));
    expect(read.byte_size).toBeGreaterThan(
      Buffer.byteLength(read.text, "utf8"),
    );
  });
});

test("a source's own sensitivity claim is honored only upward", () => {
  const policy = {
    default_sensitivity: "personal",
    sensitivity_floor: "personal",
  } as const;
  // No hint, and a hint that is not a label at all, take the default.
  for (const hint of [undefined, null, "", "secret", 3]) {
    expect(resolveSensitivity(policy, hint)).toBe("personal");
  }
  expect(resolveSensitivity(policy, "private")).toBe("private");
  // Below the floor: raised to it rather than believed.
  expect(resolveSensitivity(policy, "public")).toBe("personal");
  expect(
    resolveSensitivity(
      { default_sensitivity: "personal", sensitivity_floor: "public" },
      "public",
    ),
  ).toBe("public");
});

test("a source with no policy at all is private, not unlabeled", () => {
  expect(resolveSensitivity({})).toBe("private");
  expect(resolveSensitivity({}, "public")).toBe("private");
});
