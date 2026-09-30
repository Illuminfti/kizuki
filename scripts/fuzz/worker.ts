import { KizukiError } from "../../packages/core/src/index";
import { cases } from "./cases";
import { PARSERS, parseCase } from "./parsers";
import type { Parser } from "./parsers";
import { FILE_TARGETS, fileCase } from "./files";
import type { FileTarget } from "./files";
import { SURFACES, surfaceDriver } from "./surfaces";
import { peakRssKiB } from "./rss";
import { ScreenpipeConnectorError } from "../../packages/connector-screenpipe/src/errors";

const [target, seedText, countText, scratch] = process.argv.slice(2);
if (!target || !scratch || !seedText || !countText) throw new Error("invalid fuzz worker configuration");
const seed = Number(seedText), count = Number(countText);
let completed = 0;
let activeCase = "startup";
const originalFetch = globalThis.fetch;
let httpOrigin: string | null = null;
globalThis.fetch = ((input: string | URL | Request, options?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== httpOrigin) throw new Error("network-egress");
  return originalFetch(input, { ...options, redirect: "error" });
}) as typeof fetch;

async function outcome(parser: Parser, input: Parameters<typeof parseCase>[1], wrapped: boolean): Promise<string> {
  try {
    const result = JSON.stringify(await parseCase(parser, input, wrapped));
    if (result !== undefined && result.length > 8 * 1024 * 1024) throw new Error("output-unbounded");
    return new Bun.CryptoHasher("sha256").update(result ?? "undefined").digest("hex");
  } catch (error) {
    if (error instanceof KizukiError) return `refused:${error.code}`;
    if (error instanceof ScreenpipeConnectorError) return `refused:${error.code}`;
    if (parser === "canon-frontmatter" && error instanceof SyntaxError) return "refused:frontmatter";
    throw error;
  }
}

let surface: Awaited<ReturnType<typeof surfaceDriver>> | undefined;
try {
  if ((SURFACES as readonly string[]).includes(target)) {
    surface = await surfaceDriver(target as typeof SURFACES[number], scratch);
    httpOrigin = surface.httpOrigin;
  }
  for (const input of cases(seed, count)) {
    activeCase = input.id;
    process.stdout.write(JSON.stringify({ case: activeCase }) + "\n");
    if ((PARSERS as readonly string[]).includes(target)) {
      for (const wrapped of [false, true]) {
        if (await outcome(target as Parser, input, wrapped) !== await outcome(target as Parser, input, wrapped)) throw new Error("nondeterministic-parser");
      }
    } else if ((FILE_TARGETS as readonly string[]).includes(target)) await fileCase(target as FileTarget, input, scratch);
    else if (surface) await surface.run(input);
    else throw new Error("unknown-target");
    if (({} as Record<string, unknown>)["polluted"] !== undefined) throw new Error("prototype-pollution");
    completed += 1;
  }
  await surface?.close();
  surface = undefined;
  process.stdout.write(JSON.stringify({ completed, maxRssKiB: peakRssKiB() }) + "\n");
} catch (error) {
  // Never print error messages/causes or captured text. Case ids and seed replay it.
  const properties = ["invalid-ingress", "sensitivity-lowered", "output-unbounded", "nondeterministic-parser", "prototype-pollution", "network-egress", "symlink-admitted", "invalid-encoding-admitted", "archive-expansion-admitted", "resume-lost", "oversized-file-admitted", "projection-unreached", "inert-grant-admitted", "http-crash", "capture-trust-confusion"];
  const property = error instanceof Error && properties.includes(error.message) ? error.message : "unexpected-exception";
  process.stdout.write(JSON.stringify({ failed: true, case: activeCase, property, completed }) + "\n");
  process.exitCode = 1;
} finally { await surface?.close(); }
