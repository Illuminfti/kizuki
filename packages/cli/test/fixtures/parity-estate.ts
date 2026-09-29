// A synthetic memory stack for the parity tests. It is a plain local command:
// argv is `<mode> <keys-file|-> <log-file|-> ...query`; the last argument is the query.
import { appendFileSync, readFileSync } from "node:fs";

const [mode, keysFile, logFile, ...rest] = Bun.argv.slice(2);
const query = rest.at(-1) ?? "";
if (logFile !== undefined && logFile !== "-") appendFileSync(logFile, `${query}\n`);

function keys(): string {
  return keysFile === undefined || keysFile === "-" ? "" : readFileSync(keysFile, "utf8");
}

if (mode === "keys") {
  process.stdout.write(keys());
} else if (mode === "keys-unless-boom") {
  if (query.includes("boom")) {
    process.stderr.write("estate failure carrying private text: Vesper Quillfeather\n");
    process.exit(7);
  }
  process.stdout.write(keys());
} else if (mode === "fail") {
  process.stderr.write("estate failure carrying private text: Vesper Quillfeather\n");
  process.exit(7);
} else if (mode === "hang") {
  await Bun.sleep(60_000);
} else if (mode === "flood") {
  const chunk = "x".repeat(65_536);
  for (let index = 0; index < 64; index += 1) process.stdout.write(`${chunk}\n`);
} else {
  process.stderr.write("unknown fake stack mode\n");
  process.exit(9);
}
