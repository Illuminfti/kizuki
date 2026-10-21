import { createLocalHttpEmbeddingPort } from "../src/index";
import { configFor, temporaryEmbed } from "./helpers";

const temporary = temporaryEmbed(configFor(Number(process.argv[2])));
const port = createLocalHttpEmbeddingPort(temporary.ctx);
try {
  await port.embedQuery(["synthetic proxy proof"]);
} finally {
  await port.close();
  temporary.cleanup();
}
