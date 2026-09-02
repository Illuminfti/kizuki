import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { KizukiError } from "./errors";
import {
  boundedFile,
  firstLineOf,
  headOf,
  notARegularFile,
  openFile,
  readReason,
} from "./read";
import type { BoundedFile } from "./read";
import { MAX_EXPORT_BYTES, safeFilename } from "./util";

/**
 * A directory an importer listed, remembered by identity rather than by name.
 * Anything with write access to a directory above an export can point its name
 * at another directory between the listing and the read; the inode the name
 * stood for cannot become a different one.
 */
export interface ExportFolder {
  path: string;
  dev: number;
  ino: number;
}

/** The folder a path names right now, or `null` if it names anything else. */
export async function exportFolder(path: string): Promise<ExportFolder | null> {
  try {
    const info = await lstat(path);
    return info.isDirectory() ? { path, dev: info.dev, ino: info.ino } : null;
  } catch {
    return null;
  }
}

/**
 * An open directory has a path of its own on this platform, so a child can be
 * resolved from the descriptor for the folder that was listed instead of from
 * a name a parent could have been repointed under. Probed once. Where it is
 * missing, the identity check below is all there is: the window narrows to the
 * moment between the check and the open rather than closing.
 */
const DESCRIPTOR_DIRECTORY = "/proc/self/fd";

let descriptorPaths: Promise<boolean> | undefined;

function descriptorPathsAvailable(): Promise<boolean> {
  descriptorPaths ??= stat(DESCRIPTOR_DIRECTORY).then(
    () => true,
    () => false,
  );
  return descriptorPaths;
}

/**
 * Opens the folder that was listed, or refuses. A symlink is not a directory
 * to `O_NOFOLLOW`, and a directory that is no longer the one whose identity
 * was recorded is not the export.
 */
async function openFolder(folder: ExportFolder): Promise<FileHandle> {
  const handle = await open(
    folder.path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const info = await handle.stat().catch(async (error: unknown) => {
    await handle.close();
    throw error;
  });
  if (
    !info.isDirectory() ||
    info.dev !== folder.dev ||
    info.ino !== folder.ino
  ) {
    await handle.close();
    throw new Error("the export folder was replaced while it was read");
  }
  return handle;
}

/** Where a child of the open folder is read from, anchored where it can be. */
async function childPath(
  folder: ExportFolder,
  handle: FileHandle,
  name: string,
): Promise<string> {
  return (await descriptorPathsAvailable())
    ? `${DESCRIPTOR_DIRECTORY}/${handle.fd}/${name}`
    : join(folder.path, name);
}

/** The entries of the folder that was listed, taken from the folder itself. */
export async function folderEntries(folder: ExportFolder): Promise<Dirent[]> {
  const handle = await openFolder(folder);
  try {
    const at = (await descriptorPathsAvailable())
      ? `${DESCRIPTOR_DIRECTORY}/${handle.fd}`
      : folder.path;
    return await readdir(at, { withFileTypes: true });
  } finally {
    await handle.close();
  }
}

/** A directory inside the folder that was listed, with its own identity. */
export async function folderSubdirectory(
  folder: ExportFolder,
  name: string,
): Promise<ExportFolder | null> {
  if (safeFilename(name) === null) return null;
  let handle: FileHandle;
  try {
    handle = await openFolder(folder);
  } catch {
    return null;
  }
  try {
    const info = await lstat(await childPath(folder, handle, name));
    return info.isDirectory()
      ? { path: join(folder.path, name), dev: info.dev, ino: info.ino }
      : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/**
 * Size of a file inside the folder that was listed. Anything else — missing,
 * a symlink, a directory, or a folder that is no longer itself — is simply
 * absent, so a broken export costs a reference rather than the import.
 */
export async function statFolderFile(
  folder: ExportFolder,
  name: string,
): Promise<{ byte_size: number } | null> {
  if (safeFilename(name) === null) return null;
  let handle: FileHandle;
  try {
    handle = await openFolder(folder);
  } catch {
    return null;
  }
  try {
    const info = await lstat(await childPath(folder, handle, name));
    return info.isFile() ? { byte_size: info.size } : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

async function openFolderFile(
  folder: ExportFolder,
  name: string,
  connectorId: string,
  label: string,
): Promise<FileHandle> {
  if (safeFilename(name) === null) throw notARegularFile(label, connectorId);
  let directory: FileHandle;
  try {
    directory = await openFolder(folder);
  } catch (error) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: cannot read ${label}: ${readReason(error)}`,
      { cause: error },
    );
  }
  try {
    return await openFile(
      await childPath(folder, directory, name),
      connectorId,
      label,
    );
  } finally {
    await directory.close();
  }
}

/** Reads a file of the folder that was listed, under the same bounds. */
export async function readFolderFile(
  folder: ExportFolder,
  name: string,
  connectorId: string,
  maxBytes = MAX_EXPORT_BYTES,
  label = name,
): Promise<BoundedFile> {
  return boundedFile(
    await openFolderFile(folder, name, connectorId, label),
    connectorId,
    maxBytes,
    label,
  );
}

/** The first line of a file of the folder that was listed. */
export async function readFolderFirstLine(
  folder: ExportFolder,
  name: string,
  connectorId: string,
  label = name,
): Promise<string> {
  return firstLineOf(
    await openFolderFile(folder, name, connectorId, label),
    connectorId,
    label,
  );
}

/** The opening bytes of a file of the folder that was listed. */
export async function readFolderHead(
  folder: ExportFolder,
  name: string,
  connectorId: string,
  windowBytes: number,
  label = name,
): Promise<Buffer> {
  return headOf(
    await openFolderFile(folder, name, connectorId, label),
    connectorId,
    label,
    windowBytes,
  );
}
