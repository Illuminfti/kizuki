import { installGgufModel } from "../src/index";

const source_path = process.env.KIZUKI_GGUF_SOURCE;
const dest_dir = process.env.KIZUKI_GGUF_DEST;
if (source_path === undefined || dest_dir === undefined) {
  process.exit(2);
}

const installed = installGgufModel({ source_path, dest_dir });
process.stdout.write(
  JSON.stringify({
    sha256: installed.sha256,
    space: installed.space.id,
  }),
);
