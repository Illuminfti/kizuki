import { registerFts5RetrievalPort } from "./fts5";

export {
  FTS5_DOCUMENTS_SCHEMA,
  FTS5_RETRIEVAL_ENGINE_REL,
  FTS5_RETRIEVAL_SCHEMA,
  FTS5_RETRIEVAL_STORE_REL,
  UNLABELED_SENSITIVITY,
  initFts5RetrievalStore,
} from "./schema";
export {
  bareRetrievalId,
  isNamespacedRetrievalId,
  retrievalDocId,
  retrievalDocKind,
} from "./ids";
export {
  FTS5_RETRIEVAL_DESCRIPTOR,
  FTS5_RETRIEVAL_ID,
  Fts5RetrievalPort,
  createFts5RetrievalPort,
  registerFts5RetrievalPort,
} from "./fts5";

registerFts5RetrievalPort();
