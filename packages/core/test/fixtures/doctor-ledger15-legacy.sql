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
INSERT INTO "connections" VALUES('fixture.doctor-legacy','01AAAAAAAAAAAAAAAAAAAAAAAA','{"schema":"kizuki.connection-config/v1","state_ref_index":null}','[]','2026-09-06T08:17:22.703Z',NULL,'synthetic@1',1);
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
        accepted_at TEXT NOT NULL,
        UNIQUE(connector_id, source_record_id, content_hash)
      );
INSERT INTO "events" VALUES('01BBBBBBBBBBBBBBBBBBBBBBBB','fixture.doctor-legacy','neutral-event','message','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','Neutral synthetic compatibility event.','[]','private',0,'[]','{}','7d8ff1db2a94aa4484cc7b51f7c8ced36a23a78e2beb130a3b592a0771131448','2026-09-06T08:17:22.705Z');
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
  ) STRICT;
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
INSERT INTO "schema_version" VALUES(15);
CREATE TABLE source_event_bindings (
      event_id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL REFERENCES source_grants(source_key),
      grant_revision INTEGER NOT NULL,
      policy_digest TEXT NOT NULL
    ) STRICT;
INSERT INTO "source_event_bindings" VALUES('01BBBBBBBBBBBBBBBBBBBBBBBB','01AAAAAAAAAAAAAAAAAAAAAAAA',1,'5a83017c7593adf43f4963517444a2ff96ee4a2d39dbfe27a128570f6b0f757a');
CREATE TABLE source_grant_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      operation_id TEXT NOT NULL UNIQUE,
      request_digest TEXT NOT NULL,
      receipt TEXT NOT NULL
    , receipt_digest TEXT) STRICT;
INSERT INTO "source_grant_receipts" VALUES(1,'fixture-doctor-legacy-consent','a26f78e2b94cc0051829b39591f18781c6fdd1a3d6e5dd0e313ab0108c279340','{"operation_id":"fixture-doctor-legacy-consent","source_key":"01AAAAAAAAAAAAAAAAAAAAAAAA","action":"grant","prior_revision":0,"revision":1,"status":"active","at":"2026-09-06T08:17:22.704Z","policy_digest":"5a83017c7593adf43f4963517444a2ff96ee4a2d39dbfe27a128570f6b0f757a"}','1446947b3d5a552a03a184349923c4fd3ee6f8f1c5af2e2e6b57514e501ebe46');
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
INSERT INTO "source_grants" VALUES('01AAAAAAAAAAAAAAAAAAAAAAAA','fixture.doctor-legacy',1,'active','{"purposes":["capture","derive","export","recall","session"],"allowed_fields":["attachments","metadata","subjects","text"],"retention":"persistent_owned_until_revoked","egress":"local_only","sensitivity_floor":"private"}','5a83017c7593adf43f4963517444a2ff96ee4a2d39dbfe27a128570f6b0f757a','2026-09-06T08:17:22.704Z',NULL,NULL);
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
DELETE FROM "sqlite_sequence";
INSERT INTO "sqlite_sequence" VALUES('source_grant_receipts',1);
COMMIT;
