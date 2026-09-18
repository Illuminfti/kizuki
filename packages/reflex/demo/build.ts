/** Build a single offline HTML file; requires the repository's Bun runtime. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const built = await Bun.build({ entrypoints: [join(here, "browser.ts")], target: "browser", minify: false });
if (!built.success || built.outputs.length !== 1) throw new Error("reflex demo build failed");
const javascript = (await built.outputs[0]!.text()).replace(/<\/script/gi, "<\\/script");
const template = await Bun.file(join(here, "index.html")).text();
await Bun.write(join(here, "reflex-demo.html"), template.replace("/* REFLEX_BUNDLE */", () => javascript));
console.log("Created packages/reflex/demo/reflex-demo.html (synthetic, offline)");
