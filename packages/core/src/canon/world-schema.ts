import type { Database } from "bun:sqlite";
import { tableColumns } from "../ledger/schema";

export const LEGACY_CANON_COLUMNS = ["receipt_id","claim_ids","provenance","sensitivity","page_path","kind","before_hash","after_hash","at","receipt_kind","page_action","archive_path","writer","producer","model_ref","authority","confidence","taint","candidates","superseded","retrieval_ops","reverts","reverted_by"] as const;
const REQUIRED_RETAINED = ["claim_ids","provenance","page_path","kind","after_hash","at","receipt_kind","page_action","writer","producer","authority","confidence","taint","candidates","superseded","retrieval_ops"];
const ERASED_NULL = LEGACY_CANON_COLUMNS.filter(key=>key!=="receipt_id" && key!=="sensitivity");
const TYPED_COLUMNS = ["record_codec","receipt_state","world_basis","own_id_origin","purge_receipt_id","erased_at","erasure_integrity","prior_receipt_id"];

/** Same receipt stream and FK identity; only typed erased records may omit retained payload. */
export function applyWorldCanonV33(db:Database):void {
 if(!db.inTransaction) throw new Error("typed canon migration requires a transaction");
 const columns=tableColumns(db,"canon_receipts");
 if(columns.includes("record_codec")) {assertWorldCanonSchema(db);return;}
 const dependent=db.query<{sql:string},[]>("SELECT sql FROM sqlite_master WHERE tbl_name='canon_receipts' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
 if(db.query<{foreign_keys:number},[]>("PRAGMA foreign_keys").get()?.foreign_keys!==0) throw new Error("typed canon table rebuild requires the owned migration boundary");
 db.exec(`CREATE TABLE canon_receipts_v5 (
 receipt_id TEXT PRIMARY KEY,
 claim_ids TEXT DEFAULT '[]', provenance TEXT, sensitivity TEXT NOT NULL, page_path TEXT,
 kind TEXT DEFAULT 'claim', before_hash TEXT, after_hash TEXT, at TEXT,
 receipt_kind TEXT DEFAULT 'write', page_action TEXT DEFAULT 'edit', archive_path TEXT,
 writer TEXT DEFAULT 'import', producer TEXT DEFAULT 'deterministic', model_ref TEXT,
 authority TEXT DEFAULT 'connector_evidence', confidence REAL DEFAULT 1.0, taint TEXT DEFAULT 'quoted',
 candidates TEXT DEFAULT '[]', superseded TEXT DEFAULT '[]', retrieval_ops TEXT DEFAULT '[]',reverts TEXT,reverted_by TEXT,
 record_codec TEXT NOT NULL DEFAULT 'v1' CHECK(record_codec IN ('v1','kizuki.canon-receipt/v2')),
 receipt_state TEXT NOT NULL DEFAULT 'retained' CHECK(receipt_state IN ('retained','erased')),
 prior_receipt_id TEXT CHECK(prior_receipt_id IS NULL OR (length(prior_receipt_id)=26 AND prior_receipt_id NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*' AND prior_receipt_id<>receipt_id)),
 world_basis TEXT,own_id_origin TEXT,purge_receipt_id TEXT,erased_at TEXT,erasure_integrity TEXT,
 CHECK((receipt_state='retained' AND ${REQUIRED_RETAINED.map(key=>`${key} IS NOT NULL`).join(" AND ")}
   AND purge_receipt_id IS NULL AND erased_at IS NULL AND erasure_integrity IS NULL
   AND ((record_codec='v1' AND world_basis IS NULL AND own_id_origin IS NULL AND prior_receipt_id IS NULL)
     OR (record_codec='kizuki.canon-receipt/v2' AND own_id_origin='core' AND world_basis IS NOT NULL AND json_valid(world_basis))))
 OR (record_codec='kizuki.canon-receipt/v2' AND receipt_state='erased' AND own_id_origin='core' AND sensitivity='private'
   AND ${ERASED_NULL.map(key=>`${key} IS NULL`).join(" AND ")} AND world_basis IS NULL
   AND purge_receipt_id IS NOT NULL AND erased_at IS NOT NULL AND erasure_integrity IS NOT NULL))
 ) STRICT`);
 const fields=LEGACY_CANON_COLUMNS.join(",");
 db.exec(`INSERT INTO canon_receipts_v5(${fields}) SELECT ${fields} FROM canon_receipts`);
 db.exec("DROP TABLE canon_receipts");
 db.exec("ALTER TABLE canon_receipts_v5 RENAME TO canon_receipts");
 for(const row of dependent) db.exec(row.sql);
 db.exec("CREATE UNIQUE INDEX canon_world_prior ON canon_receipts(prior_receipt_id) WHERE prior_receipt_id IS NOT NULL");
 if(db.query("PRAGMA foreign_key_check").get()!==null) throw new Error("typed canon migration changed receipt identity");
 assertWorldCanonSchema(db);
}

export function assertWorldCanonSchema(db:Database):void {
 const columns=tableColumns(db,"canon_receipts");
 if(![...LEGACY_CANON_COLUMNS,...TYPED_COLUMNS].every(key=>columns.includes(key))) throw new Error("typed canon storage migration required");
}
