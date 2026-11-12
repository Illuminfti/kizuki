import { afterAll } from "bun:test";
import { closeCapacityInventories } from "../../src/vault/capacity-inventory";

// bun test --parallel implies --isolate: every test file gets fresh module
// instances inside the same worker process. Bun closes the handles it tracks,
// but the capacity inventory opens its inotify descriptors through FFI, so a
// file's descriptors would outlive its module instance. Close them when the
// file ends, as a long-lived process would on shutdown.
afterAll(() => closeCapacityInventories());
