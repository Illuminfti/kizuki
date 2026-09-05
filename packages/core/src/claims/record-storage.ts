import type { Database, SQLQueryBindings } from "bun:sqlite";
import { ClaimError } from "./errors";
import type { Claim, FrontmatterValue } from "../contracts/proposal";

export const CLAIM_ROW_PAGE = 32;
export const CLAIM_JSON_BYTES = 262_144;
export const CLAIM_TEXT_FIELDS = [
  ["claim_id",128,false], ["kind",32,false], ["target",4096,true], ["body",4_194_304,false],
  ["frontmatter",CLAIM_JSON_BYTES,false], ["provenance",CLAIM_JSON_BYTES,false],
  ["subjects",CLAIM_JSON_BYTES,false], ["producer",256,false], ["status",32,false],
  ["created_at",128,false], ["body_hash",128,false], ["subject",1024,true],
  ["predicate",256,true], ["object",65_536,true], ["polarity",16,false], ["claim_key",128,true],
  ["authority",32,false], ["sensitivity",16,true], ["taint",16,false], ["model_ref",4096,true],
  ["valid_from",128,true], ["valid_to",128,true], ["asserted_at",128,false],
  ["retracted_at",128,true], ["superseded_by",128,true], ["receipt_id",128,true],
  ["last_confirmed_at",128,true],
] as const;
export type ClaimRow = Omit<Claim,"schema"|"frontmatter"|"provenance"|"subjects"|"valid_from"|"sensitivity"> & {
  frontmatter:string; provenance:string; subjects:string; valid_from:string|null;
  sensitivity:string|null; claim_schema?:string; temporal_basis?:string|null; purge_ref?:string|null;
};
export function invalidStoredClaim(): never {
  throw new ClaimError("schema_invalid","stored claim is invalid");
}
/** Metadata is checked in SQLite before any payload cell is returned to Bun. */
export function boundedClaimRows(db:Database, where:string, params:SQLQueryBindings[], limit=CLAIM_ROW_PAGE): ClaimRow[] {
  const metadata=CLAIM_TEXT_FIELDS.map(([field])=>
    `typeof(${field}) AS ${field}_type,octet_length(${field}) AS ${field}_bytes`).join(",");
  using metadataStatement=db.prepare<Record<string,string|number|null>,SQLQueryBindings[]>(
    `SELECT CAST(rowid AS TEXT) AS row_key,${metadata} FROM claims ${where} LIMIT ?`);
  const rows=metadataStatement.all(...params,limit);
  for(const row of rows) for(const [field,max,nullable] of CLAIM_TEXT_FIELDS) {
    if(row[`${field}_type`]==="null" && nullable) continue;
    if(row[`${field}_type`]!=="text" || typeof row[`${field}_bytes`]!=="number" || Number(row[`${field}_bytes`])>max) invalidStoredClaim();
  }
  const decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true});
  return rows.map(meta=>{
    // Cast text to BLOB to refuse malformed historical UTF-8 rather than replace it.
    using statement=db.prepare<Record<string,unknown>,[string]>(`SELECT *,${CLAIM_TEXT_FIELDS.map(([field])=>`CAST(${field} AS BLOB) AS ${field}`).join(",")} FROM claims WHERE rowid=CAST(? AS INTEGER)`);
    const row=statement.get(String(meta.row_key));
    if(row===null) return invalidStoredClaim();
    try { for(const [field] of CLAIM_TEXT_FIELDS) if(row[field]!==null) row[field]=decoder.decode(row[field] as Uint8Array); }
    catch { return invalidStoredClaim(); }
    return row as unknown as ClaimRow;
  });
}
export function storedStringArray(raw:string):string[] {
  let value:unknown;
  try { value=JSON.parse(raw); } catch { return invalidStoredClaim(); }
  if(!Array.isArray(value) || value.length>4096 || !value.every(item=>typeof item==="string" && new TextEncoder().encode(item).length<=4096)) return invalidStoredClaim();
  return value;
}
export function storedFrontmatter(raw:string):Record<string,FrontmatterValue> {
  let value:unknown;
  try { value=JSON.parse(raw); } catch { return invalidStoredClaim(); }
  const scalar=(item:unknown)=>typeof item==="string" || typeof item==="boolean" || (typeof item==="number" && Number.isFinite(item));
  if(value===null || typeof value!=="object" || Array.isArray(value) || Object.keys(value).length>1024 ||
    !Object.values(value).every(item=>scalar(item) || (Array.isArray(item) && item.length<=4096 && item.every(scalar)))) return invalidStoredClaim();
  return value as Record<string,FrontmatterValue>;
}
export function decodeClaimV1(row:ClaimRow):Claim {
  if(row.claim_schema!==undefined && row.claim_schema!=="kizuki.claim/v1") {
    throw new ClaimError("schema_unsupported","claim requires a versioned reader");
  }
  if(typeof row.valid_from!=="string") return invalidStoredClaim();
  const {claim_schema:_schema,temporal_basis:_basis,purge_ref:_purge,...fields}=row;
  return {...fields,schema:"kizuki.claim/v1",valid_from:row.valid_from,
    sensitivity:(row.sensitivity??"private") as Claim["sensitivity"],
    frontmatter:storedFrontmatter(row.frontmatter),provenance:storedStringArray(row.provenance),subjects:storedStringArray(row.subjects)};
}
