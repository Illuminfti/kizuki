import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionFlavor } from "./config";
import { FIXTURE_FILES } from "./fixture";

export { FIXTURE_FILES, FIXTURE_NOW } from "./fixture";

/** Writes the synthetic transcripts for one flavor under `root`. */
export async function writeFixtureTree(root: string, flavor: SessionFlavor): Promise<void> {
  for (const [relpath, lines] of Object.entries(FIXTURE_FILES[flavor])) {
    const target = path.join(root, relpath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${lines.join("\n")}\n`);
  }
}
