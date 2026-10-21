import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createIcsConnector } from "../src/connector";
import { FIXTURE_ICS, FIXTURE_NOW } from "../src/fixture";
import { MAX_ICS_CHARS } from "../src/unfold";

test.each(["symlink", "invalid-utf8", "directory", "fifo", "oversized"])("ICS backfill refuses a %s source and allows a valid retry", async kind => {
  const scratch = mkdtempSync(join(tmpdir(), "kizuki-ics-hostile-"));
  try {
    const file = join(scratch, "calendar.ics");
    if (kind === "symlink") {
      const other = join(scratch, "other.ics");
      writeFileSync(other, FIXTURE_ICS);
      symlinkSync(other, file);
    } else if (kind === "invalid-utf8") {
      writeFileSync(file, Buffer.concat([
        Buffer.from(FIXTURE_ICS.replace("END:VCALENDAR", "X-SYNTHETIC:")),
        Buffer.from([0xff]), Buffer.from("\nEND:VCALENDAR\n"),
      ]));
    } else if (kind === "directory") {
      mkdirSync(file);
    } else if (kind === "fifo") {
      expect(Bun.spawnSync(["mkfifo", file]).exitCode).toBe(0);
    } else {
      writeFileSync(file, "");
      truncateSync(file, MAX_ICS_CHARS + 1);
    }
    const connector = createIcsConnector({ path: file }, { now: () => FIXTURE_NOW });
    await expect(connector.backfill(null)).rejects.toMatchObject({ code: ["invalid-utf8", "oversized"].includes(kind) ? "parse_error" : "misconfigured" });
    rmSync(file, { recursive: true });
    writeFileSync(file, FIXTURE_ICS);
    expect((await connector.backfill(null)).events.length).toBeGreaterThan(0);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
