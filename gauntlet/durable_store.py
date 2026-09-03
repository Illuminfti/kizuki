"""Bounded, fail-closed v1-to-v2 migration and deterministic replay.

Construction and every read method are inert.  The sole mutation seam is
``DurableProtocolStore.migrate_v1_to_v2``.  No scheduler, identity, attempt,
runner, or result API is exposed from this module.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import io
import json
import math
import os
import sqlite3
import stat
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Mapping, Optional
from urllib.parse import quote


__all__ = (
    "DurableProtocolStore",
    "DurableStoreError",
    "LegacyReceipt",
    "MigratedCampaign",
    "MigratedTask",
    "MigrationPreflight",
    "MigrationResult",
    "MigrationView",
    "ReplayProjection",
)

_GENESIS = "0" * 64
_V1_EVENT_TYPES = frozenset({
    "controller.epoch", "campaign.created", "campaign.state", "task.created",
    "task.state", "lease.acquired", "lease.heartbeat", "lease.released",
    "receipt.recorded", "incident", "reconciliation", "adapter.receipt",
})
_MAX_LEDGER_BYTES = 64 * 1024 * 1024
_MAX_LEDGER_LINE_BYTES = 1024 * 1024
_MAX_LEDGER_EVENTS = 65_536
_MAX_JSON_DEPTH = 32
_MAX_METADATA_JSON_BYTES = 1024 * 1024
_MAX_DB_FAMILY_FILE_BYTES = 1024 * 1024 * 1024
_MAX_DB_FAMILY_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
_SNAPSHOT_FREE_SPACE_RESERVE = 1024 * 1024
_MAX_PROJECTION_ROWS = _MAX_LEDGER_EVENTS
_MAX_PROJECTION_FIELD_BYTES = _MAX_LEDGER_LINE_BYTES
_MAX_PROJECTION_MATERIALIZED_BYTES = 128 * 1024 * 1024
_MAX_SCHEMA_OBJECTS = 32
_MAX_SCHEMA_SQL_BYTES = 1024 * 1024
_CRASH_HOOK: Optional[Callable[[str], None]] = None


class DurableStoreError(RuntimeError):
    """The store cannot be recognized, migrated, or replayed safely."""


@dataclass(frozen=True)
class MigrationPreflight:
    schema_version: int
    state: str
    ledger_prefix_sha256: str
    ledger_prefix_bytes: int
    ledger_event_count: int
    ledger_tip_hash: str
    v1_inventory_sha256: str
    disposition_sha256: str


@dataclass(frozen=True)
class MigrationResult:
    schema_version: int
    state: str
    schema_event_hash: str
    schema_event_sequence: int
    ledger_prefix_sha256: str
    ledger_prefix_bytes: int
    v1_inventory_sha256: str
    disposition_sha256: str
    projection_sha256: str
    replay_projection_sha256: str


@dataclass(frozen=True)
class LegacyReceipt:
    id: str
    task_id: str
    attempt: int
    phase: str
    schema_version: int
    authoritative: int


@dataclass(frozen=True)
class ReplayProjection:
    schema_version: int
    state: str
    projection_sha256: str
    legacy_receipts: tuple[LegacyReceipt, ...]


@dataclass(frozen=True)
class MigratedCampaign:
    id: str
    state: str
    recovery_required: bool


@dataclass(frozen=True)
class MigratedTask:
    id: str
    state: str
    version: int
    recovery_from: Optional[str]


@dataclass(frozen=True)
class MigrationView:
    campaigns: tuple[MigratedCampaign, ...]
    tasks: tuple[MigratedTask, ...]
    legacy_lease_count: int
    merge_recovery_required: bool
    merge_recovery_task_count: int


@dataclass(frozen=True)
class _FileIdentity:
    device: int
    inode: int
    size: int


@dataclass(frozen=True)
class _LedgerSnapshot:
    data: bytes
    identity: Optional[_FileIdentity]


# PRAGMA table_info rows: cid, name, declared type, not-null, default, pk index.
_V1_LAYOUT: Mapping[str, tuple[tuple[object, ...], ...]] = {
    "controller": (
        (0, "key", "TEXT", 0, None, 1), (1, "value", "INTEGER", 1, None, 0),
    ),
    "campaigns": (
        (0, "id", "TEXT", 0, None, 1), (1, "state", "TEXT", 1, None, 0),
        (2, "epoch", "INTEGER", 1, None, 0), (3, "version", "INTEGER", 1, None, 0),
        (4, "created_at", "REAL", 1, None, 0), (5, "updated_at", "REAL", 1, None, 0),
    ),
    "tasks": (
        (0, "id", "TEXT", 0, None, 1), (1, "campaign_id", "TEXT", 1, None, 0),
        (2, "scope", "TEXT", 1, None, 0), (3, "state", "TEXT", 1, None, 0),
        (4, "attempts", "INTEGER", 1, "0", 0), (5, "version", "INTEGER", 1, None, 0),
        (6, "updated_at", "REAL", 1, None, 0),
    ),
    "leases": (
        (0, "scope", "TEXT", 0, None, 1), (1, "task_id", "TEXT", 1, None, 0),
        (2, "holder", "TEXT", 1, None, 0), (3, "token", "INTEGER", 1, None, 0),
        (4, "expires_at", "REAL", 1, None, 0), (5, "heartbeat_at", "REAL", 1, None, 0),
        (6, "epoch", "INTEGER", 1, None, 0),
    ),
    "fences": (
        (0, "scope", "TEXT", 0, None, 1), (1, "token", "INTEGER", 1, None, 0),
    ),
    "receipts": (
        (0, "id", "TEXT", 0, None, 1), (1, "task_id", "TEXT", 1, None, 0),
        (2, "attempt", "INTEGER", 1, None, 0), (3, "phase", "TEXT", 1, None, 0),
        (4, "sha", "TEXT", 1, None, 0), (5, "tests", "TEXT", 1, None, 0),
        (6, "scope", "TEXT", 1, None, 0), (7, "holder", "TEXT", 1, None, 0),
        (8, "token", "INTEGER", 1, None, 0), (9, "epoch", "INTEGER", 1, None, 0),
        (10, "artifact", "TEXT", 0, None, 0), (11, "created_at", "REAL", 1, None, 0),
    ),
    "incidents": (
        (0, "id", "TEXT", 0, None, 1), (1, "kind", "TEXT", 1, None, 0),
        (2, "detail", "TEXT", 1, None, 0), (3, "created_at", "REAL", 1, None, 0),
    ),
    "reconciliation": (
        (0, "id", "TEXT", 0, None, 1), (1, "campaign_id", "TEXT", 1, None, 0),
        (2, "evidence", "TEXT", 1, None, 0), (3, "created_at", "REAL", 1, None, 0),
    ),
    "adapter_receipts": (
        (0, "name", "TEXT", 0, None, 1), (1, "version", "TEXT", 1, None, 0),
        (2, "auth_status", "TEXT", 1, None, 0), (3, "route_status", "TEXT", 1, None, 0),
        (4, "evidence_sha256", "TEXT", 1, None, 0),
        (5, "executable_sha256", "TEXT", 1, None, 0), (6, "method", "TEXT", 1, None, 0),
        (7, "reason_code", "TEXT", 1, None, 0), (8, "checked_at", "REAL", 1, None, 0),
        (9, "expires_at", "REAL", 1, None, 0),
    ),
    "events": (
        (0, "seq", "INTEGER", 0, None, 1), (1, "hash", "TEXT", 1, None, 0),
        (2, "type", "TEXT", 1, None, 0), (3, "payload", "TEXT", 1, None, 0),
        (4, "created_at", "REAL", 1, None, 0),
    ),
}

_PRIMARY_KEYS = {
    "controller": "key", "campaigns": "id", "tasks": "id", "leases": "scope",
    "fences": "scope", "receipts": "id", "incidents": "id",
    "reconciliation": "id", "adapter_receipts": "name",
}

_CREATE_V1_SQL = """
CREATE TABLE controller(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
CREATE TABLE campaigns(id TEXT PRIMARY KEY,state TEXT NOT NULL,epoch INTEGER NOT NULL,version INTEGER NOT NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL);
CREATE TABLE tasks(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,updated_at REAL NOT NULL);
CREATE TABLE leases(scope TEXT PRIMARY KEY,task_id TEXT NOT NULL,holder TEXT NOT NULL,token INTEGER NOT NULL,expires_at REAL NOT NULL,heartbeat_at REAL NOT NULL,epoch INTEGER NOT NULL);
CREATE TABLE fences(scope TEXT PRIMARY KEY,token INTEGER NOT NULL);
CREATE TABLE receipts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,attempt INTEGER NOT NULL,phase TEXT NOT NULL,sha TEXT NOT NULL,tests TEXT NOT NULL,scope TEXT NOT NULL,holder TEXT NOT NULL,token INTEGER NOT NULL,epoch INTEGER NOT NULL,artifact TEXT,created_at REAL NOT NULL);
CREATE TABLE incidents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,detail TEXT NOT NULL,created_at REAL NOT NULL);
CREATE TABLE reconciliation(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,evidence TEXT NOT NULL,created_at REAL NOT NULL);
CREATE TABLE adapter_receipts(name TEXT PRIMARY KEY,version TEXT NOT NULL,auth_status TEXT NOT NULL,route_status TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,executable_sha256 TEXT NOT NULL,method TEXT NOT NULL,reason_code TEXT NOT NULL,checked_at REAL NOT NULL,expires_at REAL NOT NULL);
CREATE TABLE events(seq INTEGER PRIMARY KEY,hash TEXT UNIQUE NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at REAL NOT NULL);
"""

_V2_DDL = (
    "ALTER TABLE campaigns ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(recovery_required IN (0,1))",
    "ALTER TABLE tasks ADD COLUMN subject_sha TEXT CHECK(subject_sha IS NULL OR (length(subject_sha)=40 AND subject_sha NOT GLOB '*[^0-9a-f]*'))",
    "ALTER TABLE tasks ADD COLUMN merge_sha TEXT CHECK(merge_sha IS NULL OR (length(merge_sha)=40 AND merge_sha NOT GLOB '*[^0-9a-f]*'))",
    "ALTER TABLE tasks ADD COLUMN active_role TEXT CHECK(active_role IS NULL OR active_role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier'))",
    "ALTER TABLE tasks ADD COLUMN recovery_from TEXT",
    "ALTER TABLE receipts ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK(schema_version=1)",
    "ALTER TABLE receipts ADD COLUMN authoritative INTEGER NOT NULL DEFAULT 0 CHECK(authoritative=0)",
    """CREATE TABLE schema_metadata(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        schema_version INTEGER NOT NULL CHECK(schema_version=2),
        state TEXT NOT NULL CHECK(state IN ('PREPARED','COMMITTED')),
        ledger_prefix_sha256 TEXT NOT NULL CHECK(length(ledger_prefix_sha256)=64 AND ledger_prefix_sha256 NOT GLOB '*[^0-9a-f]*'),
        ledger_prefix_bytes INTEGER NOT NULL CHECK(ledger_prefix_bytes BETWEEN 0 AND 67108864),
        ledger_event_count INTEGER NOT NULL CHECK(ledger_event_count BETWEEN 0 AND 65536),
        ledger_tip_hash TEXT NOT NULL CHECK(length(ledger_tip_hash)=64 AND ledger_tip_hash NOT GLOB '*[^0-9a-f]*'),
        v1_inventory_sha256 TEXT NOT NULL CHECK(length(v1_inventory_sha256)=64 AND v1_inventory_sha256 NOT GLOB '*[^0-9a-f]*'),
        disposition_sha256 TEXT NOT NULL CHECK(length(disposition_sha256)=64 AND disposition_sha256 NOT GLOB '*[^0-9a-f]*'),
        disposition_json TEXT NOT NULL CHECK(length(CAST(disposition_json AS BLOB)) BETWEEN 2 AND 1048576),
        schema_event_bytes BLOB NOT NULL CHECK(length(CAST(schema_event_bytes AS BLOB)) BETWEEN 2 AND 1048576),
        schema_event_hash TEXT NOT NULL CHECK(length(schema_event_hash)=64 AND schema_event_hash NOT GLOB '*[^0-9a-f]*'),
        schema_event_created_at REAL NOT NULL
    )""",
    """CREATE TABLE phase_leases(
        resource TEXT PRIMARY KEY CHECK(length(resource) BETWEEN 1 AND 240),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt INTEGER NOT NULL CHECK(attempt>0),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        run_id TEXT NOT NULL CHECK(length(run_id)=64 AND run_id NOT GLOB '*[^0-9a-f]*'),
        principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 80 AND principal_id NOT GLOB '*[^A-Za-z0-9._-]*'),
        token INTEGER NOT NULL CHECK(token>0),
        expires_at REAL NOT NULL, heartbeat_at REAL NOT NULL,
        epoch INTEGER NOT NULL CHECK(epoch>0),
        CHECK(expires_at>heartbeat_at)
    )""",
    """CREATE TABLE phase_receipts(
        id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt INTEGER NOT NULL CHECK(attempt>0),
        phase TEXT NOT NULL CHECK(length(phase) BETWEEN 1 AND 80),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 80 AND principal_id NOT GLOB '*[^A-Za-z0-9._-]*'),
        verdict TEXT NOT NULL CHECK(verdict IN ('PASS','FAIL')),
        subject_sha TEXT NOT NULL CHECK(length(subject_sha)=40 AND subject_sha NOT GLOB '*[^0-9a-f]*'),
        base_sha TEXT NOT NULL CHECK(length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
        result_sha TEXT NOT NULL CHECK(length(result_sha)=40 AND result_sha NOT GLOB '*[^0-9a-f]*'),
        evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
        github_evidence_id TEXT CHECK(github_evidence_id IS NULL OR length(github_evidence_id) BETWEEN 1 AND 200),
        lease_resource TEXT NOT NULL CHECK(length(lease_resource) BETWEEN 1 AND 240),
        lease_token INTEGER NOT NULL CHECK(lease_token>0),
        merge_fence_token INTEGER CHECK(merge_fence_token IS NULL OR merge_fence_token>0),
        epoch INTEGER NOT NULL CHECK(epoch>0),
        authoritative INTEGER NOT NULL CHECK(authoritative IN (0,1)),
        created_at REAL NOT NULL,
        UNIQUE(task_id,attempt,phase,role)
    )""",
    """CREATE TABLE merge_claims(
        resource TEXT PRIMARY KEY CHECK(resource='merge/global'),
        token INTEGER NOT NULL CHECK(token>0),
        task_id TEXT REFERENCES tasks(id),
        attempt INTEGER CHECK(attempt IS NULL OR attempt>0),
        subject_sha TEXT CHECK(subject_sha IS NULL OR (length(subject_sha)=40 AND subject_sha NOT GLOB '*[^0-9a-f]*')),
        base_sha TEXT CHECK(base_sha IS NULL OR (length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*')),
        pr_number INTEGER CHECK(pr_number IS NULL OR pr_number>0),
        merge_operation_id TEXT CHECK(merge_operation_id IS NULL OR (length(merge_operation_id)=64 AND merge_operation_id NOT GLOB '*[^0-9a-f]*')),
        grant_generation INTEGER CHECK(grant_generation IS NULL OR grant_generation>0),
        status TEXT NOT NULL CHECK(status IN ('HELD','RECOVERY_REQUIRED')),
        epoch INTEGER NOT NULL CHECK(epoch>0),
        linked_remediation_task_id TEXT REFERENCES tasks(id),
        updated_at REAL NOT NULL,
        CHECK(
            (status='HELD' AND task_id IS NOT NULL AND attempt IS NOT NULL
             AND subject_sha IS NOT NULL AND base_sha IS NOT NULL
             AND pr_number IS NOT NULL AND merge_operation_id IS NOT NULL
             AND grant_generation IS NOT NULL)
            OR
            (status='RECOVERY_REQUIRED' AND (
                (task_id IS NULL AND attempt IS NULL AND subject_sha IS NULL
                 AND base_sha IS NULL AND pr_number IS NULL
                 AND merge_operation_id IS NULL AND grant_generation IS NULL
                 AND linked_remediation_task_id IS NULL)
                OR
                (task_id IS NOT NULL AND attempt IS NOT NULL
                 AND subject_sha IS NOT NULL AND base_sha IS NOT NULL
                 AND pr_number IS NOT NULL AND merge_operation_id IS NOT NULL
                 AND grant_generation IS NOT NULL)
            ))
        ),
        CHECK(linked_remediation_task_id IS NULL OR linked_remediation_task_id<>task_id)
    )""",
    """CREATE TABLE merge_operations(
        merge_operation_id TEXT PRIMARY KEY CHECK(length(merge_operation_id)=64 AND merge_operation_id NOT GLOB '*[^0-9a-f]*'),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt INTEGER NOT NULL CHECK(attempt>0),
        grant_generation INTEGER NOT NULL CHECK(grant_generation>0),
        parent_merge_operation_id TEXT REFERENCES merge_operations(merge_operation_id) CHECK(parent_merge_operation_id IS NULL OR parent_merge_operation_id<>merge_operation_id),
        request_state TEXT NOT NULL CHECK(request_state IN ('PREPARED','SENT','CONFIRMED','UNCERTAIN','ABORTED')),
        grant_sha256 TEXT NOT NULL CHECK(length(grant_sha256)=64 AND grant_sha256 NOT GLOB '*[^0-9a-f]*'),
        request_sha256 TEXT CHECK(request_sha256 IS NULL OR (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*')),
        response_sha256 TEXT CHECK(response_sha256 IS NULL OR (length(response_sha256)=64 AND response_sha256 NOT GLOB '*[^0-9a-f]*')),
        epoch INTEGER NOT NULL CHECK(epoch>0), updated_at REAL NOT NULL,
        CHECK((request_state='PREPARED' AND request_sha256 IS NULL AND response_sha256 IS NULL)
              OR (request_state IN ('SENT','UNCERTAIN') AND request_sha256 IS NOT NULL)
              OR (request_state='CONFIRMED' AND request_sha256 IS NOT NULL AND response_sha256 IS NOT NULL)
              OR request_state='ABORTED'),
        UNIQUE(task_id,attempt,grant_generation)
    )""",
    """CREATE TABLE merge_recovery_tasks(
        resource TEXT NOT NULL CHECK(resource='merge/global'),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        prior_state TEXT NOT NULL CHECK(prior_state IN ('INTEGRATING','MERGED','POST_MERGE_VERIFYING')),
        PRIMARY KEY(resource,task_id),
        FOREIGN KEY(resource) REFERENCES merge_claims(resource)
    )""",
)


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError) as exc:
        raise DurableStoreError("value has no canonical JSON encoding") from exc


def _reject_duplicate_pairs(pairs: list[tuple[str, object]]) -> dict:
    value: dict[str, object] = {}
    for key, item in pairs:
        if key in value:
            raise DurableStoreError("JSON object contains a duplicate key")
        value[key] = item
    return value


def _reject_nonfinite(_value: str) -> object:
    raise DurableStoreError("JSON contains a non-finite number")


def _finite_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise DurableStoreError("JSON contains a non-finite number")
    return parsed


def _check_json_depth(value: object, label: str) -> None:
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        if depth > _MAX_JSON_DEPTH:
            raise DurableStoreError(f"{label} exceeds JSON depth bound")
        if isinstance(item, dict):
            pending.extend((nested, depth + 1) for nested in item.values())
        elif isinstance(item, list):
            pending.extend((nested, depth + 1) for nested in item)


def _strict_json(raw: bytes, *, label: str, maximum: int) -> object:
    if len(raw) > maximum:
        raise DurableStoreError(f"{label} exceeds byte bound")
    try:
        value = json.loads(
            raw.decode("ascii"), object_pairs_hook=_reject_duplicate_pairs,
            parse_constant=_reject_nonfinite, parse_float=_finite_float,
        )
    except DurableStoreError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise DurableStoreError(f"{label} is malformed") from exc
    _check_json_depth(value, label)
    if _canonical(value) != raw:
        raise DurableStoreError(f"{label} is not canonical JSON")
    return value


def _require_hex(value: object, length: int, label: str) -> str:
    if (not isinstance(value, str) or len(value) != length
            or any(character not in "0123456789abcdef" for character in value)):
        raise DurableStoreError(f"invalid {label}")
    return value


def _bounded_integer(value: object, label: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
        raise DurableStoreError(f"invalid {label}")
    return value


def _raw_event(previous: str, event_type: str, payload: object, created_at: object) -> bytes:
    return _canonical({
        "prev": previous, "type": event_type, "payload": payload,
        "created_at": created_at,
    })


def _parse_ledger(raw: bytes, *, allow_schema_v2: bool) -> list[dict]:
    if len(raw) > _MAX_LEDGER_BYTES:
        raise DurableStoreError("ledger exceeds total byte bound")
    if raw and not raw.endswith(b"\n"):
        raise DurableStoreError("ledger has an incomplete final event")
    events: list[dict] = []
    previous = _GENESIS
    schema_seen = False
    stream = io.BytesIO(raw)
    while True:
        line = stream.readline(_MAX_LEDGER_LINE_BYTES + 2)
        if not line:
            break
        if len(line) > _MAX_LEDGER_LINE_BYTES + 1 or not line.endswith(b"\n"):
            raise DurableStoreError("ledger event exceeds line byte bound")
        if len(events) >= _MAX_LEDGER_EVENTS:
            raise DurableStoreError("ledger exceeds event count bound")
        encoded = line[:-1]
        if not encoded:
            raise DurableStoreError("ledger contains a blank event")
        event = _strict_json(
            encoded, label="ledger event", maximum=_MAX_LEDGER_LINE_BYTES,
        )
        if not isinstance(event, dict) or set(event) != {
            "prev", "hash", "type", "payload", "created_at",
        }:
            raise DurableStoreError("ledger event envelope is not recognized")
        event_type = event["type"]
        created_at = event["created_at"]
        if (not isinstance(event_type, str) or not isinstance(event["prev"], str)
                or not isinstance(event["hash"], str)
                or not isinstance(event["payload"], dict)
                or isinstance(created_at, bool)
                or not isinstance(created_at, (int, float))
                or not math.isfinite(created_at)):
            raise DurableStoreError("ledger event fields are not recognized")
        _require_hex(event["prev"], 64, "ledger previous digest")
        _require_hex(event["hash"], 64, "ledger event digest")
        if event_type == "schema.v2":
            if not allow_schema_v2 or schema_seen:
                raise DurableStoreError("schema.v2 is duplicated or outside the v1 boundary")
            schema_seen = True
        elif schema_seen:
            raise DurableStoreError("ledger contains an event after schema.v2 boundary")
        elif event_type not in _V1_EVENT_TYPES:
            raise DurableStoreError("unknown ledger event type")
        if event["prev"] != previous:
            raise DurableStoreError("ledger hash chain is discontinuous")
        expected = _sha256(_raw_event(
            event["prev"], event_type, event["payload"], created_at,
        ))
        if event["hash"] != expected:
            raise DurableStoreError("ledger event hash is invalid")
        projected = dict(event)
        projected["seq"] = len(events) + 1
        events.append(projected)
        previous = event["hash"]
    return events


def _table_layout(db: sqlite3.Connection, table: str) -> tuple[tuple[object, ...], ...]:
    escaped = table.replace('"', '""')
    return tuple(tuple(row) for row in db.execute(f'PRAGMA table_info("{escaped}")'))


def _index_shape(db: sqlite3.Connection, table: str) -> tuple[tuple[object, ...], ...]:
    escaped = table.replace('"', '""')
    shapes = []
    for index, row in enumerate(db.execute(f'PRAGMA index_list("{escaped}")')):
        if index >= _MAX_SCHEMA_OBJECTS:
            raise DurableStoreError(f"projection has too many indexes: {table}")
        name, unique, origin, partial = row[1], row[2], row[3], row[4]
        index_name = str(name).replace('"', '""')
        columns = tuple(item[2] for item in db.execute(
            f'PRAGMA index_info("{index_name}")'
        ))
        shapes.append((unique, origin, partial, columns))
    return tuple(sorted(shapes, key=repr))


def _expected_v1_index_shape(table: str) -> tuple[tuple[object, ...], ...]:
    if table == "events":
        return ((1, "u", 0, ("hash",)),)
    return ((1, "pk", 0, (_PRIMARY_KEYS[table],)),)


def _bounded_table_names(db: sqlite3.Connection) -> set[str]:
    count = db.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%'"
    ).fetchone()[0]
    if (isinstance(count, bool) or not isinstance(count, int)
            or not 0 <= count <= _MAX_SCHEMA_OBJECTS):
        raise DurableStoreError("projection exceeds schema object bound")
    if db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' "
        "AND length(CAST(name AS BLOB))>256 LIMIT 1"
    ).fetchone() is not None:
        raise DurableStoreError("projection schema name exceeds byte bound")
    names = {
        row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%'"
        )
    }
    if len(names) != count or any(not isinstance(name, str) for name in names):
        raise DurableStoreError("projection table inventory is ambiguous")
    return names


def _schema_shape(db: sqlite3.Connection) -> dict:
    count = db.execute(
        "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
        "AND type IN ('table','view','trigger','index')"
    ).fetchone()[0]
    if (isinstance(count, bool) or not isinstance(count, int)
            or not 0 <= count <= _MAX_SCHEMA_OBJECTS):
        raise DurableStoreError("projection exceeds schema object bound")
    oversized = db.execute(
        "SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
        "AND type IN ('table','view','trigger','index') "
        "AND (length(CAST(name AS BLOB))>256 "
        "OR length(CAST(coalesce(sql,'') AS BLOB))>?) LIMIT 1",
        (_MAX_SCHEMA_SQL_BYTES,),
    ).fetchone()
    if oversized is not None:
        raise DurableStoreError("projection schema definition exceeds byte bound")
    objects = db.execute(
        "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
        "AND type IN ('table','view','trigger') ORDER BY type,name"
    ).fetchall()
    shape: dict[str, object] = {
        "objects": [(row[0], row[1]) for row in objects], "tables": {},
    }
    tables = shape["tables"]
    assert isinstance(tables, dict)
    for object_type, name in shape["objects"]:
        if object_type != "table":
            continue
        escaped = str(name).replace('"', '""')
        sql_row = db.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,),
        ).fetchone()
        normalized = " ".join(str(sql_row[0]).split()) if sql_row and sql_row[0] else None
        tables[name] = {
            "sql": normalized,
            "columns": [list(row) for row in _table_layout(db, name)],
            "indexes": [list(row[:-1]) + [list(row[-1])] for row in _index_shape(db, name)],
            "foreign_keys": [list(row) for row in db.execute(
                f'PRAGMA foreign_key_list("{escaped}")'
            )],
        }
    return shape


def _create_v1_schema(db: sqlite3.Connection) -> None:
    db.executescript(_CREATE_V1_SQL)


def _apply_v2_ddl(db: sqlite3.Connection) -> None:
    for statement in _V2_DDL:
        db.execute(statement)


def _expected_v1_shape() -> dict:
    db = sqlite3.connect(":memory:")
    try:
        _create_v1_schema(db)
        return _schema_shape(db)
    finally:
        db.close()


def _expected_v2_shape() -> dict:
    db = sqlite3.connect(":memory:")
    try:
        _create_v1_schema(db)
        db.execute("BEGIN IMMEDIATE")
        _apply_v2_ddl(db)
        db.execute("COMMIT")
        return _schema_shape(db)
    finally:
        db.close()


def _assert_exact_v1_schema(db: sqlite3.Connection) -> None:
    count = db.execute(
        "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
        "AND type IN ('table','view','trigger','index')"
    ).fetchone()[0]
    if (isinstance(count, bool) or not isinstance(count, int)
            or not 0 <= count <= _MAX_SCHEMA_OBJECTS):
        raise DurableStoreError("projection exceeds schema object bound")
    objects = db.execute(
        "SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' "
        "AND type IN ('table','view','trigger') ORDER BY type,name"
    ).fetchall()
    if [(row[0], row[1]) for row in objects] != [
        ("table", name) for name in sorted(_V1_LAYOUT)
    ]:
        raise DurableStoreError("projection is not the exact known v1 table set")
    for name, expected in _V1_LAYOUT.items():
        if _table_layout(db, name) != expected:
            raise DurableStoreError(f"projection has an unknown v1 layout: {name}")
        if _index_shape(db, name) != _expected_v1_index_shape(name):
            raise DurableStoreError(f"projection has an unknown v1 index layout: {name}")
        escaped = name.replace('"', '""')
        if tuple(db.execute(f'PRAGMA foreign_key_list("{escaped}")')):
            raise DurableStoreError(f"projection has unknown v1 foreign keys: {name}")
    if _schema_shape(db) != _expected_v1_shape():
        raise DurableStoreError("projection is not the exact known v1 definition")


def _assert_exact_v2_schema(db: sqlite3.Connection) -> None:
    if _schema_shape(db) != _expected_v2_shape():
        raise DurableStoreError("projection is not the exact known v2 layout")


def _ordered_rows(
    db: sqlite3.Connection, table: str, columns: tuple[str, ...],
) -> list[list[object]]:
    _projection_table_size(db, table, columns)
    quoted_columns = ",".join(
        '"' + column.replace('"', '""') + '"' for column in columns
    )
    quoted_table = '"' + table.replace('"', '""') + '"'
    order = ",".join(str(index + 1) for index in range(len(columns)))
    return [list(row) for row in db.execute(
        f"SELECT {quoted_columns} FROM {quoted_table} ORDER BY {order}"
    )]


def _projection_table_size(
    db: sqlite3.Connection, table: str, columns: tuple[str, ...],
) -> int:
    quoted_table = '"' + table.replace('"', '""') + '"'
    quoted_columns = [
        '"' + column.replace('"', '""') + '"' for column in columns
    ]
    try:
        count = db.execute(f"SELECT count(*) FROM {quoted_table}").fetchone()[0]
        if (isinstance(count, bool) or not isinstance(count, int)
                or count < 0 or count > _MAX_PROJECTION_ROWS):
            raise DurableStoreError(
                f"projection table exceeds row bound: {table}"
            )
        if not quoted_columns or count == 0:
            return 0
        lengths = ",".join(
            f"max(coalesce(length(CAST({column} AS BLOB)),0))"
            for column in quoted_columns
        )
        maxima = db.execute(
            f"SELECT {lengths} FROM {quoted_table}"
        ).fetchone()
        if maxima is None or any(
            isinstance(value, bool) or not isinstance(value, int) or value < 0
            or value > _MAX_PROJECTION_FIELD_BYTES for value in maxima
        ):
            raise DurableStoreError(
                f"projection table contains an oversized field: {table}"
            )
        row_length = "+".join(
            f"coalesce(length(CAST({column} AS BLOB)),0)"
            for column in quoted_columns
        )
        total = db.execute(
            f"SELECT coalesce(sum({row_length}),0) FROM {quoted_table}"
        ).fetchone()[0]
    except DurableStoreError:
        raise
    except (sqlite3.Error, TypeError, ValueError, OverflowError) as exc:
        raise DurableStoreError(
            f"projection table size cannot be verified: {table}"
        ) from exc
    if (isinstance(total, bool) or not isinstance(total, int) or total < 0
            or total > _MAX_PROJECTION_MATERIALIZED_BYTES):
        raise DurableStoreError(
            f"projection table exceeds materialized byte bound: {table}"
        )
    return total


def _admit_projection_tables(
    db: sqlite3.Connection, tables: Mapping[str, tuple[tuple[object, ...], ...]],
) -> None:
    total = 0
    for name, layout in tables.items():
        columns = tuple(str(row[1]) for row in layout)
        total += _projection_table_size(db, name, columns)
        if total > _MAX_PROJECTION_MATERIALIZED_BYTES:
            raise DurableStoreError(
                "projection exceeds aggregate materialized byte bound"
            )


def _v1_inventory(
    db: sqlite3.Connection, ledger: bytes, events: list[dict],
) -> tuple[str, dict]:
    _admit_projection_tables(db, _V1_LAYOUT)
    tables = {}
    for name, layout in sorted(_V1_LAYOUT.items()):
        columns = tuple(str(row[1]) for row in layout)
        rows = _ordered_rows(db, name, columns)
        tables[name] = {
            "row_count": len(rows), "rows_sha256": _sha256(_canonical(rows)),
        }
    inventory = {
        "schema": "kizuki-gauntlet-v1-exact",
        "ledger": {
            "bytes": len(ledger), "sha256": _sha256(ledger),
            "event_count": len(events),
            "tip_hash": events[-1]["hash"] if events else _GENESIS,
        },
        "tables": tables,
    }
    return _sha256(_canonical(inventory)), inventory


def _disposition_plan(db: sqlite3.Connection) -> dict:
    campaign_terminal = {"ABORTED", "RELEASED"}
    campaign_states = {
        "RECONCILING", "READY", "ACTIVE", "QUIESCING", "VERIFYING",
        "RC_READY", "VALIDATING", "PAUSED", "FAILED", *campaign_terminal,
    }
    task_states = {
        "DISCOVERED", "READY", "LEASED", "RUNNING", "SUBMITTED", "VERIFYING",
        "REVIEWING", "INTEGRATING", "MERGED", "POST_MERGE_VERIFYING",
        "CHANGES_REQUESTED", "RECOVERING", "FAILED", "SUPERSEDED", "DONE",
    }
    campaigns = []
    for campaign_id, state in db.execute("SELECT id,state FROM campaigns ORDER BY id"):
        if state not in campaign_states:
            raise DurableStoreError("v1 campaign has an unknown state")
        campaigns.append({
            "id": campaign_id, "prior_state": state,
            "recovery_required": state not in campaign_terminal,
        })
    tasks = []
    recovery_tasks = []
    for task_id, state in db.execute("SELECT id,state FROM tasks ORDER BY id"):
        if state not in task_states:
            raise DurableStoreError("v1 task has an unknown state")
        target, delta, action = state, 0, "RETAIN"
        if state in {"LEASED", "RUNNING", "RECOVERING"}:
            target, delta, action = "READY", 1, "NEW_BUILDER_ATTEMPT_REQUIRED"
        elif state in {"SUBMITTED", "VERIFYING", "REVIEWING"}:
            target, delta, action = (
                "READY", 2, "CHANGES_REQUESTED_THEN_NEW_ATTEMPT",
            )
        elif state == "CHANGES_REQUESTED":
            target, delta, action = "READY", 1, "NEW_BUILDER_ATTEMPT_REQUIRED"
        elif state in {"INTEGRATING", "MERGED", "POST_MERGE_VERIFYING"}:
            action = "GLOBAL_RECOVERY_HOLD"
            recovery_tasks.append({"id": task_id, "prior_state": state})
        tasks.append({
            "id": task_id, "prior_state": state, "target_state": target,
            "version_delta": delta, "action": action,
        })
    lease_rows = _ordered_rows(
        db, "leases",
        ("scope", "task_id", "holder", "token", "expires_at", "heartbeat_at", "epoch"),
    )
    return {
        "version": 1,
        "lease_count": len(lease_rows),
        "lease_inventory_sha256": _sha256(_canonical(lease_rows)),
        "lease_action": "RETIRE_ALL",
        "campaigns": campaigns,
        "tasks": tasks,
        "merge_recovery": {
            "resource": "merge/global", "required": bool(recovery_tasks),
            "status": "RECOVERY_REQUIRED" if recovery_tasks else "FREE",
            "task_count": len(recovery_tasks), "tasks": recovery_tasks,
        },
    }


def _insert_projected_event(
    db: sqlite3.Connection, event: Mapping[str, object],
) -> None:
    try:
        db.execute(
            "INSERT INTO events VALUES(?,?,?,?,?)",
            (event["seq"], event["hash"], event["type"],
             json.dumps(event["payload"], sort_keys=True, allow_nan=False),
             event["created_at"]),
        )
    except (sqlite3.Error, TypeError, ValueError) as exc:
        raise DurableStoreError("event projection insert failed") from exc


def _apply_v1_event(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    event_type = event["type"]
    if event_type not in _V1_EVENT_TYPES:
        raise DurableStoreError("unknown v1 event during replay")
    payload = event["payload"]
    if not isinstance(payload, dict):
        raise DurableStoreError("v1 event payload must be an object")
    created_at = event["created_at"]
    now = payload.get("updated_at", created_at)
    try:
        if event_type == "controller.epoch":
            db.execute(
                "INSERT INTO controller VALUES('epoch',?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (payload["epoch"],),
            )
            db.execute(
                "UPDATE campaigns SET epoch=?,updated_at=?",
                (payload["epoch"], now),
            )
        elif event_type == "campaign.created":
            db.execute(
                "INSERT OR IGNORE INTO campaigns VALUES(?,?,?,?,?,?)",
                (payload["id"], "RECONCILING", payload["epoch"], 1, now, now),
            )
        elif event_type == "campaign.state":
            db.execute(
                "UPDATE campaigns SET state=?,version=version+1,updated_at=? WHERE id=?",
                (payload["state"], now, payload["id"]),
            )
        elif event_type == "task.created":
            db.execute(
                "INSERT OR IGNORE INTO tasks VALUES(?,?,?,?,?,?,?)",
                (payload["id"], payload["campaign_id"], payload["scope"],
                 "DISCOVERED", 0, 1, now),
            )
        elif event_type == "task.state":
            db.execute(
                "UPDATE tasks SET state=?,version=version+1,updated_at=? WHERE id=?",
                (payload["state"], now, payload["id"]),
            )
            if payload.get("retire_leases", False):
                db.execute("DELETE FROM leases WHERE task_id=?", (payload["id"],))
        elif event_type == "lease.acquired":
            db.execute(
                "INSERT INTO fences VALUES(?,?) ON CONFLICT(scope) "
                "DO UPDATE SET token=MAX(token,excluded.token)",
                (payload["scope"], payload["token"]),
            )
            db.execute(
                "INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?,?,?)",
                (payload["scope"], payload["task_id"], payload["holder"],
                 payload["token"], payload["expires_at"],
                 payload["heartbeat_at"], payload["epoch"]),
            )
            if payload.get("starts_attempt", False):
                db.execute(
                    "UPDATE tasks SET attempts=attempts+1,state='LEASED',"
                    "version=version+1,updated_at=? WHERE id=?",
                    (now, payload["task_id"]),
                )
        elif event_type == "lease.heartbeat":
            db.execute(
                "UPDATE leases SET expires_at=?,heartbeat_at=? WHERE scope=?",
                (payload["expires_at"], payload["heartbeat_at"], payload["scope"]),
            )
        elif event_type == "lease.released":
            db.execute("DELETE FROM leases WHERE scope=?", (payload["scope"],))
        elif event_type == "receipt.recorded":
            if "attempt" not in payload or "phase" not in payload:
                raise DurableStoreError("legacy receipt is not attempt-bound")
            db.execute(
                "INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (payload["id"], payload["task_id"], payload["attempt"],
                 payload["phase"], payload["sha"],
                 json.dumps(payload["tests"], sort_keys=True, allow_nan=False),
                 payload["scope"], payload["holder"], payload["token"],
                 payload["epoch"], payload.get("artifact"), now),
            )
        elif event_type == "incident":
            db.execute(
                "INSERT OR IGNORE INTO incidents VALUES(?,?,?,?)",
                (payload["id"], payload["kind"], payload["detail"], now),
            )
        elif event_type == "reconciliation":
            db.execute(
                "INSERT OR REPLACE INTO reconciliation VALUES(?,?,?,?)",
                (payload["id"], payload["campaign_id"],
                 json.dumps(payload["evidence"], sort_keys=True, allow_nan=False),
                 now),
            )
        elif event_type == "adapter.receipt":
            db.execute(
                "INSERT OR REPLACE INTO adapter_receipts VALUES(?,?,?,?,?,?,?,?,?,?)",
                (payload["name"], payload["version"], payload["auth_status"],
                 payload["route_status"], payload["evidence_sha256"],
                 payload["executable_sha256"], payload["method"],
                 payload["reason_code"], payload["checked_at"],
                 payload["expires_at"]),
            )
    except DurableStoreError:
        raise
    except (KeyError, sqlite3.Error, TypeError, ValueError) as exc:
        raise DurableStoreError(f"cannot replay v1 event: {event_type}") from exc


def _replay_v1(events: list[dict]) -> sqlite3.Connection:
    db = sqlite3.connect(":memory:", isolation_level=None)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    _create_v1_schema(db)
    db.execute("BEGIN IMMEDIATE")
    try:
        for event in events:
            _insert_projected_event(db, event)
            _apply_v1_event(db, event)
        db.execute("COMMIT")
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        db.close()
        raise
    return db


def _assert_v1_projection_matches_ledger(
    db: sqlite3.Connection, events: list[dict],
) -> None:
    _admit_projection_tables(db, _V1_LAYOUT)
    expected = _replay_v1(events)
    try:
        for name, layout in sorted(_V1_LAYOUT.items()):
            columns = tuple(str(row[1]) for row in layout)
            if _ordered_rows(db, name, columns) != _ordered_rows(
                expected, name, columns,
            ):
                raise DurableStoreError(
                    "v1 projection does not match deterministic ledger replay"
                )
    finally:
        expected.close()


def _schema_payload(report: MigrationPreflight, plan: dict) -> dict:
    return {
        "schema_version": 2,
        "v1_inventory_sha256": report.v1_inventory_sha256,
        "ledger_prefix": {
            "sha256": report.ledger_prefix_sha256,
            "bytes": report.ledger_prefix_bytes,
            "event_count": report.ledger_event_count,
            "tip_hash": report.ledger_tip_hash,
        },
        "disposition_sha256": report.disposition_sha256,
        "disposition_plan": plan,
    }


def _make_schema_event(
    report: MigrationPreflight, plan: dict, *, created_at: Optional[float] = None,
) -> tuple[dict, bytes]:
    if report.ledger_event_count >= _MAX_LEDGER_EVENTS:
        raise DurableStoreError("schema.v2 exceeds ledger event bound")
    observed_at = time.time() if created_at is None else created_at
    if (isinstance(observed_at, bool)
            or not isinstance(observed_at, (int, float))
            or not math.isfinite(observed_at)):
        raise DurableStoreError("schema.v2 event time is invalid")
    payload = _schema_payload(report, plan)
    raw = _raw_event(report.ledger_tip_hash, "schema.v2", payload, observed_at)
    event = {
        "prev": report.ledger_tip_hash,
        "hash": _sha256(raw),
        "type": "schema.v2",
        "payload": payload,
        "created_at": observed_at,
        "seq": report.ledger_event_count + 1,
    }
    encoded = _canonical({key: value for key, value in event.items() if key != "seq"}) + b"\n"
    if (len(encoded) - 1 > _MAX_LEDGER_LINE_BYTES
            or report.ledger_prefix_bytes + len(encoded) > _MAX_LEDGER_BYTES):
        raise DurableStoreError("schema.v2 event exceeds ledger bounds")
    return event, encoded


def _metadata_plan(metadata: sqlite3.Row) -> dict:
    raw = metadata["disposition_json"]
    if not isinstance(raw, str):
        raise DurableStoreError("migration disposition metadata is malformed")
    try:
        encoded = raw.encode("ascii")
    except UnicodeEncodeError as exc:
        raise DurableStoreError("migration disposition metadata is malformed") from exc
    value = _strict_json(
        encoded, label="migration disposition metadata",
        maximum=_MAX_METADATA_JSON_BYTES,
    )
    if not isinstance(value, dict):
        raise DurableStoreError("migration disposition metadata is not an object")
    if _sha256(encoded) != metadata["disposition_sha256"]:
        raise DurableStoreError("migration disposition digest mismatch")
    return value


def _validate_schema_payload(
    payload: object, metadata: Optional[sqlite3.Row] = None,
) -> dict:
    if not isinstance(payload, dict) or set(payload) != {
        "schema_version", "v1_inventory_sha256", "ledger_prefix",
        "disposition_sha256", "disposition_plan",
    }:
        raise DurableStoreError("schema.v2 payload is not recognized")
    prefix = payload["ledger_prefix"]
    if payload["schema_version"] != 2 or not isinstance(prefix, dict) or set(prefix) != {
        "sha256", "bytes", "event_count", "tip_hash",
    }:
        raise DurableStoreError("schema.v2 prefix binding is invalid")
    _require_hex(payload["v1_inventory_sha256"], 64, "v1 inventory digest")
    _require_hex(payload["disposition_sha256"], 64, "disposition digest")
    _require_hex(prefix["sha256"], 64, "ledger prefix digest")
    _require_hex(prefix["tip_hash"], 64, "ledger prefix tip")
    _bounded_integer(prefix["bytes"], "ledger prefix byte count", _MAX_LEDGER_BYTES)
    prefix_event_count = _bounded_integer(
        prefix["event_count"], "ledger prefix event count", _MAX_LEDGER_EVENTS,
    )
    if prefix_event_count >= _MAX_LEDGER_EVENTS:
        raise DurableStoreError("schema.v2 prefix leaves no ledger event capacity")
    if _sha256(_canonical(payload["disposition_plan"])) != payload["disposition_sha256"]:
        raise DurableStoreError("schema.v2 disposition digest mismatch")
    if metadata is not None:
        expected = {
            "schema_version": metadata["schema_version"],
            "v1_inventory_sha256": metadata["v1_inventory_sha256"],
            "ledger_prefix": {
                "sha256": metadata["ledger_prefix_sha256"],
                "bytes": metadata["ledger_prefix_bytes"],
                "event_count": metadata["ledger_event_count"],
                "tip_hash": metadata["ledger_tip_hash"],
            },
            "disposition_sha256": metadata["disposition_sha256"],
            "disposition_plan": _metadata_plan(metadata),
        }
        if payload != expected:
            raise DurableStoreError("schema.v2 event does not match PREPARED metadata")
    return payload


def _prepared_schema_event(metadata: sqlite3.Row) -> tuple[dict, bytes]:
    stored = metadata["schema_event_bytes"]
    if isinstance(stored, memoryview):
        stored = stored.tobytes()
    if (not isinstance(stored, bytes) or len(stored) > _MAX_LEDGER_LINE_BYTES + 1
            or not stored.endswith(b"\n") or b"\n" in stored[:-1]):
        raise DurableStoreError("PREPARED schema.v2 bytes are malformed")
    decoded = _strict_json(
        stored[:-1], label="PREPARED schema.v2 event",
        maximum=_MAX_LEDGER_LINE_BYTES,
    )
    if not isinstance(decoded, dict) or set(decoded) != {
        "prev", "hash", "type", "payload", "created_at",
    }:
        raise DurableStoreError("PREPARED schema.v2 envelope is not recognized")
    if (decoded["type"] != "schema.v2"
            or decoded["prev"] != metadata["ledger_tip_hash"]
            or decoded["hash"] != metadata["schema_event_hash"]
            or decoded["created_at"] != metadata["schema_event_created_at"]):
        raise DurableStoreError("PREPARED schema.v2 binding is inconsistent")
    created_at = decoded["created_at"]
    if (isinstance(created_at, bool)
            or not isinstance(created_at, (int, float))
            or not math.isfinite(created_at)):
        raise DurableStoreError("PREPARED schema.v2 event time is invalid")
    expected_hash = _sha256(_raw_event(
        decoded["prev"], "schema.v2", decoded["payload"], created_at,
    ))
    if decoded["hash"] != expected_hash:
        raise DurableStoreError("PREPARED schema.v2 hash is invalid")
    _validate_schema_payload(decoded["payload"], metadata)
    projected = dict(decoded)
    projected["seq"] = metadata["ledger_event_count"] + 1
    return projected, stored


def _read_metadata(db: sqlite3.Connection) -> sqlite3.Row:
    count = db.execute("SELECT count(*) FROM schema_metadata").fetchone()[0]
    if count != 1:
        raise DurableStoreError("v2 schema metadata is missing or ambiguous")
    sizes = db.execute(
        "SELECT length(CAST(disposition_json AS BLOB)),"
        "length(CAST(schema_event_bytes AS BLOB)),"
        "length(CAST(singleton AS BLOB)),length(CAST(schema_version AS BLOB)),"
        "length(CAST(state AS BLOB)),"
        "length(CAST(ledger_prefix_sha256 AS BLOB)),"
        "length(CAST(ledger_prefix_bytes AS BLOB)),"
        "length(CAST(ledger_event_count AS BLOB)),"
        "length(CAST(ledger_tip_hash AS BLOB)),"
        "length(CAST(v1_inventory_sha256 AS BLOB)),"
        "length(CAST(disposition_sha256 AS BLOB)),"
        "length(CAST(schema_event_hash AS BLOB)),"
        "length(CAST(schema_event_created_at AS BLOB)) "
        "FROM schema_metadata WHERE singleton=1"
    ).fetchone()
    if (sizes is None or any(
        isinstance(value, bool) or not isinstance(value, int) or value < 0
        for value in sizes
    ) or sizes[0] > _MAX_METADATA_JSON_BYTES
            or sizes[1] > _MAX_LEDGER_LINE_BYTES + 1
            or any(value > 64 for value in sizes[2:])
            or sizes[4] > len("COMMITTED")
            or any(sizes[index] != 64 for index in (5, 8, 9, 10, 11))):
        raise DurableStoreError("v2 schema metadata exceeds field bounds")
    row = db.execute(
        "SELECT * FROM schema_metadata WHERE singleton=1"
    ).fetchone()
    assert row is not None
    if (row["singleton"] != 1 or row["schema_version"] != 2
            or row["state"] not in {"PREPARED", "COMMITTED"}):
        raise DurableStoreError("v2 schema metadata state is invalid")
    _require_hex(row["ledger_prefix_sha256"], 64, "ledger prefix digest")
    _require_hex(row["ledger_tip_hash"], 64, "ledger prefix tip")
    _require_hex(row["v1_inventory_sha256"], 64, "v1 inventory digest")
    _require_hex(row["disposition_sha256"], 64, "disposition digest")
    _require_hex(row["schema_event_hash"], 64, "schema event digest")
    _bounded_integer(row["ledger_prefix_bytes"], "ledger prefix bytes", _MAX_LEDGER_BYTES)
    _bounded_integer(row["ledger_event_count"], "ledger event count", _MAX_LEDGER_EVENTS)
    _metadata_plan(row)
    _prepared_schema_event(row)
    return row


def _insert_prepared_metadata(
    db: sqlite3.Connection, report: MigrationPreflight, plan: dict,
    schema_event: Mapping[str, object], schema_event_bytes: bytes,
) -> None:
    disposition = _canonical(plan)
    if len(disposition) > _MAX_METADATA_JSON_BYTES:
        raise DurableStoreError("migration disposition metadata exceeds byte bound")
    db.execute(
        "INSERT INTO schema_metadata VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (1, 2, "PREPARED", report.ledger_prefix_sha256,
         report.ledger_prefix_bytes, report.ledger_event_count,
         report.ledger_tip_hash, report.v1_inventory_sha256,
         report.disposition_sha256, disposition.decode("ascii"),
         sqlite3.Binary(schema_event_bytes), schema_event["hash"],
         schema_event["created_at"]),
    )


def _validate_disposition_shape(plan: dict) -> None:
    if set(plan) != {
        "version", "lease_count", "lease_inventory_sha256", "lease_action",
        "campaigns", "tasks", "merge_recovery",
    } or plan["version"] != 1 or plan["lease_action"] != "RETIRE_ALL":
        raise DurableStoreError("migration disposition plan is malformed")
    if (isinstance(plan["lease_count"], bool)
            or not isinstance(plan["lease_count"], int)
            or plan["lease_count"] < 0):
        raise DurableStoreError("migration lease disposition is malformed")
    _require_hex(plan["lease_inventory_sha256"], 64, "lease inventory digest")
    if not isinstance(plan["campaigns"], list) or not isinstance(plan["tasks"], list):
        raise DurableStoreError("migration disposition inventory is malformed")
    hold = plan["merge_recovery"]
    if not isinstance(hold, dict) or set(hold) != {
        "resource", "required", "status", "task_count", "tasks",
    }:
        raise DurableStoreError("merge recovery disposition is malformed")
    hold_tasks = hold["tasks"]
    if (not isinstance(hold_tasks, list) or hold["resource"] != "merge/global"
            or not isinstance(hold["required"], bool)
            or isinstance(hold["task_count"], bool)
            or not isinstance(hold["task_count"], int)
            or hold["task_count"] != len(hold_tasks)
            or hold["required"] != bool(hold_tasks)
            or hold["status"] != ("RECOVERY_REQUIRED" if hold_tasks else "FREE")):
        raise DurableStoreError("merge recovery disposition is inconsistent")


def _apply_disposition_plan(
    db: sqlite3.Connection, plan: dict, *, event_created_at: float,
) -> None:
    _validate_disposition_shape(plan)
    leases = _ordered_rows(
        db, "leases",
        ("scope", "task_id", "holder", "token", "expires_at", "heartbeat_at", "epoch"),
    )
    if (len(leases) != plan["lease_count"]
            or _sha256(_canonical(leases)) != plan["lease_inventory_sha256"]):
        raise DurableStoreError("legacy leases changed after migration preparation")
    db.execute("DELETE FROM leases")
    for item in plan["campaigns"]:
        if (not isinstance(item, dict) or set(item) != {
            "id", "prior_state", "recovery_required",
        } or not isinstance(item["recovery_required"], bool)):
            raise DurableStoreError("campaign disposition is malformed")
        cursor = db.execute(
            "UPDATE campaigns SET recovery_required=? WHERE id=? AND state=?",
            (int(item["recovery_required"]), item["id"], item["prior_state"]),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("campaign changed after migration preparation")
    for item in plan["tasks"]:
        if not isinstance(item, dict) or set(item) != {
            "id", "prior_state", "target_state", "version_delta", "action",
        }:
            raise DurableStoreError("task disposition is malformed")
        if (isinstance(item["version_delta"], bool)
                or not isinstance(item["version_delta"], int)
                or item["version_delta"] not in {0, 1, 2}):
            raise DurableStoreError("task disposition version delta is malformed")
        recovery_from = item["prior_state"] if item["action"] != "RETAIN" else None
        cursor = db.execute(
            "UPDATE tasks SET state=?,version=version+?,active_role=NULL,recovery_from=? "
            "WHERE id=? AND state=?",
            (item["target_state"], item["version_delta"], recovery_from,
             item["id"], item["prior_state"]),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("task changed after migration preparation")
    hold = plan["merge_recovery"]
    hold_tasks = hold["tasks"]
    expected_tasks = [
        {"id": item["id"], "prior_state": item["prior_state"]}
        for item in plan["tasks"] if item["action"] == "GLOBAL_RECOVERY_HOLD"
    ]
    if hold_tasks != expected_tasks:
        raise DurableStoreError("merge recovery task membership is inconsistent")
    if hold["required"]:
        fence = db.execute(
            "SELECT token FROM fences WHERE scope='merge/global'"
        ).fetchone()
        current_token = fence[0] if fence is not None else 0
        if (isinstance(current_token, bool) or not isinstance(current_token, int)
                or not 0 <= current_token < 9223372036854775807):
            raise DurableStoreError("legacy merge fence token is invalid")
        token = current_token + 1
        db.execute(
            "INSERT INTO fences(scope,token) VALUES('merge/global',?) "
            "ON CONFLICT(scope) DO UPDATE SET token=excluded.token",
            (token,),
        )
        epoch = db.execute(
            "SELECT value FROM controller WHERE key='epoch'"
        ).fetchone()
        if (epoch is None or isinstance(epoch[0], bool)
                or not isinstance(epoch[0], int) or epoch[0] <= 0):
            raise DurableStoreError("legacy controller epoch is invalid")
        db.execute(
            "INSERT INTO merge_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("merge/global", token, None, None, None, None, None, None, None,
             "RECOVERY_REQUIRED", epoch[0],
             None, event_created_at),
        )
        for item in hold_tasks:
            if not isinstance(item, dict) or set(item) != {"id", "prior_state"}:
                raise DurableStoreError("merge recovery task is malformed")
            db.execute(
                "INSERT INTO merge_recovery_tasks VALUES(?,?,?)",
                ("merge/global", item["id"], item["prior_state"]),
            )


def _assert_prepared_projection(db: sqlite3.Connection) -> None:
    default_checks = (
        ("campaigns", "recovery_required<>0"),
        (
            "tasks",
            "subject_sha IS NOT NULL OR merge_sha IS NOT NULL "
            "OR active_role IS NOT NULL OR recovery_from IS NOT NULL",
        ),
        ("receipts", "schema_version<>1 OR authoritative<>0"),
    )
    for table, predicate in default_checks:
        if db.execute(
            f"SELECT 1 FROM {table} WHERE {predicate} LIMIT 1"
        ).fetchone() is not None:
            raise DurableStoreError(
                "PREPARED projection contains applied v2 disposition state"
            )
    for table in (
        "phase_leases", "phase_receipts", "merge_claims", "merge_operations",
        "merge_recovery_tasks",
    ):
        if db.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() is not None:
            raise DurableStoreError(
                "PREPARED projection contains materialized v2 runtime state"
            )


def _projection_rows(
    db: sqlite3.Connection, table_names: tuple[str, ...],
) -> dict[str, list[list[object]]]:
    rows = {}
    for name in table_names:
        columns = tuple(str(row[1]) for row in _table_layout(db, name))
        rows[name] = [
            [
                {"$bytes_hex": bytes(value).hex()}
                if isinstance(value, (bytes, bytearray, memoryview)) else value
                for value in row
            ]
            for row in _ordered_rows(db, name, columns)
        ]
    return rows


def _v2_projection_digest(db: sqlite3.Connection) -> str:
    _assert_exact_v2_schema(db)
    table_names = tuple(row[0] for row in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ))
    layouts = {name: _table_layout(db, name) for name in table_names}
    _admit_projection_tables(db, layouts)
    return _sha256(_canonical({
        "schema": _schema_shape(db),
        "rows": _projection_rows(db, table_names),
    }))


def _legacy_receipts(db: sqlite3.Connection) -> tuple[LegacyReceipt, ...]:
    _projection_table_size(
        db, "receipts", tuple(str(row[1]) for row in _table_layout(db, "receipts")),
    )
    receipts = []
    for row in db.execute(
        "SELECT id,task_id,attempt,phase,schema_version,authoritative "
        "FROM receipts ORDER BY id"
    ):
        if row["schema_version"] != 1 or row["authoritative"] != 0:
            raise DurableStoreError(
                "legacy receipt is not historical and non-authoritative"
            )
        receipts.append(LegacyReceipt(
            row["id"], row["task_id"], row["attempt"], row["phase"],
            row["schema_version"], row["authoritative"],
        ))
    return tuple(receipts)


def _replay_v2(ledger: bytes) -> sqlite3.Connection:
    events = _parse_ledger(ledger, allow_schema_v2=True)
    schema_events = [event for event in events if event["type"] == "schema.v2"]
    if len(schema_events) != 1:
        raise DurableStoreError("ledger must contain exactly one schema.v2 boundary event")
    schema_event = schema_events[0]
    if schema_event["seq"] != len(events):
        raise DurableStoreError("schema.v2 must be the final ledger event")
    payload = _validate_schema_payload(schema_event["payload"])
    prefix_description = payload["ledger_prefix"]
    prefix_bytes = prefix_description["bytes"]
    if prefix_bytes > len(ledger):
        raise DurableStoreError("schema.v2 ledger prefix length is invalid")
    prefix = ledger[:prefix_bytes]
    if _sha256(prefix) != prefix_description["sha256"]:
        raise DurableStoreError("schema.v2 ledger prefix digest is invalid")
    prefix_events = _parse_ledger(prefix, allow_schema_v2=False)
    if (len(prefix_events) != prefix_description["event_count"]
            or (prefix_events[-1]["hash"] if prefix_events else _GENESIS)
            != prefix_description["tip_hash"]
            or schema_event["seq"] != len(prefix_events) + 1):
        raise DurableStoreError("schema.v2 ledger prefix inventory is invalid")
    db = _replay_v1(prefix_events)
    try:
        inventory_sha256, _ = _v1_inventory(db, prefix, prefix_events)
        plan = _disposition_plan(db)
        if (inventory_sha256 != payload["v1_inventory_sha256"]
                or plan != payload["disposition_plan"]):
            raise DurableStoreError(
                "schema.v2 event differs from deterministic v1 inventory"
            )
        report = MigrationPreflight(
            1, "V1_READY", prefix_description["sha256"],
            prefix_description["bytes"], prefix_description["event_count"],
            prefix_description["tip_hash"], payload["v1_inventory_sha256"],
            payload["disposition_sha256"],
        )
        schema_line = _canonical({
            key: value for key, value in schema_event.items() if key != "seq"
        }) + b"\n"
        if ledger[prefix_bytes:] != schema_line:
            raise DurableStoreError("schema.v2 is not the exact final ledger line")
        db.execute("BEGIN IMMEDIATE")
        _apply_v2_ddl(db)
        _insert_prepared_metadata(db, report, plan, schema_event, schema_line)
        db.execute("COMMIT")
        db.execute("BEGIN IMMEDIATE")
        _insert_projected_event(db, schema_event)
        _apply_disposition_plan(
            db, plan, event_created_at=schema_event["created_at"],
        )
        cursor = db.execute(
            "UPDATE schema_metadata SET state='COMMITTED' "
            "WHERE singleton=1 AND state='PREPARED'"
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("replay could not commit schema metadata")
        db.execute("COMMIT")
        _assert_exact_v2_schema(db)
        return db
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        db.close()
        raise


class DurableProtocolStore:
    """Inert handle exposing only explicit migration and replay operations."""

    def __init__(self, state_dir: str | os.PathLike[str]):
        supplied_root = Path(state_dir)
        if not supplied_root.is_absolute():
            raise DurableStoreError("state directory must be an absolute canonical path")
        try:
            canonical_root = supplied_root.resolve(strict=True)
            info = os.lstat(supplied_root)
        except OSError as exc:
            raise DurableStoreError("state directory is unavailable") from exc
        if canonical_root != supplied_root:
            raise DurableStoreError("state directory must be an absolute canonical path")
        if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                or info.st_uid != os.geteuid()):
            raise DurableStoreError("state directory must be an owned real directory")
        if stat.S_IMODE(info.st_mode) != 0o700:
            raise DurableStoreError("state directory must be mode-0700")
        flags = (
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            self._root_fd = os.open(supplied_root, flags)
        except OSError as exc:
            raise DurableStoreError("state directory cannot be anchored safely") from exc
        anchored = os.fstat(self._root_fd)
        if ((anchored.st_dev, anchored.st_ino) != (info.st_dev, info.st_ino)
                or not stat.S_ISDIR(anchored.st_mode)
                or anchored.st_uid != os.geteuid()
                or stat.S_IMODE(anchored.st_mode) != 0o700):
            os.close(self._root_fd)
            raise DurableStoreError("state directory changed while being anchored")
        self._root_identity = (anchored.st_dev, anchored.st_ino)
        self._owner_pid = os.getpid()
        self.root = canonical_root
        self._closed = False
        try:
            for name, label in (
                ("state.sqlite3", "projection database"),
                ("state.sqlite3-wal", "projection WAL"),
                ("state.sqlite3-shm", "projection SHM"),
                ("state.sqlite3-journal", "unexpected rollback journal"),
                ("events.jsonl", "ledger"),
                (".writer.lock", "writer lock"),
                (".controller.lock", "controller lock"),
            ):
                identity = self._named_file_identity(
                    name, required=False, label=label,
                )
                if name == "state.sqlite3-journal" and identity is not None:
                    raise DurableStoreError(
                        "unexpected rollback journal residue is forbidden"
                    )
        except BaseException:
            os.close(self._root_fd)
            self._closed = True
            raise

    def __enter__(self) -> "DurableProtocolStore":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        os.close(self._root_fd)
        self._closed = True

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def _validate_root_identity(self) -> None:
        if self._closed:
            raise DurableStoreError("durable store handle is closed")
        if os.getpid() != self._owner_pid:
            raise DurableStoreError("durable store handle belongs to a different process")
        try:
            held = os.fstat(self._root_fd)
            current = os.lstat(self.root)
        except OSError as exc:
            raise DurableStoreError("state directory path was replaced or removed") from exc
        if (not stat.S_ISDIR(held.st_mode) or held.st_uid != os.geteuid()
                or stat.S_IMODE(held.st_mode) != 0o700
                or not stat.S_ISDIR(current.st_mode)
                or stat.S_ISLNK(current.st_mode)
                or current.st_uid != os.geteuid()
                or stat.S_IMODE(current.st_mode) != 0o700
                or (held.st_dev, held.st_ino) != self._root_identity
                or (current.st_dev, current.st_ino) != self._root_identity):
            raise DurableStoreError(
                "state directory path was replaced or is not mode-0700"
            )

    @staticmethod
    def _private_file_identity(info: os.stat_result, label: str) -> _FileIdentity:
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise DurableStoreError(f"{label} must be an owned regular file")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise DurableStoreError(f"{label} must be mode-0600")
        if info.st_nlink != 1:
            raise DurableStoreError(f"{label} must be single-linked")
        return _FileIdentity(info.st_dev, info.st_ino, info.st_size)

    def _named_file_identity(
        self, name: str, *, required: bool, label: str,
    ) -> Optional[_FileIdentity]:
        self._validate_root_identity()
        try:
            info = os.stat(name, dir_fd=self._root_fd, follow_symlinks=False)
        except FileNotFoundError:
            if required:
                raise DurableStoreError(f"{label} is required")
            return None
        except OSError as exc:
            raise DurableStoreError(f"{label} cannot be inspected safely") from exc
        return self._private_file_identity(info, label)

    def _assert_named_identity(
        self, name: str, expected: _FileIdentity, *, label: str,
        expected_size: Optional[int] = None,
    ) -> _FileIdentity:
        current = self._named_file_identity(name, required=True, label=label)
        assert current is not None
        if ((current.device, current.inode) != (expected.device, expected.inode)
                or (expected_size is not None and current.size != expected_size)):
            raise DurableStoreError(f"{label} path was replaced or changed")
        return current

    def _open_named_file(
        self, name: str, flags: int, *, label: str,
    ) -> tuple[int, _FileIdentity]:
        before = self._named_file_identity(name, required=True, label=label)
        assert before is not None
        safe_flags = (
            flags | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            fd = os.open(name, safe_flags, dir_fd=self._root_fd)
        except OSError as exc:
            raise DurableStoreError(f"{label} cannot be opened safely") from exc
        try:
            held = self._private_file_identity(os.fstat(fd), label)
            if held != before:
                raise DurableStoreError(f"{label} changed while being opened")
            self._assert_named_identity(
                name, held, label=label, expected_size=held.size,
            )
            return fd, held
        except BaseException:
            os.close(fd)
            raise

    @staticmethod
    def _crash(stage: str) -> None:
        if _CRASH_HOOK is not None:
            _CRASH_HOOK(stage)

    def _validate_state_files(self) -> None:
        self._named_file_identity(
            "state.sqlite3", required=True, label="projection database",
        )
        self._named_file_identity(
            "state.sqlite3-wal", required=False, label="projection WAL",
        )
        self._named_file_identity(
            "state.sqlite3-shm", required=False, label="projection SHM",
        )
        rollback = self._named_file_identity(
            "state.sqlite3-journal", required=False,
            label="unexpected rollback journal",
        )
        if rollback is not None:
            raise DurableStoreError(
                "unexpected rollback journal residue is forbidden"
            )
        self._named_file_identity("events.jsonl", required=False, label="ledger")
        self._named_file_identity(
            ".controller.lock", required=True, label="controller lock",
        )
        self._named_file_identity(
            ".writer.lock", required=True, label="writer lock",
        )

    @contextlib.contextmanager
    def _controller_quiescent(self) -> Iterator[None]:
        fd, identity = self._open_named_file(
            ".controller.lock", os.O_RDWR, label="controller lock",
        )
        locked = False
        identity_error: Optional[BaseException] = None
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise DurableStoreError(
                    "controller is active; migration requires quiescence"
                ) from exc
            locked = True
            self._assert_named_identity(
                ".controller.lock", identity, label="controller lock",
                expected_size=identity.size,
            )
            yield
        finally:
            try:
                self._assert_named_identity(
                    ".controller.lock", identity, label="controller lock",
                    expected_size=identity.size,
                )
            except BaseException as exc:
                identity_error = exc
            if locked:
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
            if identity_error is not None:
                raise identity_error

    @contextlib.contextmanager
    def _lock(self, *, exclusive: bool) -> Iterator[_FileIdentity]:
        fd, identity = self._open_named_file(
            ".writer.lock", os.O_RDONLY, label="writer lock",
        )
        identity_error: Optional[BaseException] = None
        try:
            fcntl.flock(fd, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            self._assert_named_identity(
                ".writer.lock", identity, label="writer lock",
                expected_size=identity.size,
            )
            yield identity
        finally:
            try:
                self._assert_named_identity(
                    ".writer.lock", identity, label="writer lock",
                    expected_size=identity.size,
                )
            except BaseException as exc:
                identity_error = exc
            fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
            if identity_error is not None:
                raise identity_error

    def _read_ledger(self) -> _LedgerSnapshot:
        identity = self._named_file_identity(
            "events.jsonl", required=False, label="ledger",
        )
        if identity is None:
            return _LedgerSnapshot(b"", None)
        if identity.size > _MAX_LEDGER_BYTES:
            raise DurableStoreError("ledger exceeds total byte bound")
        fd, opened = self._open_named_file(
            "events.jsonl", os.O_RDONLY | getattr(os, "O_NOATIME", 0),
            label="ledger",
        )
        try:
            if opened != identity:
                raise DurableStoreError("ledger changed while being opened")
            if opened.size > _MAX_LEDGER_BYTES:
                raise DurableStoreError("ledger exceeds total byte bound")
            opened_fingerprint = self._fingerprint(os.fstat(fd))
            data = bytearray()
            offset = 0
            while offset < opened.size:
                chunk = os.pread(fd, min(1024 * 1024, opened.size - offset), offset)
                if not chunk:
                    raise DurableStoreError("ledger changed while being read")
                data.extend(chunk)
                offset += len(chunk)
            held_info = os.fstat(fd)
            held_after = self._private_file_identity(held_info, "ledger")
            if (held_after != opened or len(data) != opened.size
                    or self._fingerprint(held_info) != opened_fingerprint):
                raise DurableStoreError("ledger changed while being read")
            self._assert_named_identity(
                "events.jsonl", opened, label="ledger",
                expected_size=opened.size,
            )
            return _LedgerSnapshot(bytes(data), opened)
        finally:
            os.close(fd)

    def _assert_ledger_snapshot(self, expected: _LedgerSnapshot) -> None:
        if self._read_ledger() != expected:
            raise DurableStoreError("ledger inode, length, or content changed")

    @staticmethod
    def _fingerprint(info: os.stat_result) -> tuple[int, int, int, int, int]:
        return (
            info.st_dev, info.st_ino, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns,
        )

    @staticmethod
    def _copy_regular_fd(
        source_fd: int, destination: Path, expected_size: int,
    ) -> None:
        destination_fd = os.open(
            destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600,
        )
        try:
            copied = 0
            while copied < expected_size:
                chunk = os.pread(
                    source_fd, min(1024 * 1024, expected_size - copied), copied,
                )
                if not chunk:
                    raise DurableStoreError("projection family changed during copy")
                offset = 0
                while offset < len(chunk):
                    written = os.write(destination_fd, chunk[offset:])
                    if written <= 0:
                        raise DurableStoreError("projection snapshot write stalled")
                    offset += written
                copied += len(chunk)
            if os.pread(source_fd, 1, expected_size):
                raise DurableStoreError("projection family grew during copy")
            os.fsync(destination_fd)
        finally:
            os.close(destination_fd)

    def _snapshot_family(self) -> dict[str, tuple[int, int, int, int, int]]:
        labels = {
            "state.sqlite3": "projection database",
            "state.sqlite3-wal": "projection WAL",
            "state.sqlite3-shm": "projection SHM",
        }
        family = {}
        rollback = self._named_file_identity(
            "state.sqlite3-journal", required=False,
            label="unexpected rollback journal",
        )
        if rollback is not None:
            raise DurableStoreError(
                "unexpected rollback journal residue is forbidden"
            )
        total = 0
        for name, label in labels.items():
            identity = self._named_file_identity(
                name, required=name == "state.sqlite3", label=label,
            )
            if identity is None:
                continue
            if identity.size > _MAX_DB_FAMILY_FILE_BYTES:
                raise DurableStoreError(f"{label} exceeds snapshot byte bound")
            info = os.stat(name, dir_fd=self._root_fd, follow_symlinks=False)
            observed = self._private_file_identity(info, label)
            if observed != identity:
                raise DurableStoreError(
                    f"{label} changed during snapshot admission"
                )
            if observed.size > _MAX_DB_FAMILY_FILE_BYTES:
                raise DurableStoreError(f"{label} exceeds snapshot byte bound")
            family[name] = self._fingerprint(info)
            total += observed.size
        if total > _MAX_DB_FAMILY_TOTAL_BYTES:
            raise DurableStoreError("projection DB family exceeds total snapshot bound")
        try:
            space = os.statvfs(tempfile.gettempdir())
            block_size = space.f_frsize or space.f_bsize
            available = space.f_bavail * block_size
        except (OSError, AttributeError) as exc:
            raise DurableStoreError("snapshot free space cannot be verified") from exc
        required = 2 * total + _SNAPSHOT_FREE_SPACE_RESERVE
        if available < required:
            raise DurableStoreError("insufficient free space for bounded DB snapshot")
        return family

    @contextlib.contextmanager
    def _snapshot_db(self) -> Iterator[sqlite3.Connection]:
        labels = {
            "state.sqlite3": "projection database",
            "state.sqlite3-wal": "projection WAL",
            "state.sqlite3-shm": "projection SHM",
        }
        before = self._snapshot_family()
        with tempfile.TemporaryDirectory(
            prefix="kizuki-durable-preflight-",
        ) as temporary:
            target_root = Path(temporary)
            for name, fingerprint in before.items():
                fd, identity = self._open_named_file(
                    name, os.O_RDONLY | getattr(os, "O_NOATIME", 0),
                    label=labels[name],
                )
                try:
                    if identity.size > _MAX_DB_FAMILY_FILE_BYTES:
                        raise DurableStoreError(
                            f"{labels[name]} exceeds snapshot byte bound"
                        )
                    if self._fingerprint(os.fstat(fd)) != fingerprint:
                        raise DurableStoreError(
                            "projection DB/WAL/SHM changed before snapshot"
                        )
                    self._copy_regular_fd(fd, target_root / name, identity.size)
                    if self._fingerprint(os.fstat(fd)) != fingerprint:
                        raise DurableStoreError(
                            "projection DB/WAL/SHM changed during snapshot"
                        )
                    self._assert_named_identity(
                        name, identity, label=labels[name],
                        expected_size=identity.size,
                    )
                finally:
                    os.close(fd)
            after = self._snapshot_family()
            if before != after:
                raise DurableStoreError(
                    "projection DB/WAL/SHM changed during read-only snapshot"
                )
            try:
                db = sqlite3.connect(target_root / "state.sqlite3")
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA query_only=ON")
                journal = db.execute("PRAGMA journal_mode").fetchone()
                if journal is None or str(journal[0]).lower() != "wal":
                    raise DurableStoreError(
                        "projection snapshot must use WAL journal mode"
                    )
            except DurableStoreError:
                if "db" in locals():
                    db.close()
                raise
            except sqlite3.Error as exc:
                raise DurableStoreError("projection snapshot cannot be opened") from exc
            try:
                yield db
            finally:
                db.close()

    @contextlib.contextmanager
    def _writable_db(self) -> Iterator[tuple[sqlite3.Connection, _FileIdentity]]:
        before = self._named_file_identity(
            "state.sqlite3", required=True, label="projection database",
        )
        assert before is not None
        anchored = f"/proc/self/fd/{self._root_fd}/state.sqlite3"
        uri = "file:" + quote(anchored, safe="/") + "?mode=rw"
        try:
            db = sqlite3.connect(
                uri, uri=True, isolation_level=None, timeout=30,
            )
            db.row_factory = sqlite3.Row
            journal = db.execute("PRAGMA journal_mode").fetchone()
            if journal is None or str(journal[0]).lower() != "wal":
                raise DurableStoreError(
                    "projection database must already use WAL journal mode"
                )
            db.execute("PRAGMA synchronous=FULL")
            synchronous = db.execute("PRAGMA synchronous").fetchone()
            if synchronous is None or int(synchronous[0]) != 2:
                raise DurableStoreError("projection database requires synchronous=FULL")
            db.execute("PRAGMA foreign_keys=ON")
            foreign_keys = db.execute("PRAGMA foreign_keys").fetchone()
            if foreign_keys is None or int(foreign_keys[0]) != 1:
                raise DurableStoreError("projection database requires foreign keys")
            db.execute("PRAGMA busy_timeout=30000")
            busy_timeout = db.execute("PRAGMA busy_timeout").fetchone()
            if busy_timeout is None or int(busy_timeout[0]) != 30_000:
                raise DurableStoreError(
                    "projection database requires busy_timeout=30000"
                )
            db.execute("PRAGMA wal_autocheckpoint=0")
        except DurableStoreError:
            if "db" in locals():
                db.close()
            raise
        except (sqlite3.Error, TypeError, ValueError) as exc:
            if "db" in locals():
                db.close()
            raise DurableStoreError(
                "projection database cannot be opened for explicit migration"
            ) from exc
        try:
            after = self._named_file_identity(
                "state.sqlite3", required=True, label="projection database",
            )
            assert after is not None
            if (before.device, before.inode) != (after.device, after.inode):
                raise DurableStoreError("projection database changed while opening")
            yield db, before
        finally:
            db.close()
            self._validate_root_identity()
            self._validate_state_files()
            self._assert_named_identity(
                "state.sqlite3", before, label="projection database",
            )

    @staticmethod
    def _v1_report(
        db: sqlite3.Connection, ledger: bytes, events: list[dict],
    ) -> tuple[MigrationPreflight, dict]:
        _assert_exact_v1_schema(db)
        _assert_v1_projection_matches_ledger(db, events)
        inventory_sha256, _ = _v1_inventory(db, ledger, events)
        plan = _disposition_plan(db)
        report = MigrationPreflight(
            schema_version=1,
            state="V1_READY",
            ledger_prefix_sha256=_sha256(ledger),
            ledger_prefix_bytes=len(ledger),
            ledger_event_count=len(events),
            ledger_tip_hash=events[-1]["hash"] if events else _GENESIS,
            v1_inventory_sha256=inventory_sha256,
            disposition_sha256=_sha256(_canonical(plan)),
        )
        _make_schema_event(report, plan, created_at=0.0)
        return report, plan

    @staticmethod
    def _report_from_metadata(metadata: sqlite3.Row) -> MigrationPreflight:
        return MigrationPreflight(
            schema_version=2,
            state=metadata["state"],
            ledger_prefix_sha256=metadata["ledger_prefix_sha256"],
            ledger_prefix_bytes=metadata["ledger_prefix_bytes"],
            ledger_event_count=metadata["ledger_event_count"],
            ledger_tip_hash=metadata["ledger_tip_hash"],
            v1_inventory_sha256=metadata["v1_inventory_sha256"],
            disposition_sha256=metadata["disposition_sha256"],
        )

    @staticmethod
    def _schema_event_for_prepared(
        ledger: bytes, report: MigrationPreflight, metadata: sqlite3.Row,
    ) -> tuple[dict, bytes, bool]:
        prefix = ledger[:report.ledger_prefix_bytes]
        if (len(prefix) != report.ledger_prefix_bytes
                or _sha256(prefix) != report.ledger_prefix_sha256):
            raise DurableStoreError(
                "schema.v2 did not preserve the exact v1 ledger prefix"
            )
        event, line = _prepared_schema_event(metadata)
        tail = ledger[report.ledger_prefix_bytes:]
        if len(tail) < len(line):
            if not line.startswith(tail):
                raise DurableStoreError("ledger has a divergent partial schema.v2 tail")
            return event, line, False
        if tail != line:
            raise DurableStoreError(
                "ledger contains bytes after or different from schema.v2"
            )
        return event, line, True

    def _append_schema_event(
        self, report: MigrationPreflight, metadata: sqlite3.Row,
        current_snapshot: _LedgerSnapshot, writer_identity: _FileIdentity,
        db_identity: _FileIdentity,
    ) -> tuple[dict, _LedgerSnapshot]:
        current_ledger = current_snapshot.data
        event, line, complete = self._schema_event_for_prepared(
            current_ledger, report, metadata,
        )
        tail = current_ledger[report.ledger_prefix_bytes:]
        remainder = b"" if complete else line[len(tail):]
        if len(current_ledger) + len(remainder) > _MAX_LEDGER_BYTES:
            raise DurableStoreError("schema.v2 append exceeds ledger byte bound")
        self._validate_root_identity()
        self._assert_named_identity(
            ".writer.lock", writer_identity, label="writer lock",
            expected_size=writer_identity.size,
        )
        self._assert_named_identity(
            "state.sqlite3", db_identity, label="projection database",
        )
        if current_snapshot.identity is None:
            if self._named_file_identity(
                "events.jsonl", required=False, label="ledger",
            ) is not None:
                raise DurableStoreError("ledger appeared before schema.v2 append")
            flags = (
                os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_EXCL
                | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
            )
            try:
                fd = os.open("events.jsonl", flags, 0o600, dir_fd=self._root_fd)
            except OSError as exc:
                raise DurableStoreError("ledger cannot be created safely") from exc
            os.fchmod(fd, 0o600)
            opened = self._private_file_identity(os.fstat(fd), "ledger")
            if opened.size != 0:
                os.close(fd)
                raise DurableStoreError("new ledger was not empty")
        else:
            fd, opened = self._open_named_file(
                "events.jsonl", os.O_RDWR | os.O_APPEND, label="ledger",
            )
            if opened != current_snapshot.identity:
                os.close(fd)
                raise DurableStoreError(
                    "ledger path was replaced before schema.v2 append"
                )
        try:
            current = bytearray()
            offset = 0
            while offset < opened.size:
                chunk = os.pread(
                    fd, min(1024 * 1024, opened.size - offset), offset,
                )
                if not chunk:
                    raise DurableStoreError("ledger changed before schema.v2 append")
                current.extend(chunk)
                offset += len(chunk)
            if bytes(current) != current_ledger:
                raise DurableStoreError("ledger content changed before schema.v2 append")
            if remainder:
                boundary = max(1, len(remainder) // 2)
                offset = 0
                while offset < boundary:
                    written = os.write(fd, remainder[offset:boundary])
                    if written <= 0:
                        raise DurableStoreError("ledger append stalled")
                    offset += written
                self._crash("during_ledger_append")
                while offset < len(remainder):
                    written = os.write(fd, remainder[offset:])
                    if written <= 0:
                        raise DurableStoreError("ledger append stalled")
                    offset += written
            os.fsync(fd)
            completed = self._private_file_identity(os.fstat(fd), "ledger")
            expected_size = len(current_ledger) + len(remainder)
            if ((completed.device, completed.inode) != (opened.device, opened.inode)
                    or completed.size != expected_size):
                raise DurableStoreError("ledger changed during schema.v2 append")
            self._assert_named_identity(
                "events.jsonl", completed, label="ledger",
                expected_size=expected_size,
            )
        finally:
            os.close(fd)
        os.fsync(self._root_fd)
        self._validate_root_identity()
        self._assert_named_identity(
            ".writer.lock", writer_identity, label="writer lock",
            expected_size=writer_identity.size,
        )
        self._assert_named_identity(
            "state.sqlite3", db_identity, label="projection database",
        )
        return event, _LedgerSnapshot(current_ledger + remainder, completed)

    def preflight_migration(self) -> MigrationPreflight:
        """Inspect an exact v1 or v2 store from a bounded read-only snapshot."""
        with self._lock(exclusive=False):
            ledger = self._read_ledger().data
            with self._snapshot_db() as db:
                table_names = _bounded_table_names(db)
                if table_names == set(_V1_LAYOUT):
                    events = _parse_ledger(ledger, allow_schema_v2=False)
                    report, _ = self._v1_report(db, ledger, events)
                else:
                    _assert_exact_v2_schema(db)
                    metadata = _read_metadata(db)
                    report = self._report_from_metadata(metadata)
                    plan = _metadata_plan(metadata)
                    prefix = ledger[:report.ledger_prefix_bytes]
                    if (len(prefix) != report.ledger_prefix_bytes
                            or _sha256(prefix) != report.ledger_prefix_sha256):
                        raise DurableStoreError(
                            "v2 ledger no longer contains its exact v1 prefix"
                        )
                    prefix_events = _parse_ledger(prefix, allow_schema_v2=False)
                    if (len(prefix_events) != report.ledger_event_count
                            or (prefix_events[-1]["hash"] if prefix_events else _GENESIS)
                            != report.ledger_tip_hash):
                        raise DurableStoreError("v2 ledger prefix inventory changed")
                    if metadata["state"] == "PREPARED":
                        self._schema_event_for_prepared(ledger, report, metadata)
                        _assert_prepared_projection(db)
                        _assert_v1_projection_matches_ledger(db, prefix_events)
                        inventory_sha256, _ = _v1_inventory(
                            db, prefix, prefix_events,
                        )
                        if (inventory_sha256 != report.v1_inventory_sha256
                                or _disposition_plan(db) != plan):
                            raise DurableStoreError(
                                "PREPARED projection differs from its v1 inventory"
                            )
                    else:
                        self._committed_result(db, ledger, metadata)
        return report

    def migrate_v1_to_v2(self) -> MigrationResult:
        """Explicitly migrate, or idempotently resume, one exact v1 store."""
        with self._controller_quiescent():
            return self._migrate_under_writer()

    def _migrate_under_writer(self) -> MigrationResult:
        with self._lock(exclusive=True) as writer_identity:
            self._validate_state_files()
            ledger_snapshot = self._read_ledger()
            ledger = ledger_snapshot.data
            with self._snapshot_db() as inspection:
                inspected_tables = _bounded_table_names(inspection)
                starts_as_v1 = inspected_tables == set(_V1_LAYOUT)
                if starts_as_v1:
                    events = _parse_ledger(ledger, allow_schema_v2=False)
                    inspected_report, inspected_plan = self._v1_report(
                        inspection, ledger, events,
                    )
                else:
                    _assert_exact_v2_schema(inspection)
                    inspected_metadata = _read_metadata(inspection)
                    inspected_report = self._report_from_metadata(inspected_metadata)
                    inspected_plan = _metadata_plan(inspected_metadata)
                    self._schema_event_for_prepared(
                        ledger, inspected_report, inspected_metadata,
                    )
                    if inspected_metadata["state"] == "PREPARED":
                        _assert_prepared_projection(inspection)

            if starts_as_v1:
                self._crash("before_ddl")

            if self._read_ledger() != ledger_snapshot:
                raise DurableStoreError(
                    "ledger changed after read-only migration inspection"
                )
            self._validate_state_files()
            with self._writable_db() as (db, db_identity):
                table_names = _bounded_table_names(db)
                if starts_as_v1:
                    if table_names != set(_V1_LAYOUT):
                        raise DurableStoreError(
                            "projection schema changed after migration inspection"
                        )
                    report, plan = self._v1_report(db, ledger, events)
                    if report != inspected_report or plan != inspected_plan:
                        raise DurableStoreError(
                            "v1 inventory changed after migration inspection"
                        )
                    schema_event, schema_event_bytes = _make_schema_event(
                        report, plan,
                    )
                    db.execute("BEGIN IMMEDIATE")
                    try:
                        _assert_exact_v1_schema(db)
                        _apply_v2_ddl(db)
                        _insert_prepared_metadata(
                            db, report, plan, schema_event, schema_event_bytes,
                        )
                        db.execute("COMMIT")
                    except BaseException:
                        if db.in_transaction:
                            db.execute("ROLLBACK")
                        raise
                    self._crash("after_ddl")
                    metadata = _read_metadata(db)
                else:
                    _assert_exact_v2_schema(db)
                    metadata = _read_metadata(db)
                    report = self._report_from_metadata(metadata)
                    plan = _metadata_plan(metadata)
                    if report != inspected_report or plan != inspected_plan:
                        raise DurableStoreError(
                            "v2 recovery state changed after migration inspection"
                        )

                if metadata["state"] == "COMMITTED":
                    return self._committed_result(db, ledger, metadata)

                _assert_prepared_projection(db)
                prefix = ledger[:report.ledger_prefix_bytes]
                prefix_events = _parse_ledger(prefix, allow_schema_v2=False)
                if (len(prefix_events) != report.ledger_event_count
                        or (prefix_events[-1]["hash"] if prefix_events else _GENESIS)
                        != report.ledger_tip_hash):
                    raise DurableStoreError("PREPARED v1 event inventory changed")
                _assert_v1_projection_matches_ledger(db, prefix_events)
                inventory_sha256, _ = _v1_inventory(db, prefix, prefix_events)
                if (inventory_sha256 != report.v1_inventory_sha256
                        or _disposition_plan(db) != plan):
                    raise DurableStoreError("PREPARED v1 projection changed")

                schema_event, ledger_snapshot = self._append_schema_event(
                    report, metadata, ledger_snapshot, writer_identity,
                    db_identity,
                )
                ledger = ledger_snapshot.data
                self._crash("after_ledger_fsync")
                self._assert_ledger_snapshot(ledger_snapshot)

                db.execute("BEGIN IMMEDIATE")
                try:
                    if db.execute(
                        "SELECT 1 FROM events WHERE seq=? OR hash=?",
                        (schema_event["seq"], schema_event["hash"]),
                    ).fetchone():
                        raise DurableStoreError(
                            "schema.v2 is already partially projected"
                        )
                    _insert_projected_event(db, schema_event)
                    _apply_disposition_plan(
                        db, plan, event_created_at=schema_event["created_at"],
                    )
                    cursor = db.execute(
                        "UPDATE schema_metadata SET state='COMMITTED' "
                        "WHERE singleton=1 AND schema_version=2 AND state='PREPARED'"
                    )
                    if cursor.rowcount != 1:
                        raise DurableStoreError(
                            "migration metadata was not PREPARED"
                        )
                    self._crash("before_projection_commit")
                    self._assert_ledger_snapshot(ledger_snapshot)
                    self._assert_named_identity(
                        ".writer.lock", writer_identity, label="writer lock",
                        expected_size=writer_identity.size,
                    )
                    self._assert_named_identity(
                        "state.sqlite3", db_identity,
                        label="projection database",
                    )
                    db.execute("COMMIT")
                except BaseException:
                    if db.in_transaction:
                        db.execute("ROLLBACK")
                    raise
                metadata = _read_metadata(db)
                return self._committed_result(db, ledger, metadata)

    @staticmethod
    def _committed_result(
        db: sqlite3.Connection, ledger: bytes, metadata: sqlite3.Row,
    ) -> MigrationResult:
        if metadata["state"] != "COMMITTED":
            raise DurableStoreError("migration is not committed")
        events = _parse_ledger(ledger, allow_schema_v2=True)
        schema_events = [event for event in events if event["type"] == "schema.v2"]
        if len(schema_events) != 1 or schema_events[0]["seq"] != len(events):
            raise DurableStoreError(
                "ledger must end with exactly one schema.v2 boundary event"
            )
        schema_event = schema_events[0]
        _validate_schema_payload(schema_event["payload"], metadata)
        expected_event, expected_bytes = _prepared_schema_event(metadata)
        if schema_event != expected_event:
            raise DurableStoreError(
                "committed schema.v2 event differs from PREPARED metadata"
            )
        boundary = metadata["ledger_prefix_bytes"]
        if ledger[boundary:] != expected_bytes:
            raise DurableStoreError(
                "committed ledger lost exact schema.v2 event bytes"
            )
        live_digest = _v2_projection_digest(db)
        replay = _replay_v2(ledger)
        try:
            replay_digest = _v2_projection_digest(replay)
        finally:
            replay.close()
        if live_digest != replay_digest:
            raise DurableStoreError(
                "committed projection differs from deterministic empty-v2 replay"
            )
        return MigrationResult(
            schema_version=2,
            state="COMMITTED",
            schema_event_hash=schema_event["hash"],
            schema_event_sequence=schema_event["seq"],
            ledger_prefix_sha256=metadata["ledger_prefix_sha256"],
            ledger_prefix_bytes=metadata["ledger_prefix_bytes"],
            v1_inventory_sha256=metadata["v1_inventory_sha256"],
            disposition_sha256=metadata["disposition_sha256"],
            projection_sha256=live_digest,
            replay_projection_sha256=replay_digest,
        )

    def legacy_receipts(self) -> tuple[LegacyReceipt, ...]:
        with self._lock(exclusive=False):
            ledger = self._read_ledger()
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                metadata = _read_metadata(db)
                if metadata["state"] != "COMMITTED":
                    raise DurableStoreError(
                        "legacy receipts are unavailable before COMMITTED"
                    )
                self._committed_result(db, ledger.data, metadata)
                receipts = _legacy_receipts(db)
                self._assert_ledger_snapshot(ledger)
                return receipts

    def migration_view(self) -> MigrationView:
        """Return bounded dispositions without exposing legacy holders/tokens."""
        with self._lock(exclusive=False):
            ledger = self._read_ledger()
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                metadata = _read_metadata(db)
                if metadata["state"] != "COMMITTED":
                    raise DurableStoreError(
                        "migration view is unavailable before COMMITTED"
                    )
                self._committed_result(db, ledger.data, metadata)
                view_tables = {
                    name: _table_layout(db, name)
                    for name in (
                        "campaigns", "tasks", "leases", "merge_claims",
                        "merge_recovery_tasks",
                    )
                }
                _admit_projection_tables(db, view_tables)
                campaigns = tuple(
                    MigratedCampaign(
                        row["id"], row["state"], bool(row["recovery_required"]),
                    )
                    for row in db.execute(
                        "SELECT id,state,recovery_required FROM campaigns ORDER BY id"
                    )
                )
                tasks = tuple(
                    MigratedTask(
                        row["id"], row["state"], row["version"],
                        row["recovery_from"],
                    )
                    for row in db.execute(
                        "SELECT id,state,version,recovery_from FROM tasks ORDER BY id"
                    )
                )
                lease_count = db.execute(
                    "SELECT count(*) FROM leases"
                ).fetchone()[0]
                hold = db.execute(
                    "SELECT status FROM merge_claims "
                    "WHERE resource='merge/global'"
                ).fetchone()
                hold_task_count = db.execute(
                    "SELECT count(*) FROM merge_recovery_tasks "
                    "WHERE resource='merge/global'"
                ).fetchone()[0]
                if ((hold is None) != (hold_task_count == 0)
                        or (hold is not None
                            and hold["status"] != "RECOVERY_REQUIRED")):
                    raise DurableStoreError(
                        "merge recovery hold projection is inconsistent"
                    )
                view = MigrationView(
                    campaigns, tasks, lease_count,
                    hold is not None, hold_task_count,
                )
                self._assert_ledger_snapshot(ledger)
                return view

    def projection_digest(self) -> str:
        with self._lock(exclusive=False):
            ledger = self._read_ledger()
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                metadata = _read_metadata(db)
                if metadata["state"] != "COMMITTED":
                    raise DurableStoreError("projection is not committed")
                result = self._committed_result(db, ledger.data, metadata)
                self._assert_ledger_snapshot(ledger)
                return result.projection_sha256

    def replay_projection(self) -> ReplayProjection:
        with self._lock(exclusive=False):
            ledger = self._read_ledger().data
        db = _replay_v2(ledger)
        try:
            metadata = _read_metadata(db)
            return ReplayProjection(
                2, metadata["state"], _v2_projection_digest(db),
                _legacy_receipts(db),
            )
        finally:
            db.close()

    def verify_replay_equivalence(self) -> bool:
        return (
            self.projection_digest()
            == self.replay_projection().projection_sha256
        )
