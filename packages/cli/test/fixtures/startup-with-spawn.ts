import "./deny-spawn-preload.ts";

try {
  Bun.spawn({ cmd: ["true"] });
} catch {
  undefined;
}
