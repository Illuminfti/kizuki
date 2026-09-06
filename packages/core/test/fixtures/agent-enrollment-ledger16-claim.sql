-- Historical writer c5a3aa54c366c1f0f8242448732a797663fb65c1; Bun 1.3.10.
-- Generated from an actual synthetic ledger16 database, never a downgraded current schema.
BEGIN TRANSACTION;
CREATE TABLE agent_audit (
  audit_id     TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL,
  tool         TEXT NOT NULL,
  query_shape  TEXT NOT NULL,
  served       TEXT NOT NULL,
  denied       TEXT NOT NULL,
  served_count INTEGER NOT NULL DEFAULT 0 CHECK (served_count >= 0),
  denied_count INTEGER NOT NULL DEFAULT 0 CHECK (denied_count >= 0),
  grant_epoch  INTEGER,
  at           TEXT NOT NULL
) STRICT;
CREATE TABLE agent_grants (
  agent_id   TEXT PRIMARY KEY REFERENCES agents(agent_id),
  ceiling    TEXT NOT NULL CHECK (ceiling IN ('public', 'personal', 'private')),
  types      TEXT,
  subjects   TEXT,
  since      TEXT,
  until      TEXT,
  tools      TEXT NOT NULL,
  rate_limit_per_minute INTEGER NOT NULL CHECK (
    rate_limit_per_minute >= 1 AND rate_limit_per_minute <= 1000
  ),
  relay_owner_corrections INTEGER NOT NULL DEFAULT 0 CHECK (
    relay_owner_corrections IN (0, 1)
  ),
  grant_epoch INTEGER NOT NULL DEFAULT 1 CHECK (grant_epoch >= 1),
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE agents (
  agent_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE CHECK (
    length(name) BETWEEN 2 AND 64
    AND name GLOB '[a-z0-9][a-z0-9-]*'
  ),
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  quarantined_at TEXT,
  quarantine_reason TEXT
) STRICT;
CREATE TABLE budget_ledger (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  used REAL NOT NULL,
  PRIMARY KEY (day, name)
) STRICT;
CREATE TABLE canon_holds (
        page_path TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        held_at TEXT NOT NULL,
        PRIMARY KEY (page_path, proposal_id)
      ) STRICT;
CREATE TABLE canon_machine_byte_intents (
      receipt_id TEXT PRIMARY KEY CHECK(length(receipt_id)=26 AND receipt_id NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'),
      before_hash TEXT CHECK(before_hash IS NULL OR (typeof(before_hash)='text' AND length(before_hash)=64 AND before_hash NOT GLOB '*[^0123456789abcdef]*')),
      after_hash TEXT NOT NULL CHECK((typeof(after_hash)='text' AND length(after_hash)=64 AND after_hash NOT GLOB '*[^0123456789abcdef]*'))
    ) STRICT;
CREATE TABLE canon_receipts (
  receipt_id TEXT PRIMARY KEY,
  claim_ids TEXT NOT NULL DEFAULT '[]',
  provenance TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  page_path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'claim',
  before_hash TEXT,
  after_hash TEXT NOT NULL,
  at TEXT NOT NULL,
  receipt_kind TEXT NOT NULL DEFAULT 'write',
  page_action TEXT NOT NULL DEFAULT 'edit',
  archive_path TEXT,
  writer TEXT NOT NULL DEFAULT 'import',
  producer TEXT NOT NULL DEFAULT 'deterministic',
  model_ref TEXT,
  authority TEXT NOT NULL DEFAULT 'connector_evidence',
  confidence REAL NOT NULL DEFAULT 1.0,
  taint TEXT NOT NULL DEFAULT 'quoted',
  candidates TEXT NOT NULL DEFAULT '[]',
  superseded TEXT NOT NULL DEFAULT '[]',
  retrieval_ops TEXT NOT NULL DEFAULT '[]',
  reverts TEXT,
  reverted_by TEXT
) STRICT;
CREATE TABLE canon_source_erasure_intents (
  page_path TEXT PRIMARY KEY, source_key TEXT NOT NULL, intent TEXT NOT NULL, digest TEXT NOT NULL
) STRICT;
CREATE TABLE canon_write_reservations (
  receipt_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  page_path TEXT NOT NULL,
  before_hash TEXT
) STRICT;
CREATE TABLE checkpoints (
        connector_id TEXT NOT NULL,
        source_key TEXT NOT NULL,
        cursor TEXT,
        mode TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT NOT NULL,
        last_result TEXT NOT NULL,
        PRIMARY KEY (connector_id, source_key)
      ) STRICT;
CREATE TABLE claim_bindings (
  claim_key TEXT NOT NULL,
  page_id TEXT NOT NULL,
  bound_at TEXT NOT NULL,
  PRIMARY KEY (claim_key, page_id)
) STRICT;
CREATE TABLE claim_supersessions (
  winner TEXT NOT NULL,
  loser TEXT NOT NULL,
  rule TEXT NOT NULL,
  prior_valid_to TEXT,
  receipt_id TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (winner, loser)
) STRICT;
CREATE TABLE claims (
  claim_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  target TEXT,
  body TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  provenance TEXT NOT NULL,
  subjects TEXT NOT NULL,
  producer TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  subject TEXT,
  predicate TEXT,
  object TEXT,
  polarity TEXT NOT NULL DEFAULT 'positive',
  claim_key TEXT,
  authority TEXT NOT NULL DEFAULT 'connector_evidence',
  sensitivity TEXT,
  taint TEXT NOT NULL DEFAULT 'quoted',
  model_ref TEXT,
  valid_from TEXT NOT NULL DEFAULT '',
  valid_to TEXT,
  asserted_at TEXT NOT NULL DEFAULT '',
  retracted_at TEXT,
  superseded_by TEXT,
  receipt_id TEXT,
  corroboration INTEGER NOT NULL DEFAULT 1,
  last_confirmed_at TEXT
) STRICT;
INSERT INTO "claims" VALUES('01M1TT1R0XENRK1Y6W4M11J1NQ','claim',NULL,'The synthetic project checkpoint is ready for review.','{"type":"fact","title":"Synthetic checkpoint","sensitivity":"private"}','["01ARZ3NDEKTSV4RRFFQ69G5FAW"]','["project:synthetic"]','deterministic',1.0,'live','2026-09-06T07:31:12.542Z','5e426e6bad398e3e09cde6749a0f8b54d921517b24c5d1ebdac965a079488823','project:synthetic',NULL,NULL,'positive',NULL,'connector_evidence','private','quoted',NULL,'2026-09-06T07:31:12.542Z',NULL,'2026-09-06T07:31:12.542Z',NULL,NULL,NULL,1,'2026-09-06T07:31:12.542Z');
CREATE TABLE connection_runs (
      run_id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      mode TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      previous_cursor TEXT,
      attempted_cursor TEXT,
      committed_cursor TEXT,
      stored INTEGER NOT NULL,
      duplicates INTEGER NOT NULL,
      errors TEXT NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (connector_id, source_key)
        REFERENCES connections(connector_id, source_key)
    ) STRICT;
CREATE TABLE connections (
        connector_id TEXT NOT NULL,
        source_key TEXT NOT NULL CHECK (
          length(source_key) = 26
          AND source_key NOT GLOB '*[^0123456789ABCDEFGHJKMNPQRSTVWXYZ]*'
        ),
        config TEXT NOT NULL CHECK (
          config = '{"schema":"kizuki.connection-config/v1","state_ref_index":null}'
          OR config = '{"schema":"kizuki.connection-config/v1","state_ref_index":0}'
        ),
        secret_refs TEXT NOT NULL CHECK (
          (config = '{"schema":"kizuki.connection-config/v1","state_ref_index":null}' AND secret_refs = '[]')
          OR (
            config = '{"schema":"kizuki.connection-config/v1","state_ref_index":0}'
            AND secret_refs = '["file:connections/' || source_key || '.state"]'
          )
        ),
        connected_at TEXT NOT NULL,
        disconnected_at TEXT, implementation_version TEXT NOT NULL DEFAULT '', consent_required INTEGER NOT NULL DEFAULT 0 CHECK(consent_required IN (0,1)),
        PRIMARY KEY (connector_id, source_key)
      ) STRICT;
INSERT INTO "connections" VALUES('fixture.ledger16-claim','01ARZ3NDEKTSV4RRFFQ69G5FAV','{"schema":"kizuki.connection-config/v1","state_ref_index":null}','[]','2026-09-06T07:31:12.508Z',NULL,'synthetic-fixture@1',1);
CREATE TABLE connector_sensitivity (
  connector_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  default_sensitivity TEXT NOT NULL CHECK (
    default_sensitivity IN ('public', 'personal', 'private')
  ),
  floor TEXT NOT NULL CHECK (floor IN ('public', 'personal', 'private')),
  set_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (connector_id, source_key)
) STRICT;
CREATE TABLE event_purges (
        receipt_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        purged_at TEXT NOT NULL
      );
CREATE TABLE events (
        event_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        source_record_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        text TEXT NOT NULL,
        subjects TEXT NOT NULL,
        sensitivity_hint TEXT,
        deleted INTEGER NOT NULL,
        attachments TEXT NOT NULL,
        metadata TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        accepted_at TEXT NOT NULL, content_hash_version INTEGER NOT NULL DEFAULT 0, text_hash TEXT NOT NULL DEFAULT '', origin TEXT NOT NULL DEFAULT 'external' CHECK(origin IN ('external','self')), origin_binding_version INTEGER NOT NULL DEFAULT 0, origin_binding_kind TEXT NOT NULL DEFAULT '', origin_binding TEXT NOT NULL DEFAULT '',
        UNIQUE(connector_id, source_record_id, content_hash)
      );
INSERT INTO "events" VALUES('01ARZ3NDEKTSV4RRFFQ69G5FAW','fixture.ledger16-claim','synthetic-checkpoint-1','message','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','The synthetic project checkpoint is ready for review.','[{"subject_id":"project:synthetic","role":"about","display_name":"Synthetic project"}]','private',0,'[]','{}','c9eea80d162d7481b72abba1280dccfa3418d3c38c8eab3e34189fab0342bb9e','2026-09-06T07:31:12.530Z',2,'5e426e6bad398e3e09cde6749a0f8b54d921517b24c5d1ebdac965a079488823','external',1,'capture','b4664a5f811d56674112a4901aa5078e4c1d55174e36e188238c16f087ce1837');
CREATE TABLE extract_batches (
  previous_cursor TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  drafts TEXT NOT NULL,
  model_ref TEXT,
  created_at TEXT NOT NULL,
  input_ids TEXT,
  integrity TEXT,
  outcome TEXT NOT NULL DEFAULT 'ok',
  batch_mode TEXT NOT NULL DEFAULT 'frontier',
  model_inputs TEXT,
  deferred_inputs TEXT
) STRICT;
CREATE TABLE extract_deferred_inputs (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
  source_key TEXT,
  checked_revision INTEGER NOT NULL,
  checked_binding_digest TEXT NOT NULL
) STRICT;
CREATE TABLE extract_invalidations (
  purge_receipt_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL CHECK (reason = 'invalid_derived_journal'),
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE extract_usage (
  run_id TEXT PRIMARY KEY,
  model_ref TEXT,
  metrics TEXT NOT NULL,
  holder_pid INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE identity_links (
  subject_a TEXT NOT NULL,
  subject_b TEXT NOT NULL,
  score REAL NOT NULL,
  evidence TEXT NOT NULL,
  status TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  receipt_id TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (subject_a, subject_b)
) STRICT;
CREATE TABLE leases (
  name TEXT PRIMARY KEY,
  holder_pid INTEGER NOT NULL,
  holder_boot_id TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  ttl_s INTEGER NOT NULL
) STRICT;
CREATE TABLE native_owner_evidence (
    event_id TEXT PRIMARY KEY,
    origin TEXT NOT NULL CHECK(origin='correction'),
    request_digest TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    filing_state TEXT NOT NULL CHECK(filing_state IN ('recorded','filed','failed'))
  , event_content_hash TEXT NOT NULL DEFAULT '') STRICT;
CREATE TABLE page_index (
  page_id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL,
  subject_key TEXT,
  last_receipt TEXT,
  last_hash TEXT NOT NULL
) STRICT;
CREATE TABLE proposals (
  proposal_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  target      TEXT,
  body        TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  provenance  TEXT NOT NULL,
  subjects    TEXT NOT NULL,
  producer    TEXT NOT NULL,
  confidence  REAL NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  body_hash   TEXT NOT NULL
) STRICT;
INSERT INTO "proposals" VALUES('01M1TT1R0XENRK1Y6W4M11J1NQ','claim',NULL,'The synthetic project checkpoint is ready for review.','{"type":"fact","title":"Synthetic checkpoint","sensitivity":"private"}','["01ARZ3NDEKTSV4RRFFQ69G5FAW"]','["project:synthetic"]','deterministic',1.0,'pending','2026-09-06T07:31:12.542Z','5e426e6bad398e3e09cde6749a0f8b54d921517b24c5d1ebdac965a079488823');
CREATE TABLE purge_ops (
  op_id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL,
  store TEXT NOT NULL,
  ids TEXT NOT NULL,
  state TEXT NOT NULL,
  proof TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
) STRICT;
CREATE TABLE retrieval_ops (
  op_id TEXT PRIMARY KEY,
  store TEXT NOT NULL,
  op TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  done_at TEXT
) STRICT;
CREATE TABLE run_receipts (
  run_id TEXT PRIMARY KEY,
  rail TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  status TEXT NOT NULL,
  stopped TEXT,
  report TEXT NOT NULL
) STRICT;
CREATE TABLE schedules (
  rail TEXT PRIMARY KEY,
  period_s INTEGER NOT NULL,
  jitter_s INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  next_run_at TEXT
) STRICT;
INSERT INTO "schedules" VALUES('sync',900,90,1,NULL,NULL);
INSERT INTO "schedules" VALUES('retrieval-sweep',300,0,1,NULL,NULL);
INSERT INTO "schedules" VALUES('purge-sweep',600,0,1,NULL,NULL);
INSERT INTO "schedules" VALUES('embed-backfill',60,0,1,NULL,NULL);
INSERT INTO "schedules" VALUES('brief',86400,0,1,NULL,NULL);
INSERT INTO "schedules" VALUES('doctor-sweep',3600,0,1,NULL,NULL);
INSERT INTO "schedules" VALUES('journal-prune',86400,0,1,NULL,NULL);
CREATE TABLE schema_version (
      version INTEGER NOT NULL
    );
INSERT INTO "schema_version" VALUES(16);
CREATE TABLE source_event_bindings (
      event_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL REFERENCES source_grants(source_key),
      grant_revision INTEGER NOT NULL,
      policy_digest TEXT NOT NULL
    ) STRICT;
INSERT INTO "source_event_bindings" VALUES('01ARZ3NDEKTSV4RRFFQ69G5FAW','01ARZ3NDEKTSV4RRFFQ69G5FAV',1,'5a83017c7593adf43f4963517444a2ff96ee4a2d39dbfe27a128570f6b0f757a');
CREATE TABLE source_grant_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL,
      receipt TEXT NOT NULL
    , receipt_digest TEXT) STRICT;
INSERT INTO "source_grant_receipts" VALUES(1,'fixture-ledger16-claim-consent','ff9174572e5303dae3afee4d2604c0665982f4ab764dda47ae159509cd8d83e4','{"operation_id":"fixture-ledger16-claim-consent","source_key":"01ARZ3NDEKTSV4RRFFQ69G5FAV","action":"grant","prior_revision":0,"revision":1,"status":"active","at":"2026-09-06T07:31:12.517Z","policy_digest":"5a83017c7593adf43f4963517444a2ff96ee4a2d39dbfe27a128570f6b0f757a"}','7f017e9ccb666824c9cb902fa2c0468fe0bed63ee1df3d8fc1fc100ef4e6da27');
CREATE TABLE source_grants (
      source_key TEXT PRIMARY KEY REFERENCES connections(source_key),
      connector_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      status TEXT NOT NULL CHECK(status IN ('active','denied','purged')),
      policy TEXT NOT NULL,
      policy_digest TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoke_operation TEXT,
      purge_receipt_id TEXT
    ) STRICT;
INSERT INTO "source_grants" VALUES('01ARZ3NDEKTSV4RRFFQ69G5FAV','fixture.ledger16-claim',1,'active','{"purposes":["capture","derive","export","recall","session"],"allowed_fields":["attachments","metadata","subjects","text"],"retention":"persistent_owned_until_revoked","egress":"local_only","sensitivity_floor":"private"}','5a83017c7593adf43f4963517444a2ff96ee4a2d39dbfe27a128570f6b0f757a','2026-09-06T07:31:12.517Z',NULL,NULL);
CREATE TABLE source_retrieval_stores (
      source_key TEXT NOT NULL REFERENCES source_grants(source_key), store_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','logical_absence','maintained','absent')),
      PRIMARY KEY(source_key,store_id)
    ) STRICT;
CREATE TABLE source_store_inventory (
      source_key TEXT PRIMARY KEY REFERENCES source_grants(source_key), checked INTEGER NOT NULL CHECK(checked IN (0,1)), payload_complete INTEGER NOT NULL DEFAULT 0 CHECK(payload_complete IN (0,1))
    , erasure_report TEXT) STRICT;
CREATE INDEX events_accepted_order_idx
        ON events(accepted_at, event_id);
CREATE INDEX events_connector_idx ON events(connector_id);
CREATE INDEX events_kind_idx ON events(kind);
CREATE UNIQUE INDEX claims_idempotency
  ON claims (kind, coalesce(target, ''), body_hash)
  WHERE kind <> 'purge_review';
CREATE INDEX claims_by_key ON claims(claim_key, status, valid_from);
CREATE INDEX claims_by_status ON claims(status, created_at);
CREATE INDEX claims_by_subject ON claims(subject, status);
CREATE INDEX retrieval_ops_pending
  ON retrieval_ops(state, created_at);
CREATE INDEX identity_links_by_b ON identity_links(subject_b);
CREATE UNIQUE INDEX proposals_idempotency
  ON proposals (kind, coalesce(target, ''), body_hash)
  WHERE kind <> 'purge_review';
CREATE INDEX proposals_by_status
  ON proposals (status, created_at);
CREATE INDEX canon_receipts_by_page ON canon_receipts(page_path, at, receipt_id);
CREATE INDEX canon_receipts_by_at ON canon_receipts(at, receipt_id);
CREATE UNIQUE INDEX page_index_by_path ON page_index(rel_path);
CREATE INDEX page_index_by_subject ON page_index(subject_key);
CREATE INDEX run_receipts_rail_finished
  ON run_receipts(rail, finished_at);
CREATE INDEX run_receipts_rail_finished_run
  ON run_receipts(rail, finished_at, run_id);
CREATE INDEX run_receipts_finished_run
  ON run_receipts(finished_at, run_id);
CREATE UNIQUE INDEX connections_source_key_uidx
      ON connections(source_key);
CREATE INDEX connection_runs_source_finished
      ON connection_runs(connector_id, source_key, finished_at);
CREATE INDEX agent_audit_by_agent
  ON agent_audit(agent_id, at, audit_id);
CREATE INDEX source_event_bindings_source ON source_event_bindings(source_key,event_id);
CREATE INDEX canon_loop_before_hash ON canon_receipts(before_hash) WHERE writer='loop';
CREATE INDEX canon_loop_after_hash ON canon_receipts(after_hash) WHERE writer='loop';
CREATE INDEX canon_machine_before_hash ON canon_machine_byte_intents(before_hash);
CREATE INDEX canon_machine_after_hash ON canon_machine_byte_intents(after_hash);
CREATE TRIGGER events_identity_insert BEFORE INSERT ON events WHEN typeof(NEW.content_hash_version)!='integer' OR NEW.content_hash_version NOT IN (1,2)
    OR NOT (typeof(NEW.text_hash)='text' AND length(NEW.text_hash)=64 AND NEW.text_hash NOT GLOB '*[^0123456789abcdef]*') OR NEW.origin NOT IN ('external','self')
    OR typeof(NEW.origin_binding_version)!='integer' OR NEW.origin_binding_version!=1
    OR NEW.origin_binding_kind NOT IN ('capture','native','legacy') OR NOT (typeof(NEW.origin_binding)='text' AND length(NEW.origin_binding)=64 AND NEW.origin_binding NOT GLOB '*[^0123456789abcdef]*')
      BEGIN SELECT RAISE(ABORT,'event identity fields are required'); END;
CREATE TRIGGER events_identity_update BEFORE UPDATE ON events WHEN
      NEW.origin IS NOT OLD.origin OR NEW.origin_binding_version IS NOT OLD.origin_binding_version
      OR NEW.origin_binding_kind IS NOT OLD.origin_binding_kind OR NEW.origin_binding IS NOT OLD.origin_binding
      OR NEW.accepted_at IS NOT OLD.accepted_at OR NEW.event_id IS NOT OLD.event_id
      OR NEW.content_hash IS NOT OLD.content_hash OR NEW.content_hash_version IS NOT OLD.content_hash_version
      OR NEW.text_hash IS NOT OLD.text_hash
      BEGIN SELECT RAISE(ABORT,'event origin binding is immutable'); END;
CREATE TRIGGER native_owner_hash_insert BEFORE INSERT ON native_owner_evidence WHEN NOT (typeof(NEW.event_content_hash)='text' AND length(NEW.event_content_hash)=64 AND NEW.event_content_hash NOT GLOB '*[^0123456789abcdef]*')
      BEGIN SELECT RAISE(ABORT,'native owner event hash is required'); END;
CREATE TRIGGER native_owner_hash_update BEFORE UPDATE ON native_owner_evidence WHEN
      NEW.event_id IS NOT OLD.event_id OR NEW.origin IS NOT OLD.origin OR NEW.request_digest IS NOT OLD.request_digest
      OR NEW.recorded_at IS NOT OLD.recorded_at OR NEW.event_content_hash IS NOT OLD.event_content_hash
      BEGIN SELECT RAISE(ABORT,'native owner proof is immutable'); END;
CREATE TRIGGER canon_loop_hash_insert BEFORE INSERT ON canon_receipts WHEN NEW.writer='loop' AND (
      NOT (typeof(NEW.after_hash)='text' AND length(NEW.after_hash)=64 AND NEW.after_hash NOT GLOB '*[^0123456789abcdef]*') OR (NEW.before_hash IS NOT NULL AND NOT (typeof(NEW.before_hash)='text' AND length(NEW.before_hash)=64 AND NEW.before_hash NOT GLOB '*[^0123456789abcdef]*')))
      BEGIN SELECT RAISE(ABORT,'machine byte registry is invalid'); END;
CREATE TRIGGER canon_loop_hash_update BEFORE UPDATE OF writer,before_hash,after_hash ON canon_receipts WHEN NEW.writer='loop' AND (
      NOT (typeof(NEW.after_hash)='text' AND length(NEW.after_hash)=64 AND NEW.after_hash NOT GLOB '*[^0123456789abcdef]*') OR (NEW.before_hash IS NOT NULL AND NOT (typeof(NEW.before_hash)='text' AND length(NEW.before_hash)=64 AND NEW.before_hash NOT GLOB '*[^0123456789abcdef]*')))
      BEGIN SELECT RAISE(ABORT,'machine byte registry is invalid'); END;
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('source_grant_receipts',1);
COMMIT;
