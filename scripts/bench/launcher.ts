import { executeChild } from "./process";

// Deliberately import no product code: the measured child starts from a small,
// consistent parent, not a harness retaining earlier vaults and query caches.
try {
  const request = JSON.parse(Bun.argv[2]!) as { argv: string[]; acceptedCodes: number[]; hasInput: boolean };
  const input = request.hasInput ? await Bun.stdin.text() : undefined;
  const measured = await executeChild(request.argv, input, request.acceptedCodes);
  process.stdout.write(JSON.stringify(measured) + "\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "measurement launcher failed"}\n`);
  process.exitCode = 1;
}
