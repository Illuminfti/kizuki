import {
  RSS_CEILING_BYTES,
  createGgufEmbeddingPort,
} from "../src/index";
import { temporaryEmbed } from "./helpers";

const temporary = temporaryEmbed({
  context_size: 64,
  batch_size: 8,
});
const port = createGgufEmbeddingPort(temporary.ctx);
try {
  const texts = Array.from(
    { length: 8 },
    (_, index) => `grace partnerships ${index}`,
  );
  for (let round = 0; round < 8; round += 1) {
    const vectors = await port.embedQuery(texts);
    if (vectors.length !== 8 || vectors[0]?.length !== 8) {
      process.exit(2);
    }
  }
  const health = await port.health();
  if (health.status !== "ready") process.exit(2);
  process.stdout.write(
    JSON.stringify({
      rss: process.memoryUsage().rss,
      rss_ceiling_bytes: health.detail["rss_ceiling_bytes"],
      context_size: health.detail["context_size"],
      batch_size: health.detail["batch_size"],
      contract_ceiling: RSS_CEILING_BYTES,
    }),
  );
} finally {
  await port.close();
  temporary.cleanup();
}
