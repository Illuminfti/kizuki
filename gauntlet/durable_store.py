"""Explicit, fail-closed migration seam for the durable protocol store.

Construction is inert.  Source state is inspected from a lock-consistent copy;
only :meth:`DurableProtocolStore.migrate_v1_to_v2` may change it.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import math
import os
import sqlite3
import stat
import tempfile
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from types import MappingProxyType
from typing import Callable, Iterator, Mapping, Optional
from urllib.parse import quote

from .identity import (
    AuthorityBinding,
    IdentityError,
    IdentityManifest,
    IdentityReceipt,
    authenticate_authority_binding,
    receipt_is_current,
)


GENESIS = "0" * 64
V1_EVENT_TYPES = frozenset({
    "controller.epoch", "campaign.created", "campaign.state", "task.created",
    "task.state", "lease.acquired", "lease.heartbeat", "lease.released",
    "receipt.recorded", "incident", "reconciliation", "adapter.receipt",
})
# Runtime v2 event handlers are added by later slices. Keeping the registry
# closed by default makes every post-migration event fail closed until both its
# validation and projection application are explicitly registered.
V2_EVENT_APPLIERS: Mapping[
    str, Callable[[sqlite3.Connection, Mapping[str, object]], None]
]


class DurableStoreError(RuntimeError):
    """The store cannot be recognized, migrated, or replayed safely."""


PHASE_ROLES = frozenset({
    "builder", "verifier", "spec-reviewer", "regression-reviewer",
    "independent-reviewer", "integrator", "post-merge-verifier",
})
REVIEW_ROLES = frozenset({
    "spec-reviewer", "regression-reviewer", "independent-reviewer",
})
NONTERMINAL_ATTEMPT_STATES = frozenset({
    "CLAIMED", "SPECIFIED", "LAUNCH_PREPARED", "RUNNING", "STOPPING",
    "EXITED", "RECOVERY_REQUIRED",
})
TERMINAL_CAMPAIGN_STATES = frozenset({"ABORTED", "RELEASED"})


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
class CampaignView:
    id: str
    state: str
    epoch: int
    version: int
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
class CleanupEvidence:
    evidence_sha256: str
    cgroup_empty: bool

    def __post_init__(self) -> None:
        _require_hex(self.evidence_sha256, 64, "cleanup evidence digest")
        if not isinstance(self.cgroup_empty, bool):
            raise DurableStoreError("cgroup_empty must be boolean")


@dataclass(frozen=True)
class PhaseResult:
    subject_sha: str
    base_sha: str
    result_sha: str
    evidence_sha256: str
    cleanup: CleanupEvidence
    task_spec_sha256: Optional[str] = None
    unit_identity_sha256: Optional[str] = None
    instruction_sha256: Optional[str] = None
    instruction_bytes: Optional[int] = None
    instruction_materialization_sha256: Optional[str] = None
    instruction_materialization_bytes: Optional[int] = None
    instruction_transport_sha256: Optional[str] = None
    instruction_transport_bytes: Optional[int] = None
    cpu_usage_ns: Optional[int] = None
    memory_peak_bytes: Optional[int] = None
    tasks_peak: Optional[int] = None
    oom_count: Optional[int] = None
    oom_killed: Optional[bool] = None
    systemd_service_result: Optional[str] = None
    systemd_exec_code: Optional[int] = None
    systemd_exec_status: Optional[int] = None
    resource_outcome_sha256: Optional[str] = None

    def __post_init__(self) -> None:
        for value, label in (
            (self.subject_sha, "result subject SHA"),
            (self.base_sha, "result base SHA"),
            (self.result_sha, "result SHA"),
        ):
            _require_hex(value, 40, label)
        _require_hex(self.evidence_sha256, 64, "result evidence digest")
        if not isinstance(self.cleanup, CleanupEvidence):
            raise DurableStoreError("CleanupEvidence required")
        for value, label in (
            (self.task_spec_sha256, "task spec digest"),
            (self.unit_identity_sha256, "unit identity digest"),
            (self.instruction_sha256, "instruction digest"),
            (self.instruction_materialization_sha256,
             "instruction materialization digest"),
            (self.instruction_transport_sha256, "instruction transport digest"),
            (self.resource_outcome_sha256, "resource outcome digest"),
        ):
            _require_hex(value, 64, label)
        lengths = (
            self.instruction_bytes, self.instruction_materialization_bytes,
            self.instruction_transport_bytes,
        )
        if (any(isinstance(value, bool) or not isinstance(value, int)
                or not 1 <= value <= 1048576 for value in lengths)
                or self.instruction_materialization_sha256 != self.instruction_sha256
                or self.instruction_transport_sha256 != self.instruction_sha256
                or self.instruction_materialization_bytes != self.instruction_bytes
                or self.instruction_transport_bytes != self.instruction_bytes):
            raise DurableStoreError("instruction evidence must be exact and bounded")
        for value, maximum, label in (
            (self.cpu_usage_ns, 9223372036854775807, "CPU usage"),
            (self.memory_peak_bytes, 9223372036854775807, "memory peak"),
            (self.tasks_peak, 1000000, "tasks peak"),
            (self.oom_count, 2147483647, "OOM count"),
            (self.systemd_exec_status, 255, "systemd exec status"),
        ):
            if (isinstance(value, bool) or not isinstance(value, int)
                    or not 0 <= value <= maximum):
                raise DurableStoreError(f"{label} must be a bounded integer")
        if (not isinstance(self.oom_killed, bool)
                or (self.oom_killed and self.oom_count == 0)):
            raise DurableStoreError("OOM evidence is inconsistent")
        if self.systemd_service_result not in {
            "success", "exit-code", "signal", "core-dump", "watchdog",
            "start-limit-hit", "resources", "timeout", "oom-kill", "protocol",
        }:
            raise DurableStoreError("systemd service result is invalid")
        if (isinstance(self.systemd_exec_code, bool)
                or self.systemd_exec_code not in {1, 2, 3}):
            raise DurableStoreError("systemd exec code is invalid")


@dataclass(frozen=True)
class TaskView:
    id: str
    state: str
    attempts: int
    version: int
    repository: Optional[str]
    base_sha: Optional[str]
    pr_number: Optional[int]
    subject_sha: Optional[str]
    active_role: Optional[str]


@dataclass(frozen=True)
class IdentityRegistration:
    principal_id: str
    authority_domain: str
    identity_receipt_sha256: str
    manifest_sha256: str
    generation: int


@dataclass(frozen=True)
class PhaseAuthorityRequest:
    task_id: str
    task_attempt: int
    execution_generation: int
    role: str
    epoch: int
    subject_sha: str
    task_version: int
    operation_sha256: str


@dataclass(frozen=True)
class LeaseGrant:
    attempt_id: str
    task_id: str
    task_attempt: int
    execution_generation: int
    role: str
    principal_id: str
    authority_domain: str
    binding_id: str
    identity_receipt_sha256: str
    account_binding_sha256: str
    resource: str
    token: int
    run_id: str
    epoch: int
    task_version: int
    attempt_version: int
    lease_version: int
    subject_sha: str
    base_sha: str
    expires_at: float


@dataclass(frozen=True)
class PhaseAttemptView:
    attempt_id: str
    task_id: str
    task_attempt: int
    execution_generation: int
    role: str
    principal_id: str
    authority_domain: str
    token: int
    run_id: str
    epoch: int
    state: str
    version: int


@dataclass(frozen=True)
class PhaseReceiptView:
    id: str
    attempt_id: str
    task_id: str
    task_attempt: int
    execution_generation: int
    role: str
    verdict: str
    subject_sha: str
    result_sha: str
    evidence_sha256: str
    event_seq: int


@dataclass(frozen=True)
class RuntimeRecoveryView:
    attempts: tuple[PhaseAttemptView, ...]


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
V1_LAYOUT: Mapping[str, tuple[tuple[object, ...], ...]] = {
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
    "ALTER TABLE campaigns ADD COLUMN recovery_required INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE tasks ADD COLUMN repository TEXT CHECK(repository IS NULL OR (length(repository) BETWEEN 3 AND 200 AND repository NOT GLOB '*[^A-Za-z0-9._/-]*' AND repository NOT LIKE '/%' AND repository NOT LIKE '%/' AND instr(repository,'..')=0))",
    "ALTER TABLE tasks ADD COLUMN base_sha TEXT CHECK(base_sha IS NULL OR (length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'))",
    "ALTER TABLE tasks ADD COLUMN pr_number INTEGER CHECK(pr_number IS NULL OR pr_number>0)",
    "ALTER TABLE tasks ADD COLUMN protocol_version INTEGER CHECK(protocol_version IS NULL OR protocol_version=2)",
    "ALTER TABLE tasks ADD COLUMN subject_sha TEXT CHECK(subject_sha IS NULL OR (length(subject_sha)=40 AND subject_sha NOT GLOB '*[^0-9a-f]*'))",
    "ALTER TABLE tasks ADD COLUMN merge_sha TEXT CHECK(merge_sha IS NULL OR (length(merge_sha)=40 AND merge_sha NOT GLOB '*[^0-9a-f]*'))",
    "ALTER TABLE tasks ADD COLUMN active_role TEXT CHECK(active_role IS NULL OR active_role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier'))",
    "ALTER TABLE tasks ADD COLUMN recovery_from TEXT",
    "ALTER TABLE receipts ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE receipts ADD COLUMN authoritative INTEGER NOT NULL DEFAULT 0",
    """CREATE TABLE schema_metadata(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        schema_version INTEGER NOT NULL CHECK(schema_version=2),
        state TEXT NOT NULL CHECK(state IN ('PREPARED','COMMITTED')),
        ledger_prefix_sha256 TEXT NOT NULL,
        ledger_prefix_bytes INTEGER NOT NULL,
        ledger_event_count INTEGER NOT NULL,
        ledger_tip_hash TEXT NOT NULL,
        v1_inventory_sha256 TEXT NOT NULL,
        disposition_sha256 TEXT NOT NULL,
        disposition_json TEXT NOT NULL,
        schema_event_bytes BLOB NOT NULL,
        schema_event_hash TEXT NOT NULL,
        schema_event_created_at REAL NOT NULL
    )""",
    """CREATE TABLE protocol_counters(
        name TEXT PRIMARY KEY CHECK(name='phase_fence'),
        value INTEGER NOT NULL CHECK(value>=0)
    )""",
    """CREATE TABLE identity_lineages(
        lineage_id TEXT PRIMARY KEY
            CHECK(length(lineage_id)=64 AND lineage_id NOT GLOB '*[^0-9a-f]*'),
        principal_id TEXT NOT NULL UNIQUE
            CHECK(length(principal_id) BETWEEN 1 AND 80 AND principal_id NOT GLOB '*[^A-Za-z0-9._-]*'),
        authority_domain TEXT NOT NULL UNIQUE
            CHECK(length(authority_domain) BETWEEN 1 AND 80 AND authority_domain NOT GLOB '*[^A-Za-z0-9._-]*'),
        account_binding_sha256 TEXT NOT NULL UNIQUE
            CHECK(length(account_binding_sha256)=64 AND account_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
        created_event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        UNIQUE(lineage_id,principal_id,authority_domain,account_binding_sha256)
    )""",
    """CREATE TABLE identity_registry(
        identity_receipt_sha256 TEXT PRIMARY KEY
            CHECK(length(identity_receipt_sha256)=64 AND identity_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
        lineage_id TEXT NOT NULL REFERENCES identity_lineages(lineage_id),
        manifest_sha256 TEXT NOT NULL
            CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
        principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 80 AND principal_id NOT GLOB '*[^A-Za-z0-9._-]*'),
        authority_domain TEXT NOT NULL CHECK(length(authority_domain) BETWEEN 1 AND 80 AND authority_domain NOT GLOB '*[^A-Za-z0-9._-]*'),
        adapter TEXT NOT NULL CHECK(adapter IN ('codex','claude','cursor','grok')),
        generation INTEGER NOT NULL CHECK(generation>0),
        account_binding_sha256 TEXT NOT NULL
            CHECK(length(account_binding_sha256)=64 AND account_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
        executable_sha256 TEXT NOT NULL
            CHECK(length(executable_sha256)=64 AND executable_sha256 NOT GLOB '*[^0-9a-f]*'),
        network_profile_sha256 TEXT NOT NULL
            CHECK(length(network_profile_sha256)=64 AND network_profile_sha256 NOT GLOB '*[^0-9a-f]*'),
        checked_at REAL NOT NULL, expires_at REAL NOT NULL CHECK(expires_at>checked_at),
        registered_epoch INTEGER NOT NULL CHECK(registered_epoch>0),
        registered_event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        UNIQUE(lineage_id,generation),
        UNIQUE(identity_receipt_sha256,manifest_sha256),
        UNIQUE(identity_receipt_sha256,account_binding_sha256),
        UNIQUE(identity_receipt_sha256,manifest_sha256,principal_id,
               authority_domain,account_binding_sha256),
        FOREIGN KEY(lineage_id,principal_id,authority_domain,account_binding_sha256)
            REFERENCES identity_lineages(lineage_id,principal_id,
                                         authority_domain,account_binding_sha256)
    )""",
    """CREATE TABLE consumed_authority_bindings(
        binding_id TEXT PRIMARY KEY CHECK(length(binding_id)=64 AND binding_id NOT GLOB '*[^0-9a-f]*'),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        task_attempt INTEGER NOT NULL CHECK(task_attempt>0),
        execution_generation INTEGER NOT NULL CHECK(execution_generation>0),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 80),
        authority_domain TEXT NOT NULL CHECK(length(authority_domain) BETWEEN 1 AND 80),
        account_binding_sha256 TEXT NOT NULL CHECK(length(account_binding_sha256)=64 AND account_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
        identity_receipt_sha256 TEXT NOT NULL REFERENCES identity_registry(identity_receipt_sha256),
        manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
        operation_sha256 TEXT NOT NULL CHECK(length(operation_sha256)=64 AND operation_sha256 NOT GLOB '*[^0-9a-f]*'),
        expires_at REAL NOT NULL,
        run_id TEXT NOT NULL UNIQUE CHECK(length(run_id)=64 AND run_id NOT GLOB '*[^0-9a-f]*'),
        epoch INTEGER NOT NULL CHECK(epoch>0),
        consumed_event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        UNIQUE(binding_id,task_id,task_attempt,role,execution_generation),
        UNIQUE(binding_id,principal_id,authority_domain,
               account_binding_sha256,identity_receipt_sha256),
        UNIQUE(binding_id,principal_id,authority_domain,
               account_binding_sha256,identity_receipt_sha256,manifest_sha256),
        UNIQUE(binding_id,task_id,task_attempt,execution_generation,role,
               principal_id,authority_domain,run_id,epoch),
        UNIQUE(binding_id,task_id,task_attempt,execution_generation,role,
               principal_id,authority_domain,account_binding_sha256,
               identity_receipt_sha256,manifest_sha256),
        FOREIGN KEY(identity_receipt_sha256,manifest_sha256,principal_id,
                    authority_domain,account_binding_sha256)
            REFERENCES identity_registry(identity_receipt_sha256,manifest_sha256,
                                         principal_id,authority_domain,
                                         account_binding_sha256)
    )""",
    """CREATE TABLE phase_attempts(
        attempt_id TEXT PRIMARY KEY CHECK(length(attempt_id)=64 AND attempt_id NOT GLOB '*[^0-9a-f]*'),
        task_id TEXT NOT NULL REFERENCES tasks(id), task_attempt INTEGER NOT NULL CHECK(task_attempt>0),
        execution_generation INTEGER NOT NULL CHECK(execution_generation>0),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 80),
        authority_domain TEXT NOT NULL CHECK(length(authority_domain) BETWEEN 1 AND 80),
        binding_id TEXT NOT NULL UNIQUE REFERENCES consumed_authority_bindings(binding_id),
        lease_resource TEXT NOT NULL CHECK(length(lease_resource) BETWEEN 1 AND 240),
        lease_token INTEGER NOT NULL UNIQUE CHECK(lease_token>0),
        run_id TEXT NOT NULL UNIQUE CHECK(length(run_id)=64 AND run_id NOT GLOB '*[^0-9a-f]*'),
        epoch INTEGER NOT NULL CHECK(epoch>0),
        state TEXT NOT NULL CHECK(state IN ('CLAIMED','SPECIFIED','LAUNCH_PREPARED','RUNNING','STOPPING','EXITED','COMPLETED','FAILED','RECOVERY_REQUIRED','RECOVERED')),
        recovery_from TEXT, interrupted_state TEXT
            CHECK(interrupted_state IS NULL OR interrupted_state IN ('CLAIMED','SPECIFIED','LAUNCH_PREPARED','RUNNING','STOPPING','EXITED','RECOVERY_REQUIRED')),
        version INTEGER NOT NULL CHECK(version>0),
        created_event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        updated_event_seq INTEGER NOT NULL REFERENCES events(seq),
        CHECK((state='RECOVERY_REQUIRED')=(interrupted_state IS NOT NULL)),
        UNIQUE(attempt_id,task_id,task_attempt,role,execution_generation),
        UNIQUE(attempt_id,task_id,task_attempt,role,execution_generation,binding_id),
        UNIQUE(attempt_id,task_id,task_attempt,execution_generation,role,
               binding_id,principal_id,authority_domain),
        UNIQUE(attempt_id,task_id,task_attempt,execution_generation,role,
               principal_id,authority_domain,binding_id,lease_resource,
               lease_token,run_id,epoch),
        FOREIGN KEY(binding_id,task_id,task_attempt,role,execution_generation)
            REFERENCES consumed_authority_bindings(binding_id,task_id,task_attempt,role,execution_generation),
        FOREIGN KEY(binding_id,task_id,task_attempt,execution_generation,role,
                    principal_id,authority_domain,run_id,epoch)
            REFERENCES consumed_authority_bindings(binding_id,task_id,task_attempt,
                                                   execution_generation,role,
                                                   principal_id,authority_domain,
                                                   run_id,epoch)
    )""",
    """CREATE TABLE phase_leases(
        resource TEXT PRIMARY KEY CHECK(length(resource) BETWEEN 1 AND 240),
        attempt_id TEXT NOT NULL UNIQUE REFERENCES phase_attempts(attempt_id),
        task_id TEXT NOT NULL REFERENCES tasks(id), task_attempt INTEGER NOT NULL CHECK(task_attempt>0),
        execution_generation INTEGER NOT NULL CHECK(execution_generation>0),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        run_id TEXT NOT NULL UNIQUE CHECK(length(run_id)=64 AND run_id NOT GLOB '*[^0-9a-f]*'),
        principal_id TEXT NOT NULL CHECK(length(principal_id) BETWEEN 1 AND 80),
        authority_domain TEXT NOT NULL CHECK(length(authority_domain) BETWEEN 1 AND 80),
        account_binding_sha256 TEXT NOT NULL CHECK(length(account_binding_sha256)=64 AND account_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
        identity_receipt_sha256 TEXT NOT NULL CHECK(length(identity_receipt_sha256)=64 AND identity_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
        binding_id TEXT NOT NULL UNIQUE REFERENCES consumed_authority_bindings(binding_id),
        token INTEGER NOT NULL UNIQUE CHECK(token>0),
        heartbeat_at REAL NOT NULL, expires_at REAL NOT NULL CHECK(expires_at>heartbeat_at),
        epoch INTEGER NOT NULL CHECK(epoch>0), version INTEGER NOT NULL CHECK(version>0),
        FOREIGN KEY(attempt_id,task_id,task_attempt,role,execution_generation,binding_id)
            REFERENCES phase_attempts(attempt_id,task_id,task_attempt,role,execution_generation,binding_id),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    principal_id,authority_domain,binding_id,resource,token,
                    run_id,epoch)
            REFERENCES phase_attempts(attempt_id,task_id,task_attempt,
                                     execution_generation,role,principal_id,
                                     authority_domain,binding_id,lease_resource,
                                     lease_token,run_id,epoch),
        FOREIGN KEY(binding_id,principal_id,authority_domain,
                    account_binding_sha256,identity_receipt_sha256)
            REFERENCES consumed_authority_bindings(binding_id,principal_id,
                                                    authority_domain,
                                                    account_binding_sha256,
                                                    identity_receipt_sha256)
    )""",
    "CREATE UNIQUE INDEX one_active_phase_principal ON phase_leases(principal_id)",
    "CREATE UNIQUE INDEX one_active_phase_authority_domain ON phase_leases(authority_domain)",
    "CREATE UNIQUE INDEX one_active_phase_account ON phase_leases(account_binding_sha256)",
    "CREATE UNIQUE INDEX one_active_phase_receipt ON phase_leases(identity_receipt_sha256)",
    "CREATE UNIQUE INDEX one_active_phase_task ON phase_leases(task_id)",
    """CREATE TABLE phase_receipts(
        id TEXT PRIMARY KEY CHECK(length(id)=64 AND id NOT GLOB '*[^0-9a-f]*'),
        attempt_id TEXT NOT NULL UNIQUE REFERENCES phase_attempts(attempt_id),
        task_id TEXT NOT NULL REFERENCES tasks(id), task_attempt INTEGER NOT NULL CHECK(task_attempt>0),
        execution_generation INTEGER NOT NULL CHECK(execution_generation>0),
        phase TEXT NOT NULL CHECK(length(phase) BETWEEN 1 AND 80),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        principal_id TEXT NOT NULL, authority_domain TEXT NOT NULL,
        verdict TEXT NOT NULL CHECK(verdict IN ('PASS','FAIL')),
        subject_sha TEXT NOT NULL CHECK(length(subject_sha)=40 AND subject_sha NOT GLOB '*[^0-9a-f]*'),
        base_sha TEXT NOT NULL CHECK(length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*'),
        result_sha TEXT NOT NULL CHECK(length(result_sha)=40 AND result_sha NOT GLOB '*[^0-9a-f]*'),
        evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
        cleanup_evidence_sha256 TEXT NOT NULL CHECK(length(cleanup_evidence_sha256)=64 AND cleanup_evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
        cgroup_empty INTEGER NOT NULL CHECK(cgroup_empty=1),
        identity_receipt_sha256 TEXT NOT NULL REFERENCES identity_registry(identity_receipt_sha256),
        account_binding_sha256 TEXT NOT NULL CHECK(length(account_binding_sha256)=64 AND account_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
        task_spec_sha256 TEXT NOT NULL CHECK(length(task_spec_sha256)=64 AND task_spec_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_sha256 TEXT NOT NULL CHECK(length(instruction_sha256)=64 AND instruction_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_bytes INTEGER NOT NULL CHECK(instruction_bytes BETWEEN 1 AND 1048576),
        instruction_materialization_sha256 TEXT NOT NULL
            CHECK(length(instruction_materialization_sha256)=64 AND instruction_materialization_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_materialization_bytes INTEGER NOT NULL
            CHECK(instruction_materialization_bytes BETWEEN 1 AND 1048576),
        instruction_transport_sha256 TEXT NOT NULL
            CHECK(length(instruction_transport_sha256)=64 AND instruction_transport_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_transport_bytes INTEGER NOT NULL
            CHECK(instruction_transport_bytes BETWEEN 1 AND 1048576),
        unit_identity_sha256 TEXT NOT NULL CHECK(length(unit_identity_sha256)=64 AND unit_identity_sha256 NOT GLOB '*[^0-9a-f]*'),
        cpu_usage_ns INTEGER NOT NULL CHECK(cpu_usage_ns BETWEEN 0 AND 9223372036854775807),
        memory_peak_bytes INTEGER NOT NULL CHECK(memory_peak_bytes BETWEEN 0 AND 9223372036854775807),
        tasks_peak INTEGER NOT NULL CHECK(tasks_peak BETWEEN 0 AND 1000000),
        oom_count INTEGER NOT NULL CHECK(oom_count BETWEEN 0 AND 2147483647),
        oom_killed INTEGER NOT NULL CHECK(oom_killed IN (0,1)),
        systemd_service_result TEXT NOT NULL CHECK(systemd_service_result IN
            ('success','exit-code','signal','core-dump','watchdog','start-limit-hit',
             'resources','timeout','oom-kill','protocol')),
        systemd_exec_code INTEGER NOT NULL CHECK(systemd_exec_code IN (1,2,3)),
        systemd_exec_status INTEGER NOT NULL CHECK(systemd_exec_status BETWEEN 0 AND 255),
        resource_outcome_sha256 TEXT NOT NULL
            CHECK(length(resource_outcome_sha256)=64 AND resource_outcome_sha256 NOT GLOB '*[^0-9a-f]*'),
        lease_resource TEXT NOT NULL, lease_token INTEGER NOT NULL CHECK(lease_token>0),
        run_id TEXT NOT NULL CHECK(length(run_id)=64 AND run_id NOT GLOB '*[^0-9a-f]*'),
        binding_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>0),
        task_version_before INTEGER NOT NULL CHECK(task_version_before>0),
        task_version_after INTEGER NOT NULL CHECK(task_version_after=task_version_before+1),
        event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        authoritative INTEGER NOT NULL CHECK(authoritative=1), created_at REAL NOT NULL,
        CHECK(instruction_materialization_sha256=instruction_sha256
              AND instruction_materialization_bytes=instruction_bytes),
        CHECK(instruction_transport_sha256=instruction_sha256
              AND instruction_transport_bytes=instruction_bytes),
        CHECK(oom_killed=0 OR oom_count>0),
        UNIQUE(task_id,task_attempt,phase,role),
        FOREIGN KEY(attempt_id,task_id,task_attempt,role,execution_generation)
            REFERENCES phase_attempts(attempt_id,task_id,task_attempt,role,execution_generation),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    principal_id,authority_domain,binding_id,lease_resource,
                    lease_token,run_id,epoch)
            REFERENCES phase_attempts(attempt_id,task_id,task_attempt,
                                     execution_generation,role,principal_id,
                                     authority_domain,binding_id,lease_resource,
                                     lease_token,run_id,epoch),
        FOREIGN KEY(binding_id,principal_id,authority_domain,
                    account_binding_sha256,identity_receipt_sha256)
            REFERENCES consumed_authority_bindings(binding_id,principal_id,
                                                    authority_domain,
                                                    account_binding_sha256,
                                                    identity_receipt_sha256),
        FOREIGN KEY(attempt_id,task_spec_sha256,instruction_sha256,instruction_bytes)
            REFERENCES task_specs(attempt_id,task_spec_sha256,
                                  instruction_sha256,instruction_bytes),
        FOREIGN KEY(identity_receipt_sha256,account_binding_sha256)
            REFERENCES identity_registry(identity_receipt_sha256,
                                         account_binding_sha256),
        FOREIGN KEY(attempt_id,unit_identity_sha256,instruction_sha256,
                    instruction_bytes,instruction_materialization_sha256,
                    instruction_materialization_bytes,
                    instruction_transport_sha256,instruction_transport_bytes,
                    cpu_usage_ns,memory_peak_bytes,tasks_peak,oom_count,oom_killed,
                    systemd_service_result,systemd_exec_code,systemd_exec_status,
                    resource_outcome_sha256)
            REFERENCES attempt_units(
                attempt_id,observed_unit_sha256,instruction_sha256,
                instruction_bytes,instruction_materialization_sha256,
                instruction_materialization_bytes,
                instruction_transport_sha256,instruction_transport_bytes,
                cpu_usage_ns,memory_peak_bytes,tasks_peak,oom_count,oom_killed,
                systemd_service_result,systemd_exec_code,systemd_exec_status,
                resource_outcome_sha256)
    )""",
    """CREATE TABLE merge_claims(
        resource TEXT PRIMARY KEY CHECK(resource='merge/global'),
        token INTEGER NOT NULL CHECK(token>=0), task_id TEXT REFERENCES tasks(id),
        attempt INTEGER CHECK(attempt IS NULL OR attempt>0),
        subject_sha TEXT CHECK(subject_sha IS NULL OR (length(subject_sha)=40 AND subject_sha NOT GLOB '*[^0-9a-f]*')),
        base_sha TEXT CHECK(base_sha IS NULL OR (length(base_sha)=40 AND base_sha NOT GLOB '*[^0-9a-f]*')),
        pr_number INTEGER CHECK(pr_number IS NULL OR pr_number>0),
        merge_operation_id TEXT CHECK(merge_operation_id IS NULL OR (length(merge_operation_id)=64 AND merge_operation_id NOT GLOB '*[^0-9a-f]*')),
        grant_generation INTEGER CHECK(grant_generation IS NULL OR grant_generation>0), status TEXT NOT NULL
            CHECK(status IN ('HELD','RECOVERY_REQUIRED')),
        epoch INTEGER NOT NULL CHECK(epoch>0),
        linked_remediation_task_id TEXT REFERENCES tasks(id), updated_at REAL NOT NULL,
        CHECK(
            (status='HELD' AND task_id IS NOT NULL AND attempt IS NOT NULL
             AND subject_sha IS NOT NULL AND base_sha IS NOT NULL
             AND pr_number IS NOT NULL AND merge_operation_id IS NOT NULL
             AND grant_generation IS NOT NULL AND token>0)
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
        CHECK(linked_remediation_task_id IS NULL OR linked_remediation_task_id<>task_id),
        FOREIGN KEY(merge_operation_id,task_id,attempt,grant_generation)
            REFERENCES merge_operations(merge_operation_id,task_id,attempt,grant_generation)
    )""",
    """CREATE TABLE merge_recovery_tasks(
        resource TEXT NOT NULL CHECK(resource='merge/global'),
        task_id TEXT NOT NULL REFERENCES tasks(id), prior_state TEXT NOT NULL
            CHECK(prior_state IN ('INTEGRATING','MERGED','POST_MERGE_VERIFYING')),
        PRIMARY KEY(resource,task_id),
        FOREIGN KEY(resource) REFERENCES merge_claims(resource)
    )""",
    """CREATE TABLE merge_operations(
        merge_operation_id TEXT PRIMARY KEY
            CHECK(length(merge_operation_id)=64 AND merge_operation_id NOT GLOB '*[^0-9a-f]*'),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        attempt INTEGER NOT NULL CHECK(attempt>0),
        grant_generation INTEGER NOT NULL CHECK(grant_generation>0),
        parent_merge_operation_id TEXT REFERENCES merge_operations(merge_operation_id)
            CHECK(parent_merge_operation_id IS NULL OR parent_merge_operation_id<>merge_operation_id),
        request_state TEXT NOT NULL
            CHECK(request_state IN ('PREPARED','SENT','CONFIRMED','UNCERTAIN','ABORTED')),
        grant_sha256 TEXT NOT NULL
            CHECK(length(grant_sha256)=64 AND grant_sha256 NOT GLOB '*[^0-9a-f]*'),
        request_sha256 TEXT
            CHECK(request_sha256 IS NULL OR (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^0-9a-f]*')),
        response_sha256 TEXT
            CHECK(response_sha256 IS NULL OR (length(response_sha256)=64 AND response_sha256 NOT GLOB '*[^0-9a-f]*')),
        epoch INTEGER NOT NULL CHECK(epoch>0), updated_at REAL NOT NULL,
        CHECK((request_state='PREPARED' AND request_sha256 IS NULL AND response_sha256 IS NULL)
              OR (request_state IN ('SENT','UNCERTAIN') AND request_sha256 IS NOT NULL)
              OR (request_state='CONFIRMED' AND request_sha256 IS NOT NULL AND response_sha256 IS NOT NULL)
              OR request_state='ABORTED'),
        UNIQUE(task_id,attempt,grant_generation),
        UNIQUE(merge_operation_id,task_id,attempt,grant_generation)
    )""",
    """CREATE TABLE task_specs(
        attempt_id TEXT PRIMARY KEY REFERENCES phase_attempts(attempt_id),
        task_id TEXT NOT NULL REFERENCES tasks(id), task_attempt INTEGER NOT NULL CHECK(task_attempt>0),
        execution_generation INTEGER NOT NULL CHECK(execution_generation>0),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        schema_version INTEGER CHECK(schema_version IS NULL OR schema_version=2),
        task_spec_sha256 TEXT UNIQUE CHECK(task_spec_sha256 IS NULL OR (length(task_spec_sha256)=64 AND task_spec_sha256 NOT GLOB '*[^0-9a-f]*')),
        canonical_json TEXT CHECK(canonical_json IS NULL OR (
            length(CAST(canonical_json AS BLOB)) BETWEEN 2 AND 65536
            AND json_valid(canonical_json) AND json_type(canonical_json)='object')),
        instruction_sha256 TEXT CHECK(instruction_sha256 IS NULL OR (length(instruction_sha256)=64 AND instruction_sha256 NOT GLOB '*[^0-9a-f]*')),
        instruction_bytes INTEGER CHECK(instruction_bytes IS NULL OR instruction_bytes BETWEEN 1 AND 1048576),
        signing_key_id TEXT CHECK(signing_key_id IS NULL OR (length(signing_key_id) BETWEEN 1 AND 80 AND signing_key_id NOT GLOB '*[^A-Za-z0-9._-]*')),
        signature_sha256 TEXT
            CHECK(signature_sha256 IS NULL OR (length(signature_sha256)=64 AND signature_sha256 NOT GLOB '*[^0-9a-f]*')),
        controller_epoch INTEGER NOT NULL CHECK(controller_epoch>0),
        expires_at REAL CHECK(expires_at IS NULL OR expires_at>0),
        attached_event_seq INTEGER UNIQUE REFERENCES events(seq),
        CHECK(
            (task_spec_sha256 IS NULL AND schema_version IS NULL AND canonical_json IS NULL
             AND instruction_sha256 IS NULL AND instruction_bytes IS NULL
             AND signing_key_id IS NULL AND signature_sha256 IS NULL
             AND expires_at IS NULL AND attached_event_seq IS NULL)
            OR
            (task_spec_sha256 IS NOT NULL AND schema_version=2 AND canonical_json IS NOT NULL
             AND instruction_sha256 IS NOT NULL AND instruction_bytes IS NOT NULL
             AND signing_key_id IS NOT NULL AND signature_sha256 IS NOT NULL
             AND expires_at IS NOT NULL AND attached_event_seq IS NOT NULL)
        ),
        UNIQUE(attempt_id,task_spec_sha256),
        UNIQUE(attempt_id,task_spec_sha256,instruction_sha256,instruction_bytes),
        UNIQUE(attempt_id,task_id,task_attempt,execution_generation,role,
               task_spec_sha256),
        UNIQUE(attempt_id,task_id,task_attempt,execution_generation,role,
               task_spec_sha256,instruction_sha256,instruction_bytes),
        FOREIGN KEY(attempt_id,task_id,task_attempt,role,execution_generation)
            REFERENCES phase_attempts(attempt_id,task_id,task_attempt,role,execution_generation)
    )""",
    """CREATE TABLE attempt_workspaces(
        attempt_id TEXT PRIMARY KEY REFERENCES phase_attempts(attempt_id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        task_attempt INTEGER NOT NULL CHECK(task_attempt>0),
        execution_generation INTEGER NOT NULL CHECK(execution_generation>0),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        task_spec_sha256 TEXT NOT NULL
            CHECK(length(task_spec_sha256)=64 AND task_spec_sha256 NOT GLOB '*[^0-9a-f]*'),
        subject_sha TEXT NOT NULL
            CHECK(length(subject_sha)=40 AND subject_sha NOT GLOB '*[^0-9a-f]*'),
        tree_sha256 TEXT NOT NULL
            CHECK(length(tree_sha256)=64 AND tree_sha256 NOT GLOB '*[^0-9a-f]*'),
        inventory_sha256 TEXT NOT NULL
            CHECK(length(inventory_sha256)=64 AND inventory_sha256 NOT GLOB '*[^0-9a-f]*'),
        file_count INTEGER NOT NULL CHECK(file_count BETWEEN 0 AND 100000),
        total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 0 AND 1099511627776),
        prepared_event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        UNIQUE(attempt_id,task_id,task_attempt,execution_generation,role,
               task_spec_sha256,subject_sha,tree_sha256,inventory_sha256),
        FOREIGN KEY(attempt_id,task_id,task_attempt,role,execution_generation)
            REFERENCES phase_attempts(attempt_id,task_id,task_attempt,role,execution_generation),
        FOREIGN KEY(attempt_id,task_spec_sha256)
            REFERENCES task_specs(attempt_id,task_spec_sha256)
    )""",
    """CREATE TABLE attempt_homes(
        attempt_id TEXT PRIMARY KEY REFERENCES phase_attempts(attempt_id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        task_attempt INTEGER NOT NULL CHECK(task_attempt>0),
        execution_generation INTEGER NOT NULL CHECK(execution_generation>0),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        binding_id TEXT NOT NULL
            CHECK(length(binding_id)=64 AND binding_id NOT GLOB '*[^0-9a-f]*'),
        principal_id TEXT NOT NULL
            CHECK(length(principal_id) BETWEEN 1 AND 80 AND principal_id NOT GLOB '*[^A-Za-z0-9._-]*'),
        authority_domain TEXT NOT NULL
            CHECK(length(authority_domain) BETWEEN 1 AND 80 AND authority_domain NOT GLOB '*[^A-Za-z0-9._-]*'),
        account_binding_sha256 TEXT NOT NULL
            CHECK(length(account_binding_sha256)=64 AND account_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
        identity_receipt_sha256 TEXT NOT NULL
            CHECK(length(identity_receipt_sha256)=64 AND identity_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
        manifest_sha256 TEXT NOT NULL
            CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
        task_spec_sha256 TEXT NOT NULL
            CHECK(length(task_spec_sha256)=64 AND task_spec_sha256 NOT GLOB '*[^0-9a-f]*'),
        materialization_attestation_sha256 TEXT NOT NULL
            CHECK(length(materialization_attestation_sha256)=64 AND materialization_attestation_sha256 NOT GLOB '*[^0-9a-f]*'),
        artifact_count INTEGER NOT NULL CHECK(artifact_count BETWEEN 0 AND 4096),
        total_bytes INTEGER NOT NULL CHECK(total_bytes BETWEEN 0 AND 1073741824),
        prepared_event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        UNIQUE(attempt_id,task_id,task_attempt,execution_generation,role,
               binding_id,principal_id,authority_domain,account_binding_sha256,
               identity_receipt_sha256,manifest_sha256,task_spec_sha256,
               materialization_attestation_sha256),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    binding_id,principal_id,authority_domain)
            REFERENCES phase_attempts(attempt_id,task_id,task_attempt,
                                      execution_generation,role,binding_id,
                                      principal_id,authority_domain),
        FOREIGN KEY(binding_id,task_id,task_attempt,execution_generation,role,
                    principal_id,authority_domain,account_binding_sha256,
                    identity_receipt_sha256,manifest_sha256)
            REFERENCES consumed_authority_bindings(
                binding_id,task_id,task_attempt,execution_generation,role,
                principal_id,authority_domain,account_binding_sha256,
                identity_receipt_sha256,manifest_sha256),
        FOREIGN KEY(identity_receipt_sha256,manifest_sha256,principal_id,
                    authority_domain,account_binding_sha256)
            REFERENCES identity_registry(identity_receipt_sha256,manifest_sha256,
                                         principal_id,authority_domain,
                                         account_binding_sha256),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    task_spec_sha256)
            REFERENCES task_specs(attempt_id,task_id,task_attempt,
                                  execution_generation,role,task_spec_sha256)
    )""",
    """CREATE TABLE attempt_inputs(
        attempt_id TEXT PRIMARY KEY REFERENCES phase_attempts(attempt_id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        task_attempt INTEGER NOT NULL CHECK(task_attempt>0),
        execution_generation INTEGER NOT NULL CHECK(execution_generation>0),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        binding_id TEXT NOT NULL
            CHECK(length(binding_id)=64 AND binding_id NOT GLOB '*[^0-9a-f]*'),
        principal_id TEXT NOT NULL
            CHECK(length(principal_id) BETWEEN 1 AND 80 AND principal_id NOT GLOB '*[^A-Za-z0-9._-]*'),
        authority_domain TEXT NOT NULL
            CHECK(length(authority_domain) BETWEEN 1 AND 80 AND authority_domain NOT GLOB '*[^A-Za-z0-9._-]*'),
        account_binding_sha256 TEXT NOT NULL
            CHECK(length(account_binding_sha256)=64 AND account_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
        identity_receipt_sha256 TEXT NOT NULL
            CHECK(length(identity_receipt_sha256)=64 AND identity_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
        manifest_sha256 TEXT NOT NULL
            CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
        task_spec_sha256 TEXT NOT NULL
            CHECK(length(task_spec_sha256)=64 AND task_spec_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_sha256 TEXT NOT NULL
            CHECK(length(instruction_sha256)=64 AND instruction_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_bytes INTEGER NOT NULL CHECK(instruction_bytes BETWEEN 1 AND 1048576),
        materialization_attestation_sha256 TEXT NOT NULL
            CHECK(length(materialization_attestation_sha256)=64 AND materialization_attestation_sha256 NOT GLOB '*[^0-9a-f]*'),
        prepared_event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        UNIQUE(attempt_id,task_id,task_attempt,execution_generation,role,
               binding_id,principal_id,authority_domain,account_binding_sha256,
               identity_receipt_sha256,manifest_sha256,task_spec_sha256,
               instruction_sha256,instruction_bytes,
               materialization_attestation_sha256),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    binding_id,principal_id,authority_domain)
            REFERENCES phase_attempts(attempt_id,task_id,task_attempt,
                                      execution_generation,role,binding_id,
                                      principal_id,authority_domain),
        FOREIGN KEY(binding_id,task_id,task_attempt,execution_generation,role,
                    principal_id,authority_domain,account_binding_sha256,
                    identity_receipt_sha256,manifest_sha256)
            REFERENCES consumed_authority_bindings(
                binding_id,task_id,task_attempt,execution_generation,role,
                principal_id,authority_domain,account_binding_sha256,
                identity_receipt_sha256,manifest_sha256),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    task_spec_sha256,instruction_sha256,instruction_bytes)
            REFERENCES task_specs(attempt_id,task_id,task_attempt,
                                  execution_generation,role,task_spec_sha256,
                                  instruction_sha256,instruction_bytes)
    )""",
    """CREATE TABLE attempt_units(
        attempt_id TEXT PRIMARY KEY REFERENCES phase_attempts(attempt_id),
        task_id TEXT NOT NULL REFERENCES tasks(id),
        task_attempt INTEGER NOT NULL CHECK(task_attempt>0),
        execution_generation INTEGER NOT NULL CHECK(execution_generation>0),
        role TEXT NOT NULL CHECK(role IN ('builder','verifier','spec-reviewer','regression-reviewer','independent-reviewer','integrator','post-merge-verifier')),
        binding_id TEXT NOT NULL
            CHECK(length(binding_id)=64 AND binding_id NOT GLOB '*[^0-9a-f]*'),
        principal_id TEXT NOT NULL
            CHECK(length(principal_id) BETWEEN 1 AND 80 AND principal_id NOT GLOB '*[^A-Za-z0-9._-]*'),
        authority_domain TEXT NOT NULL
            CHECK(length(authority_domain) BETWEEN 1 AND 80 AND authority_domain NOT GLOB '*[^A-Za-z0-9._-]*'),
        account_binding_sha256 TEXT NOT NULL
            CHECK(length(account_binding_sha256)=64 AND account_binding_sha256 NOT GLOB '*[^0-9a-f]*'),
        identity_receipt_sha256 TEXT NOT NULL
            CHECK(length(identity_receipt_sha256)=64 AND identity_receipt_sha256 NOT GLOB '*[^0-9a-f]*'),
        manifest_sha256 TEXT NOT NULL
            CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
        task_spec_sha256 TEXT NOT NULL
            CHECK(length(task_spec_sha256)=64 AND task_spec_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_sha256 TEXT NOT NULL
            CHECK(length(instruction_sha256)=64 AND instruction_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_bytes INTEGER NOT NULL CHECK(instruction_bytes BETWEEN 1 AND 1048576),
        workspace_subject_sha TEXT NOT NULL
            CHECK(length(workspace_subject_sha)=40 AND workspace_subject_sha NOT GLOB '*[^0-9a-f]*'),
        workspace_tree_sha256 TEXT NOT NULL
            CHECK(length(workspace_tree_sha256)=64 AND workspace_tree_sha256 NOT GLOB '*[^0-9a-f]*'),
        workspace_inventory_sha256 TEXT NOT NULL
            CHECK(length(workspace_inventory_sha256)=64 AND workspace_inventory_sha256 NOT GLOB '*[^0-9a-f]*'),
        home_materialization_attestation_sha256 TEXT NOT NULL
            CHECK(length(home_materialization_attestation_sha256)=64 AND home_materialization_attestation_sha256 NOT GLOB '*[^0-9a-f]*'),
        input_materialization_attestation_sha256 TEXT NOT NULL
            CHECK(length(input_materialization_attestation_sha256)=64 AND input_materialization_attestation_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_materialization_sha256 TEXT NOT NULL
            CHECK(length(instruction_materialization_sha256)=64 AND instruction_materialization_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_materialization_bytes INTEGER NOT NULL
            CHECK(instruction_materialization_bytes BETWEEN 1 AND 1048576),
        instruction_transport_sha256 TEXT NOT NULL
            CHECK(length(instruction_transport_sha256)=64 AND instruction_transport_sha256 NOT GLOB '*[^0-9a-f]*'),
        instruction_transport_bytes INTEGER NOT NULL
            CHECK(instruction_transport_bytes BETWEEN 1 AND 1048576),
        unit_name TEXT NOT NULL UNIQUE CHECK(length(unit_name) BETWEEN 1 AND 200),
        state TEXT NOT NULL CHECK(state IN ('PREPARED','RUNNING','STOPPING','STOPPED','RECOVERY_REQUIRED')),
        recovery_from TEXT CHECK(recovery_from IS NULL OR recovery_from IN ('PREPARED','RUNNING','STOPPING')),
        launch_intent_sha256 TEXT NOT NULL CHECK(length(launch_intent_sha256)=64 AND launch_intent_sha256 NOT GLOB '*[^0-9a-f]*'),
        argv_sha256 TEXT NOT NULL CHECK(length(argv_sha256)=64 AND argv_sha256 NOT GLOB '*[^0-9a-f]*'),
        bwrap_sha256 TEXT NOT NULL CHECK(length(bwrap_sha256)=64 AND bwrap_sha256 NOT GLOB '*[^0-9a-f]*'),
        executable_sha256 TEXT NOT NULL CHECK(length(executable_sha256)=64 AND executable_sha256 NOT GLOB '*[^0-9a-f]*'),
        requested_properties_sha256 TEXT NOT NULL CHECK(length(requested_properties_sha256)=64 AND requested_properties_sha256 NOT GLOB '*[^0-9a-f]*'),
        observed_unit_sha256 TEXT CHECK(observed_unit_sha256 IS NULL OR (length(observed_unit_sha256)=64 AND observed_unit_sha256 NOT GLOB '*[^0-9a-f]*')),
        effective_properties_sha256 TEXT CHECK(effective_properties_sha256 IS NULL OR (length(effective_properties_sha256)=64 AND effective_properties_sha256 NOT GLOB '*[^0-9a-f]*')),
        main_pid INTEGER CHECK(main_pid IS NULL OR main_pid>0),
        cgroup_identity_sha256 TEXT CHECK(cgroup_identity_sha256 IS NULL OR (length(cgroup_identity_sha256)=64 AND cgroup_identity_sha256 NOT GLOB '*[^0-9a-f]*')),
        exit_outcome TEXT CHECK(exit_outcome IS NULL OR exit_outcome IN ('EXITED','SIGNALED','TIMEOUT','CANCELLED','LAUNCH_FAILED')),
        exit_code INTEGER CHECK(exit_code IS NULL OR exit_code BETWEEN 0 AND 255),
        stdout_observed_sha256 TEXT CHECK(stdout_observed_sha256 IS NULL OR (length(stdout_observed_sha256)=64 AND stdout_observed_sha256 NOT GLOB '*[^0-9a-f]*')),
        stdout_observed_bytes INTEGER CHECK(stdout_observed_bytes IS NULL OR stdout_observed_bytes BETWEEN 0 AND 1073741824),
        stdout_retained_sha256 TEXT CHECK(stdout_retained_sha256 IS NULL OR (length(stdout_retained_sha256)=64 AND stdout_retained_sha256 NOT GLOB '*[^0-9a-f]*')),
        stdout_retained_bytes INTEGER CHECK(stdout_retained_bytes IS NULL OR stdout_retained_bytes BETWEEN 0 AND 1073741824),
        stdout_eof INTEGER NOT NULL DEFAULT 0 CHECK(stdout_eof IN (0,1)),
        stderr_observed_sha256 TEXT CHECK(stderr_observed_sha256 IS NULL OR (length(stderr_observed_sha256)=64 AND stderr_observed_sha256 NOT GLOB '*[^0-9a-f]*')),
        stderr_observed_bytes INTEGER CHECK(stderr_observed_bytes IS NULL OR stderr_observed_bytes BETWEEN 0 AND 1073741824),
        stderr_retained_sha256 TEXT CHECK(stderr_retained_sha256 IS NULL OR (length(stderr_retained_sha256)=64 AND stderr_retained_sha256 NOT GLOB '*[^0-9a-f]*')),
        stderr_retained_bytes INTEGER CHECK(stderr_retained_bytes IS NULL OR stderr_retained_bytes BETWEEN 0 AND 1073741824),
        stderr_eof INTEGER NOT NULL DEFAULT 0 CHECK(stderr_eof IN (0,1)),
        output_overflow INTEGER NOT NULL DEFAULT 0 CHECK(output_overflow IN (0,1)),
        timed_out INTEGER NOT NULL DEFAULT 0 CHECK(timed_out IN (0,1)),
        cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
        drain_limit_hit INTEGER NOT NULL DEFAULT 0 CHECK(drain_limit_hit IN (0,1)),
        raw_evidence_status TEXT NOT NULL DEFAULT 'NONE'
            CHECK(raw_evidence_status IN ('NONE','COMMITTED','QUARANTINED')),
        stop_callback_status TEXT NOT NULL DEFAULT 'NOT_REQUIRED'
            CHECK(stop_callback_status IN ('NOT_REQUIRED','SUCCEEDED','FAILED','TIMED_OUT')),
        recovery_required INTEGER NOT NULL DEFAULT 0 CHECK(recovery_required IN (0,1)),
        cgroup_empty INTEGER CHECK(cgroup_empty IN (0,1)),
        cpu_usage_ns INTEGER CHECK(cpu_usage_ns IS NULL OR cpu_usage_ns BETWEEN 0 AND 9223372036854775807),
        memory_peak_bytes INTEGER CHECK(memory_peak_bytes IS NULL OR memory_peak_bytes BETWEEN 0 AND 9223372036854775807),
        tasks_peak INTEGER CHECK(tasks_peak IS NULL OR tasks_peak BETWEEN 0 AND 1000000),
        oom_count INTEGER CHECK(oom_count IS NULL OR oom_count BETWEEN 0 AND 2147483647),
        oom_killed INTEGER CHECK(oom_killed IS NULL OR oom_killed IN (0,1)),
        systemd_service_result TEXT CHECK(systemd_service_result IS NULL OR systemd_service_result IN
            ('success','exit-code','signal','core-dump','watchdog','start-limit-hit',
             'resources','timeout','oom-kill','protocol')),
        systemd_exec_code INTEGER CHECK(systemd_exec_code IS NULL OR systemd_exec_code IN (1,2,3)),
        systemd_exec_status INTEGER CHECK(systemd_exec_status IS NULL OR systemd_exec_status BETWEEN 0 AND 255),
        resource_outcome_sha256 TEXT CHECK(resource_outcome_sha256 IS NULL OR
            (length(resource_outcome_sha256)=64 AND resource_outcome_sha256 NOT GLOB '*[^0-9a-f]*')),
        version INTEGER NOT NULL CHECK(version>0),
        created_event_seq INTEGER NOT NULL UNIQUE REFERENCES events(seq),
        updated_event_seq INTEGER NOT NULL REFERENCES events(seq),
        UNIQUE(attempt_id,observed_unit_sha256,instruction_sha256,
               instruction_bytes,instruction_materialization_sha256,
               instruction_materialization_bytes,
               instruction_transport_sha256,instruction_transport_bytes,
               cpu_usage_ns,memory_peak_bytes,tasks_peak,oom_count,oom_killed,
               systemd_service_result,systemd_exec_code,systemd_exec_status,
               resource_outcome_sha256),
        CHECK((state='RECOVERY_REQUIRED')=(recovery_from IS NOT NULL)),
        CHECK((state='RECOVERY_REQUIRED')=recovery_required),
        CHECK(instruction_materialization_sha256=instruction_sha256
              AND instruction_materialization_bytes=instruction_bytes),
        CHECK(instruction_transport_sha256=instruction_sha256
              AND instruction_transport_bytes=instruction_bytes),
        CHECK(stdout_retained_bytes IS NULL OR stdout_observed_bytes IS NOT NULL),
        CHECK(stderr_retained_bytes IS NULL OR stderr_observed_bytes IS NOT NULL),
        CHECK(stdout_retained_bytes IS NULL OR stdout_retained_bytes<=stdout_observed_bytes),
        CHECK(stderr_retained_bytes IS NULL OR stderr_retained_bytes<=stderr_observed_bytes),
        CHECK(output_overflow=(coalesce(stdout_retained_bytes<stdout_observed_bytes,0)
              OR coalesce(stderr_retained_bytes<stderr_observed_bytes,0))),
        CHECK(timed_out=0 OR exit_outcome='TIMEOUT'),
        CHECK(cancelled=0 OR exit_outcome='CANCELLED'),
        CHECK(raw_evidence_status<>'COMMITTED' OR (
              stdout_eof=1 AND stderr_eof=1 AND timed_out=0
              AND cancelled=0 AND drain_limit_hit=0)),
        CHECK(stop_callback_status NOT IN ('FAILED','TIMED_OUT') OR recovery_required=1),
        CHECK((exit_outcome='EXITED' AND exit_code IS NOT NULL)
              OR (exit_outcome IS NULL AND exit_code IS NULL)
              OR (exit_outcome<>'EXITED' AND exit_code IS NULL)),
        CHECK(oom_killed IS NULL OR oom_killed=0 OR oom_count>0),
        CHECK(
            (resource_outcome_sha256 IS NULL AND cpu_usage_ns IS NULL
             AND memory_peak_bytes IS NULL AND tasks_peak IS NULL
             AND oom_count IS NULL AND oom_killed IS NULL
             AND systemd_service_result IS NULL AND systemd_exec_code IS NULL
             AND systemd_exec_status IS NULL)
            OR
            (resource_outcome_sha256 IS NOT NULL AND cpu_usage_ns IS NOT NULL
             AND memory_peak_bytes IS NOT NULL AND tasks_peak IS NOT NULL
             AND oom_count IS NOT NULL AND oom_killed IS NOT NULL
             AND systemd_service_result IS NOT NULL AND systemd_exec_code IS NOT NULL
             AND systemd_exec_status IS NOT NULL)
        ),
        CHECK(state='STOPPED' OR (
            exit_outcome IS NULL AND exit_code IS NULL
            AND (cgroup_empty IS NULL OR cgroup_empty=0)
            AND raw_evidence_status<>'COMMITTED'
            AND resource_outcome_sha256 IS NULL AND cpu_usage_ns IS NULL
            AND memory_peak_bytes IS NULL AND tasks_peak IS NULL
            AND oom_count IS NULL AND oom_killed IS NULL
            AND systemd_service_result IS NULL AND systemd_exec_code IS NULL
            AND systemd_exec_status IS NULL)),
        CHECK(state<>'STOPPED' OR (observed_unit_sha256 IS NOT NULL
            AND effective_properties_sha256 IS NOT NULL
            AND main_pid IS NOT NULL AND cgroup_identity_sha256 IS NOT NULL
            AND exit_outcome IS NOT NULL
            AND stdout_observed_sha256 IS NOT NULL AND stderr_observed_sha256 IS NOT NULL
            AND stdout_retained_sha256 IS NOT NULL AND stderr_retained_sha256 IS NOT NULL
            AND stdout_observed_bytes IS NOT NULL AND stderr_observed_bytes IS NOT NULL
            AND stdout_retained_bytes IS NOT NULL AND stderr_retained_bytes IS NOT NULL
            AND (stdout_eof=1 OR drain_limit_hit=1)
            AND (stderr_eof=1 OR drain_limit_hit=1)
            AND raw_evidence_status IN ('COMMITTED','QUARANTINED')
            AND stop_callback_status IN ('NOT_REQUIRED','SUCCEEDED')
            AND recovery_required=0 AND cgroup_empty=1
            AND resource_outcome_sha256 IS NOT NULL)),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    binding_id,principal_id,authority_domain)
            REFERENCES phase_attempts(attempt_id,task_id,task_attempt,
                                      execution_generation,role,binding_id,
                                      principal_id,authority_domain),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    task_spec_sha256,instruction_sha256,instruction_bytes)
            REFERENCES task_specs(attempt_id,task_id,task_attempt,
                                  execution_generation,role,task_spec_sha256,
                                  instruction_sha256,instruction_bytes),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    task_spec_sha256,workspace_subject_sha,workspace_tree_sha256,
                    workspace_inventory_sha256)
            REFERENCES attempt_workspaces(
                attempt_id,task_id,task_attempt,execution_generation,role,
                task_spec_sha256,subject_sha,tree_sha256,inventory_sha256),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    binding_id,principal_id,authority_domain,account_binding_sha256,
                    identity_receipt_sha256,manifest_sha256,task_spec_sha256,
                    home_materialization_attestation_sha256)
            REFERENCES attempt_homes(
                attempt_id,task_id,task_attempt,execution_generation,role,
                binding_id,principal_id,authority_domain,account_binding_sha256,
                identity_receipt_sha256,manifest_sha256,task_spec_sha256,
                materialization_attestation_sha256),
        FOREIGN KEY(attempt_id,task_id,task_attempt,execution_generation,role,
                    binding_id,principal_id,authority_domain,account_binding_sha256,
                    identity_receipt_sha256,manifest_sha256,task_spec_sha256,
                    instruction_sha256,instruction_bytes,
                    input_materialization_attestation_sha256)
            REFERENCES attempt_inputs(
                attempt_id,task_id,task_attempt,execution_generation,role,
                binding_id,principal_id,authority_domain,account_binding_sha256,
                identity_receipt_sha256,manifest_sha256,task_spec_sha256,
                instruction_sha256,instruction_bytes,
                materialization_attestation_sha256)
    )""",
    """CREATE TABLE runtime_append_intent(
        singleton INTEGER PRIMARY KEY CHECK(singleton=1),
        state TEXT NOT NULL CHECK(state='PREPARED'),
        event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 100),
        event_seq INTEGER NOT NULL CHECK(event_seq>0),
        event_hash TEXT NOT NULL CHECK(length(event_hash)=64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
        event_created_at REAL NOT NULL,
        event_bytes BLOB NOT NULL,
        event_bytes_sha256 TEXT NOT NULL CHECK(length(event_bytes_sha256)=64 AND event_bytes_sha256 NOT GLOB '*[^0-9a-f]*'),
        ledger_prefix_bytes INTEGER NOT NULL CHECK(ledger_prefix_bytes>=0),
        ledger_prefix_sha256 TEXT NOT NULL CHECK(length(ledger_prefix_sha256)=64 AND ledger_prefix_sha256 NOT GLOB '*[^0-9a-f]*'),
        ledger_prefix_tip_hash TEXT NOT NULL CHECK(length(ledger_prefix_tip_hash)=64 AND ledger_prefix_tip_hash NOT GLOB '*[^0-9a-f]*'),
        ledger_prefix_seq INTEGER NOT NULL CHECK(ledger_prefix_seq>=0),
        prepared_epoch INTEGER NOT NULL CHECK(prepared_epoch>0),
        CHECK(event_seq=ledger_prefix_seq+1)
    )""",
    """CREATE TABLE migration_dispositions(
        kind TEXT NOT NULL, object_id TEXT NOT NULL, prior_state TEXT,
        target_state TEXT, action TEXT NOT NULL,
        PRIMARY KEY(kind,object_id)
    )""",
)


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _require_hex(value: object, length: int, label: str) -> str:
    if (not isinstance(value, str) or len(value) != length
            or any(character not in "0123456789abcdef" for character in value)):
        raise DurableStoreError(f"invalid {label}")
    return value


def _require_integer(
    value: object, label: str, *, minimum: int = 1,
) -> int:
    if (isinstance(value, bool) or not isinstance(value, int)
            or value < minimum or value > 9223372036854775807):
        raise DurableStoreError(f"invalid {label}")
    return value


def _require_identifier(value: object, label: str) -> str:
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
    if (not isinstance(value, str) or not 1 <= len(value) <= 80
            or value[0] not in allowed[:-3]
            or any(character not in allowed for character in value)):
        raise DurableStoreError(f"invalid {label}")
    return value


def _require_role(role: object) -> str:
    if not isinstance(role, str) or role not in PHASE_ROLES:
        raise DurableStoreError("invalid phase role")
    return role


def _require_repository(repository: object) -> str:
    allowed = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/"
    if (not isinstance(repository, str) or not 3 <= len(repository) <= 200
            or repository.startswith("/") or repository.endswith("/")
            or repository.count("/") != 1 or ".." in repository
            or any(character not in allowed for character in repository)):
        raise DurableStoreError("invalid repository")
    return repository


def phase_claim_transition(role: str, current_state: str) -> str:
    """Return the sole worker claim edge for a role, or fail closed."""
    _require_role(role)
    expected = {
        "builder": ("READY", "LEASED"),
        "verifier": ("SUBMITTED", "VERIFYING"),
        "spec-reviewer": ("VERIFIED", "REVIEWING"),
        "regression-reviewer": ("VERIFIED", "REVIEWING"),
        "independent-reviewer": ("VERIFIED", "REVIEWING"),
        "integrator": ("REVIEWED", "INTEGRATING"),
        "post-merge-verifier": ("MERGED", "POST_MERGE_VERIFYING"),
    }[role]
    if current_state != expected[0]:
        raise DurableStoreError("task is not ready for requested phase role")
    return expected[1]


def phase_identity_reuse_allowed(existing_role: str, proposed_role: str) -> bool:
    """Whether two role lenses may share one attested identity dimension."""
    _require_role(existing_role)
    _require_role(proposed_role)
    return existing_role == proposed_role or {
        existing_role, proposed_role,
    } == {"verifier", "post-merge-verifier"}


def phase_result_transition(
    role: str, verdict: str, completed_review_roles: tuple[str, ...] = (),
) -> str:
    """Return the protocol result edge without performing any mutation."""
    _require_role(role)
    if verdict not in {"PASS", "FAIL"}:
        raise DurableStoreError("invalid phase verdict")
    if role == "integrator":
        raise DurableStoreError("integrator result requires the merge-specific protocol")
    if role == "builder" and verdict == "FAIL":
        raise DurableStoreError("builder FAIL requires a new-attempt failure protocol")
    if (not isinstance(completed_review_roles, tuple)
            or any(item not in REVIEW_ROLES for item in completed_review_roles)
            or len(completed_review_roles) != len(set(completed_review_roles))):
        raise DurableStoreError("invalid completed reviewer inventory")
    completed = set(completed_review_roles)
    if role not in REVIEW_ROLES and completed:
        raise DurableStoreError("reviewer inventory is not valid for this role")
    if verdict == "FAIL":
        if role == "post-merge-verifier":
            return "POST_MERGE_FAILED"
        return "CHANGES_REQUESTED"
    if role == "builder":
        return "SUBMITTED"
    if role == "verifier":
        return "VERIFIED"
    if role in REVIEW_ROLES:
        completed.add(role)
        return "REVIEWED" if completed == REVIEW_ROLES else "VERIFIED"
    if role == "post-merge-verifier":
        return "POST_MERGE_VERIFIED"
    raise DurableStoreError("unsupported result role")


def _identity_manifest_sha256(manifest: IdentityManifest) -> str:
    return _sha256(_canonical({
        "principal_id": manifest.principal_id,
        "authority_domain": manifest.authority_domain,
        "adapter": manifest.adapter,
        "generation": manifest.generation,
        "account_binding_sha256": manifest.account_binding_sha256,
        "executable_sha256": manifest.executable_sha256,
        "network_profile_sha256": manifest.network_profile_sha256,
        "artifacts": [
            (item.path, item.sha256, item.max_bytes) for item in manifest.artifacts
        ],
    }))


def _identity_receipt_sha256(receipt: IdentityReceipt) -> str:
    return _sha256(_canonical({
        "principal_id": receipt.principal_id,
        "authority_domain": receipt.authority_domain,
        "adapter": receipt.adapter,
        "generation": receipt.generation,
        "account_binding_sha256": receipt.account_binding_sha256,
        "executable_sha256": receipt.executable_sha256,
        "network_profile_sha256": receipt.network_profile_sha256,
        "checked_at": receipt.checked_at,
        "expires_at": receipt.expires_at,
        "auth_status": receipt.auth_status,
        "route_status": receipt.route_status,
    }))


def _identity_lineage_id(
    principal_id: str, authority_domain: str, account_binding_sha256: str,
) -> str:
    return _sha256(_canonical([
        "identity-lineage-v2", principal_id, authority_domain,
        account_binding_sha256,
    ]))


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _linux_process_identity() -> tuple[int, int]:
    """Return a fork-sensitive PID/start-time identity for this Linux process."""
    pid = os.getpid()
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open("/proc/self/stat", flags)
        try:
            raw = os.read(fd, 4096)
            if os.read(fd, 1):
                raise DurableStoreError("process identity record exceeds bound")
        finally:
            os.close(fd)
        closing = raw.rfind(b")")
        fields = raw[closing + 2:].split() if closing >= 0 else []
        # The suffix starts at procfs field 3; starttime is field 22.
        start_time = int(fields[19])
    except (OSError, ValueError, IndexError) as exc:
        raise DurableStoreError("Linux process identity is unavailable") from exc
    if start_time <= 0:
        raise DurableStoreError("Linux process identity is invalid")
    return pid, start_time


def _raw_event(previous: str, event_type: str, payload: object, created_at: object) -> str:
    return json.dumps(
        {"prev": previous, "type": event_type, "payload": payload, "created_at": created_at},
        sort_keys=True, separators=(",", ":"),
    )


def _parse_ledger(raw: bytes, *, allow_schema_v2: bool) -> list[dict]:
    if raw and not raw.endswith(b"\n"):
        raise DurableStoreError("ledger has an incomplete final event")
    events: list[dict] = []
    previous = GENESIS
    schema_seen = False
    for sequence, line in enumerate(raw.splitlines(), 1):
        if not line:
            raise DurableStoreError("ledger contains a blank event")
        try:
            event = json.loads(line.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DurableStoreError("ledger event is malformed") from exc
        if not isinstance(event, dict) or set(event) != {"prev", "hash", "type", "payload", "created_at"}:
            raise DurableStoreError("ledger event envelope is not recognized")
        event_type = event["type"]
        if (not isinstance(event_type, str) or not isinstance(event["prev"], str)
                or not isinstance(event["hash"], str) or not isinstance(event["payload"], dict)
                or isinstance(event["created_at"], bool)
                or not isinstance(event["created_at"], (int, float))
                or not math.isfinite(event["created_at"])):
            raise DurableStoreError("ledger event fields are not recognized")
        if (len(event["prev"]) != 64 or len(event["hash"]) != 64
                or any(character not in "0123456789abcdef" for character in event["prev"] + event["hash"])):
            raise DurableStoreError("ledger event digest fields are invalid")
        if event_type == "schema.v2":
            if not allow_schema_v2 or schema_seen:
                raise DurableStoreError("schema.v2 is duplicated or outside the v1 boundary")
            schema_seen = True
        elif schema_seen:
            if event_type not in V2_EVENT_APPLIERS:
                raise DurableStoreError("unknown v2 ledger event type")
        elif event_type not in V1_EVENT_TYPES:
            raise DurableStoreError("unknown ledger event type")
        if event["prev"] != previous:
            raise DurableStoreError("ledger hash chain is discontinuous")
        expected = _sha256(_raw_event(event["prev"], event_type, event["payload"], event["created_at"]).encode())
        if event["hash"] != expected:
            raise DurableStoreError("ledger event hash is invalid")
        event = dict(event)
        event["seq"] = sequence
        events.append(event)
        previous = event["hash"]
    return events


def _schema_event(events: list[dict]) -> dict:
    matches = [event for event in events if event["type"] == "schema.v2"]
    if len(matches) != 1:
        raise DurableStoreError("ledger must contain exactly one schema.v2 boundary event")
    return matches[0]


def _apply_registered_v2_event(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    event_type = event.get("type")
    handler = V2_EVENT_APPLIERS.get(event_type) if isinstance(event_type, str) else None
    if handler is None:
        raise DurableStoreError("v2 ledger event has no registered projection handler")
    try:
        handler(db, event)
    except DurableStoreError:
        raise
    except Exception as exc:
        raise DurableStoreError(f"cannot replay registered v2 event: {event_type}") from exc


def _table_layout(db: sqlite3.Connection, table: str) -> tuple[tuple[object, ...], ...]:
    escaped = table.replace('"', '""')
    return tuple(tuple(row) for row in db.execute(f'PRAGMA table_info("{escaped}")'))


def _index_shape(db: sqlite3.Connection, table: str) -> tuple[tuple[object, ...], ...]:
    escaped = table.replace('"', '""')
    shapes = []
    for row in db.execute(f'PRAGMA index_list("{escaped}")'):
        name, unique, origin, partial = row[1], row[2], row[3], row[4]
        index_name = str(name).replace('"', '""')
        columns = tuple(item[2] for item in db.execute(f'PRAGMA index_info("{index_name}")'))
        shapes.append((unique, origin, partial, columns))
    return tuple(sorted(shapes, key=repr))


def _expected_v1_index_shape(table: str) -> tuple[tuple[object, ...], ...]:
    if table == "events":
        return ((1, "u", 0, ("hash",)),)
    return ((1, "pk", 0, (_PRIMARY_KEYS[table],)),)


def _assert_exact_v1_schema(db: sqlite3.Connection) -> None:
    objects = db.execute(
        "SELECT type,name FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger') ORDER BY type,name"
    ).fetchall()
    if [(row[0], row[1]) for row in objects] != [("table", name) for name in sorted(V1_LAYOUT)]:
        raise DurableStoreError("projection is not the exact known v1 table set")
    for name, expected in V1_LAYOUT.items():
        if _table_layout(db, name) != expected:
            raise DurableStoreError(f"projection has an unknown v1 layout: {name}")
        if _index_shape(db, name) != _expected_v1_index_shape(name):
            raise DurableStoreError(f"projection has an unknown v1 index layout: {name}")
        escaped = name.replace('"', '""')
        if tuple(db.execute(f'PRAGMA foreign_key_list("{escaped}")')):
            raise DurableStoreError(f"projection has unknown v1 foreign keys: {name}")
    if _schema_shape(db) != _expected_v1_shape():
        raise DurableStoreError("projection is not the exact known v1 definition")


def _create_v1_schema(db: sqlite3.Connection) -> None:
    db.executescript(_CREATE_V1_SQL)


def _apply_v2_ddl(db: sqlite3.Connection) -> None:
    # Callers own the transaction.  Do not replace this with executescript:
    # sqlite3.executescript commits implicitly and would split PREPARED DDL.
    for statement in _V2_DDL:
        db.execute(statement)


def _schema_shape(db: sqlite3.Connection) -> dict:
    objects = db.execute(
        "SELECT type,name FROM sqlite_master "
        "WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','trigger') ORDER BY type,name"
    ).fetchall()
    shape: dict[str, object] = {"objects": [(row[0], row[1]) for row in objects], "tables": {}}
    for object_type, name in shape["objects"]:
        if object_type != "table":
            continue
        escaped = str(name).replace('"', '""')
        sql_row = db.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        normalized_sql = " ".join(str(sql_row[0]).split()) if sql_row and sql_row[0] else None
        shape["tables"][name] = {
            "sql": normalized_sql,
            "columns": [list(row) for row in _table_layout(db, name)],
            "indexes": [list(row[:-1]) + [list(row[-1])] for row in _index_shape(db, name)],
            "foreign_keys": [list(row) for row in db.execute(f'PRAGMA foreign_key_list("{escaped}")')],
        }
    return shape


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


def _assert_exact_v2_schema(db: sqlite3.Connection) -> None:
    if _schema_shape(db) != _expected_v2_shape():
        raise DurableStoreError("projection is not the exact known v2 layout")


def _expected_v1_shape() -> dict:
    db = sqlite3.connect(":memory:")
    try:
        _create_v1_schema(db)
        return _schema_shape(db)
    finally:
        db.close()


def _ordered_rows(db: sqlite3.Connection, table: str, columns: tuple[str, ...]) -> list[list[object]]:
    quoted_columns = ",".join('"' + column.replace('"', '""') + '"' for column in columns)
    quoted_table = '"' + table.replace('"', '""') + '"'
    order = ",".join(str(index + 1) for index in range(len(columns)))
    return [list(row) for row in db.execute(f"SELECT {quoted_columns} FROM {quoted_table} ORDER BY {order}")]


def _v1_inventory(db: sqlite3.Connection, ledger: bytes, events: list[dict]) -> tuple[str, dict]:
    tables = {}
    for name, layout in sorted(V1_LAYOUT.items()):
        columns = tuple(str(row[1]) for row in layout)
        rows = _ordered_rows(db, name, columns)
        tables[name] = {"row_count": len(rows), "rows_sha256": _sha256(_canonical(rows))}
    ledger_description = {
        "bytes": len(ledger), "sha256": _sha256(ledger), "event_count": len(events),
        "tip_hash": events[-1]["hash"] if events else GENESIS,
    }
    inventory = {"schema": "kizuki-gauntlet-v1-exact", "ledger": ledger_description, "tables": tables}
    return _sha256(_canonical(inventory)), inventory


def _disposition_plan(db: sqlite3.Connection) -> dict:
    campaign_terminal = {"ABORTED", "RELEASED"}
    task_states = {
        "DISCOVERED", "READY", "LEASED", "RUNNING", "SUBMITTED", "VERIFYING",
        "REVIEWING", "INTEGRATING", "MERGED", "POST_MERGE_VERIFYING",
        "CHANGES_REQUESTED", "RECOVERING", "FAILED", "SUPERSEDED", "DONE",
    }
    campaigns = []
    for campaign_id, state in db.execute("SELECT id,state FROM campaigns ORDER BY id"):
        if state not in {
            "RECONCILING", "READY", "ACTIVE", "QUIESCING", "VERIFYING",
            "RC_READY", "VALIDATING", "PAUSED", "FAILED", *campaign_terminal,
        }:
            raise DurableStoreError("v1 campaign has an unknown state")
        campaigns.append({"id": campaign_id, "prior_state": state,
                          "recovery_required": state not in campaign_terminal})
    tasks = []
    merge_recovery_tasks = []
    for task_id, state in db.execute("SELECT id,state FROM tasks ORDER BY id"):
        if state not in task_states:
            raise DurableStoreError("v1 task has an unknown state")
        target, delta, action = state, 0, "RETAIN"
        if state in {"LEASED", "RUNNING", "RECOVERING"}:
            target, delta, action = "READY", 1, "NEW_BUILDER_ATTEMPT_REQUIRED"
        elif state in {"SUBMITTED", "VERIFYING", "REVIEWING"}:
            target, delta, action = "READY", 2, "CHANGES_REQUESTED_THEN_NEW_ATTEMPT"
        elif state == "CHANGES_REQUESTED":
            target, delta, action = "READY", 1, "NEW_BUILDER_ATTEMPT_REQUIRED"
        elif state in {"INTEGRATING", "MERGED", "POST_MERGE_VERIFYING"}:
            action = "GLOBAL_RECOVERY_HOLD"
            merge_recovery_tasks.append({"id": task_id, "prior_state": state})
        tasks.append({"id": task_id, "prior_state": state, "target_state": target,
                      "version_delta": delta, "action": action})
    lease_rows = _ordered_rows(
        db, "leases", ("scope", "task_id", "holder", "token", "expires_at", "heartbeat_at", "epoch")
    )
    return {
        "version": 1,
        "lease_count": len(lease_rows),
        "lease_inventory_sha256": _sha256(_canonical(lease_rows)),
        "lease_action": "RETIRE_ALL",
        "campaigns": campaigns,
        "tasks": tasks,
        "merge_recovery": {
            "resource": "merge/global",
            "required": bool(merge_recovery_tasks),
            "status": "RECOVERY_REQUIRED" if merge_recovery_tasks else "FREE",
            "task_count": len(merge_recovery_tasks),
            "tasks": merge_recovery_tasks,
        },
    }


def _apply_v1_event(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    event_type = event["type"]
    if event_type not in V1_EVENT_TYPES:
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
            db.execute("UPDATE campaigns SET epoch=?,updated_at=?", (payload["epoch"], now))
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
                (payload["id"], payload["campaign_id"], payload["scope"], "DISCOVERED", 0, 1, now),
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
                "INSERT INTO fences VALUES(?,?) "
                "ON CONFLICT(scope) DO UPDATE SET token=MAX(token,excluded.token)",
                (payload["scope"], payload["token"]),
            )
            db.execute(
                "INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?,?,?)",
                (payload["scope"], payload["task_id"], payload["holder"], payload["token"],
                 payload["expires_at"], payload["heartbeat_at"], payload["epoch"]),
            )
            if payload.get("starts_attempt", False):
                db.execute(
                    "UPDATE tasks SET attempts=attempts+1,state='LEASED',version=version+1,updated_at=? WHERE id=?",
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
                (payload["id"], payload["task_id"], payload["attempt"], payload["phase"],
                 payload["sha"], json.dumps(payload["tests"], sort_keys=True), payload["scope"],
                 payload["holder"], payload["token"], payload["epoch"], payload.get("artifact"), now),
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
                 json.dumps(payload["evidence"], sort_keys=True), now),
            )
        elif event_type == "adapter.receipt":
            db.execute(
                "INSERT OR REPLACE INTO adapter_receipts VALUES(?,?,?,?,?,?,?,?,?,?)",
                (payload["name"], payload["version"], payload["auth_status"],
                 payload["route_status"], payload["evidence_sha256"],
                 payload["executable_sha256"], payload["method"], payload["reason_code"],
                 payload["checked_at"], payload["expires_at"]),
            )
    except (KeyError, sqlite3.Error, TypeError, ValueError) as exc:
        if isinstance(exc, DurableStoreError):
            raise
        raise DurableStoreError(f"cannot replay v1 event: {event_type}") from exc


def _insert_projected_event(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    try:
        db.execute(
            "INSERT INTO events VALUES(?,?,?,?,?)",
            (event["seq"], event["hash"], event["type"],
             json.dumps(event["payload"], sort_keys=True), event["created_at"]),
        )
    except sqlite3.Error as exc:
        raise DurableStoreError("event projection insert failed") from exc


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
        db.execute("ROLLBACK")
        db.close()
        raise
    return db


def _projection_rows(db: sqlite3.Connection, table_names: tuple[str, ...]) -> dict[str, list[list[object]]]:
    rows = {}
    for name in table_names:
        layout = _table_layout(db, name)
        columns = tuple(str(row[1]) for row in layout)
        rows[name] = [
            [
                {"$bytes_hex": bytes(value).hex()}
                if isinstance(value, (bytes, bytearray, memoryview)) else value
                for value in row
            ]
            for row in _ordered_rows(db, name, columns)
        ]
    return rows


def _assert_v1_projection_matches_ledger(db: sqlite3.Connection, events: list[dict]) -> None:
    expected = _replay_v1(events)
    try:
        actual_rows = {}
        expected_rows = {}
        for name, layout in sorted(V1_LAYOUT.items()):
            columns = tuple(str(row[1]) for row in layout)
            actual_rows[name] = _ordered_rows(db, name, columns)
            expected_rows[name] = _ordered_rows(expected, name, columns)
        if actual_rows != expected_rows:
            raise DurableStoreError("v1 projection does not match deterministic ledger replay")
    finally:
        expected.close()


def _metadata_values(
    report: MigrationPreflight, plan: dict, schema_event: Mapping[str, object],
    schema_event_bytes: bytes,
) -> tuple[object, ...]:
    return (
        1, 2, "PREPARED", report.ledger_prefix_sha256, report.ledger_prefix_bytes,
        report.ledger_event_count, report.ledger_tip_hash, report.v1_inventory_sha256,
        report.disposition_sha256, _canonical(plan).decode("ascii"),
        sqlite3.Binary(schema_event_bytes), schema_event["hash"],
        schema_event["created_at"],
    )


def _insert_prepared_metadata(
    db: sqlite3.Connection, report: MigrationPreflight, plan: dict,
    schema_event: Mapping[str, object], schema_event_bytes: bytes,
) -> None:
    db.execute(
        "INSERT INTO schema_metadata VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        _metadata_values(report, plan, schema_event, schema_event_bytes),
    )


def _read_metadata(db: sqlite3.Connection) -> sqlite3.Row:
    rows = db.execute("SELECT * FROM schema_metadata ORDER BY singleton").fetchall()
    if len(rows) != 1 or rows[0]["singleton"] != 1 or rows[0]["schema_version"] != 2:
        raise DurableStoreError("v2 schema metadata is missing or ambiguous")
    row = rows[0]
    if row["state"] not in {"PREPARED", "COMMITTED"}:
        raise DurableStoreError("v2 schema metadata state is invalid")
    try:
        plan = json.loads(row["disposition_json"])
    except (TypeError, json.JSONDecodeError) as exc:
        raise DurableStoreError("migration disposition metadata is malformed") from exc
    if _canonical(plan).decode("ascii") != row["disposition_json"]:
        raise DurableStoreError("migration disposition metadata is not canonical")
    if _sha256(_canonical(plan)) != row["disposition_sha256"]:
        raise DurableStoreError("migration disposition digest mismatch")
    _prepared_schema_event(row)
    return row


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
    observed_at = time.time() if created_at is None else created_at
    if (isinstance(observed_at, bool) or not isinstance(observed_at, (int, float))
            or not math.isfinite(observed_at)):
        raise DurableStoreError("schema.v2 event time is invalid")
    payload = _schema_payload(report, plan)
    raw = _raw_event(report.ledger_tip_hash, "schema.v2", payload, observed_at)
    event = {
        "prev": report.ledger_tip_hash,
        "hash": _sha256(raw.encode()),
        "type": "schema.v2",
        "payload": payload,
        "created_at": observed_at,
        "seq": report.ledger_event_count + 1,
    }
    encoded = {key: value for key, value in event.items() if key != "seq"}
    return event, _canonical(encoded) + b"\n"


def _prepared_schema_event(metadata: sqlite3.Row) -> tuple[dict, bytes]:
    stored = metadata["schema_event_bytes"]
    if isinstance(stored, memoryview):
        stored = stored.tobytes()
    if not isinstance(stored, bytes) or not stored.endswith(b"\n") or b"\n" in stored[:-1]:
        raise DurableStoreError("PREPARED schema.v2 bytes are malformed")
    try:
        decoded = json.loads(stored[:-1].decode("ascii"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DurableStoreError("PREPARED schema.v2 bytes are not canonical JSON") from exc
    if not isinstance(decoded, dict) or set(decoded) != {
        "prev", "hash", "type", "payload", "created_at",
    }:
        raise DurableStoreError("PREPARED schema.v2 envelope is not recognized")
    if _canonical(decoded) + b"\n" != stored:
        raise DurableStoreError("PREPARED schema.v2 bytes are not canonical")
    if (decoded["type"] != "schema.v2"
            or decoded["prev"] != metadata["ledger_tip_hash"]
            or decoded["hash"] != metadata["schema_event_hash"]
            or decoded["created_at"] != metadata["schema_event_created_at"]):
        raise DurableStoreError("PREPARED schema.v2 binding is inconsistent")
    created_at = decoded["created_at"]
    if (isinstance(created_at, bool) or not isinstance(created_at, (int, float))
            or not math.isfinite(created_at)):
        raise DurableStoreError("PREPARED schema.v2 event time is invalid")
    expected_hash = _sha256(
        _raw_event(decoded["prev"], "schema.v2", decoded["payload"], created_at).encode()
    )
    if decoded["hash"] != expected_hash:
        raise DurableStoreError("PREPARED schema.v2 hash is invalid")
    _validate_schema_payload(decoded["payload"], metadata)
    decoded["seq"] = metadata["ledger_event_count"] + 1
    return decoded, stored


def _validate_schema_payload(payload: object, metadata: Optional[sqlite3.Row] = None) -> dict:
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
            "disposition_plan": json.loads(metadata["disposition_json"]),
        }
        if payload != expected:
            raise DurableStoreError("schema.v2 event does not match PREPARED metadata")
    return payload


def _apply_disposition_plan(
    db: sqlite3.Connection, plan: dict, *, event_created_at: float
) -> None:
    if plan.get("version") != 1 or plan.get("lease_action") != "RETIRE_ALL":
        raise DurableStoreError("migration disposition plan version is unsupported")
    current_lease_rows = _ordered_rows(
        db, "leases", ("scope", "task_id", "holder", "token", "expires_at", "heartbeat_at", "epoch")
    )
    db.execute("INSERT INTO protocol_counters VALUES('phase_fence',0)")
    if len(current_lease_rows) != plan.get("lease_count") or _sha256(_canonical(current_lease_rows)) != plan.get("lease_inventory_sha256"):
        raise DurableStoreError("legacy leases changed after migration preparation")
    db.execute("DELETE FROM leases")
    db.execute(
        "INSERT INTO migration_dispositions VALUES(?,?,?,?,?)",
        ("LEASE_SET", "v1", None, None, "RETIRE_ALL"),
    )
    for item in plan.get("campaigns", []):
        if set(item) != {"id", "prior_state", "recovery_required"}:
            raise DurableStoreError("campaign disposition is malformed")
        cursor = db.execute(
            "UPDATE campaigns SET recovery_required=? WHERE id=? AND state=?",
            (1 if item["recovery_required"] else 0, item["id"], item["prior_state"]),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("campaign changed after migration preparation")
        db.execute(
            "INSERT INTO migration_dispositions VALUES(?,?,?,?,?)",
            ("CAMPAIGN", item["id"], item["prior_state"], item["prior_state"],
             "RECOVERY_REQUIRED" if item["recovery_required"] else "RETAIN_TERMINAL"),
        )
    for item in plan.get("tasks", []):
        if set(item) != {"id", "prior_state", "target_state", "version_delta", "action"}:
            raise DurableStoreError("task disposition is malformed")
        recovery_from = item["prior_state"] if item["action"] != "RETAIN" else None
        cursor = db.execute(
            "UPDATE tasks SET state=?,version=version+?,active_role=NULL,recovery_from=? "
            "WHERE id=? AND state=?",
            (item["target_state"], item["version_delta"], recovery_from,
             item["id"], item["prior_state"]),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("task changed after migration preparation")
        db.execute(
            "INSERT INTO migration_dispositions VALUES(?,?,?,?,?)",
            ("TASK", item["id"], item["prior_state"], item["target_state"], item["action"]),
        )
    hold = plan.get("merge_recovery")
    if not isinstance(hold, dict) or set(hold) != {
        "resource", "required", "status", "task_count", "tasks",
    }:
        raise DurableStoreError("merge recovery disposition is malformed")
    hold_tasks = hold["tasks"]
    if (not isinstance(hold_tasks, list)
            or hold["resource"] != "merge/global" or not isinstance(hold["required"], bool)
            or isinstance(hold["task_count"], bool)
            or not isinstance(hold["task_count"], int)
            or hold["task_count"] != len(hold_tasks)
            or hold["required"] != bool(hold_tasks)
            or hold["status"] != ("RECOVERY_REQUIRED" if hold_tasks else "FREE")):
        raise DurableStoreError("merge recovery disposition is inconsistent")
    expected_hold_tasks = [
        {"id": item["id"], "prior_state": item["prior_state"]}
        for item in plan.get("tasks", []) if item["action"] == "GLOBAL_RECOVERY_HOLD"
    ]
    if hold_tasks != expected_hold_tasks:
        raise DurableStoreError("merge recovery task membership is inconsistent")
    if hold["required"]:
        fence = db.execute(
            "SELECT token FROM fences WHERE scope='merge/global'"
        ).fetchone()
        epoch = db.execute(
            "SELECT value FROM controller WHERE key='epoch'"
        ).fetchone()
        db.execute(
            "INSERT INTO merge_claims VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ("merge/global", fence[0] if fence else 0, None, None, None, None,
             None, None, None, "RECOVERY_REQUIRED", epoch[0] if epoch else 0,
             None, event_created_at),
        )
        for item in hold_tasks:
            if not isinstance(item, dict) or set(item) != {"id", "prior_state"}:
                raise DurableStoreError("merge recovery task is malformed")
            db.execute(
                "INSERT INTO merge_recovery_tasks VALUES(?,?,?)",
                ("merge/global", item["id"], item["prior_state"]),
            )


def _v2_projection_digest(
    db: sqlite3.Connection, *, ignore_runtime_intent: bool = False,
) -> str:
    _assert_exact_v2_schema(db)
    table_names = tuple(
        row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    )
    rows = _projection_rows(db, table_names)
    if ignore_runtime_intent:
        rows["runtime_append_intent"] = []
    value = {"schema": _schema_shape(db), "rows": rows}
    return _sha256(_canonical(value))


def _legacy_receipts(db: sqlite3.Connection) -> tuple[LegacyReceipt, ...]:
    return tuple(
        LegacyReceipt(row["id"], row["task_id"], row["attempt"], row["phase"],
                      row["schema_version"], row["authoritative"])
        for row in db.execute(
            "SELECT id,task_id,attempt,phase,schema_version,authoritative "
            "FROM receipts ORDER BY id"
        )
    )


def _v2_payload(event: Mapping[str, object], keys: set[str]) -> dict:
    payload = event.get("payload")
    if not isinstance(payload, dict) or set(payload) != keys:
        raise DurableStoreError(f"unrecognized payload for {event.get('type')}")
    return payload


def _trusted_unit_success_evidence(unit: sqlite3.Row) -> bool:
    return (
        unit["state"] == "STOPPED"
        and unit["cgroup_empty"] == 1
        and unit["recovery_required"] == 0
        and isinstance(unit["main_pid"], int) and unit["main_pid"] > 0
        and unit["exit_outcome"] == "EXITED" and unit["exit_code"] == 0
        and unit["stdout_eof"] == 1 and unit["stderr_eof"] == 1
        and unit["output_overflow"] == 0 and unit["timed_out"] == 0
        and unit["cancelled"] == 0 and unit["drain_limit_hit"] == 0
        and unit["raw_evidence_status"] == "COMMITTED"
        and unit["stop_callback_status"] in {"NOT_REQUIRED", "SUCCEEDED"}
        and isinstance(unit["cpu_usage_ns"], int) and unit["cpu_usage_ns"] >= 0
        and isinstance(unit["memory_peak_bytes"], int)
        and unit["memory_peak_bytes"] >= 0
        and isinstance(unit["tasks_peak"], int) and unit["tasks_peak"] >= 0
        and unit["oom_count"] == 0 and unit["oom_killed"] == 0
        and unit["systemd_service_result"] == "success"
        and unit["systemd_exec_code"] == 1 and unit["systemd_exec_status"] == 0
        and isinstance(unit["resource_outcome_sha256"], str)
        and len(unit["resource_outcome_sha256"]) == 64
    )


def _apply_controller_epoch_v2(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    payload = _v2_payload(event, {
        "epoch", "previous_epoch", "campaigns", "attempts", "units",
        "merge_claims",
    })
    epoch, previous = payload["epoch"], payload["previous_epoch"]
    if (isinstance(epoch, bool) or not isinstance(epoch, int) or epoch <= 0
            or isinstance(previous, bool) or not isinstance(previous, int)
            or epoch != previous + 1):
        raise DurableStoreError("invalid controller epoch event")
    row = db.execute("SELECT value FROM controller WHERE key='epoch'").fetchone()
    actual = row[0] if row else 0
    if actual != previous:
        raise DurableStoreError("controller epoch event is stale")
    campaigns = payload["campaigns"]
    attempts = payload["attempts"]
    units = payload["units"]
    merge_claims = payload["merge_claims"]
    if not all(isinstance(items, list) for items in (
        campaigns, attempts, units, merge_claims,
    )):
        raise DurableStoreError("controller recovery inventory is malformed")
    expected_campaigns = [
        row[0] for row in db.execute(
            "SELECT id FROM campaigns WHERE state NOT IN ('ABORTED','RELEASED') "
            "ORDER BY id"
        )
    ]
    expected_attempts = [
        row[0] for row in db.execute(
            "SELECT attempt_id FROM phase_attempts WHERE epoch<? AND state IN "
            "('CLAIMED','SPECIFIED','LAUNCH_PREPARED','RUNNING','STOPPING',"
            "'EXITED','RECOVERY_REQUIRED') ORDER BY attempt_id", (epoch,)
        )
    ]
    expected_units = [
        row[0] for row in db.execute(
            "SELECT u.attempt_id FROM attempt_units u JOIN phase_attempts a "
            "ON a.attempt_id=u.attempt_id WHERE a.epoch<? AND u.state<>'STOPPED' "
            "ORDER BY u.attempt_id", (epoch,)
        )
    ]
    expected_merge_claims = [
        row[0] for row in db.execute(
            "SELECT resource FROM merge_claims WHERE status='HELD' AND epoch<? "
            "ORDER BY resource", (epoch,)
        )
    ]
    inventory_ids = []
    for item in campaigns:
        if not isinstance(item, dict) or set(item) != {
            "campaign_id", "state", "expected_epoch", "expected_version", "version",
        }:
            raise DurableStoreError("controller campaign recovery item is malformed")
        if (item["state"] in TERMINAL_CAMPAIGN_STATES
                or any(
                    _require_integer(item[name], f"controller campaign {name}",
                                     minimum=0 if name == "expected_epoch" else 1) < 0
                    for name in ("expected_epoch", "expected_version", "version")
                )
                or item["expected_epoch"] != previous
                or item["version"] != item["expected_version"] + 1):
            raise DurableStoreError("controller campaign recovery item is invalid")
        inventory_ids.append(item["campaign_id"])
        cursor = db.execute(
            "UPDATE campaigns SET epoch=?,recovery_required=1,version=?,updated_at=? "
            "WHERE id=? AND state=? AND epoch=? AND version=?",
            (epoch, item["version"], event["created_at"], item["campaign_id"],
             item["state"], item["expected_epoch"], item["expected_version"]),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("controller campaign recovery CAS failed")
    if inventory_ids != sorted(set(inventory_ids)) or inventory_ids != expected_campaigns:
        raise DurableStoreError("controller campaign recovery inventory is ambiguous")
    inventory_ids = []
    for item in attempts:
        if not isinstance(item, dict) or set(item) != {
            "attempt_id", "state", "interrupted_state", "stale_epoch",
            "expected_version", "version",
        }:
            raise DurableStoreError("controller attempt recovery item is malformed")
        if (item["state"] not in NONTERMINAL_ATTEMPT_STATES
                or any(
                    _require_integer(item[name], f"controller attempt {name}") < 1
                    for name in ("stale_epoch", "expected_version", "version")
                )
                or item["stale_epoch"] >= epoch
                or item["version"] != item["expected_version"] + 1
                or item["interrupted_state"] not in NONTERMINAL_ATTEMPT_STATES):
            raise DurableStoreError("controller attempt recovery item is invalid")
        inventory_ids.append(item["attempt_id"])
        cursor = db.execute(
            "UPDATE phase_attempts SET state='RECOVERY_REQUIRED',interrupted_state=?,"
            "version=?,updated_event_seq=? WHERE attempt_id=? AND state=? "
            "AND epoch=? AND version=?",
            (item["interrupted_state"], item["version"], event["seq"],
             item["attempt_id"], item["state"], item["stale_epoch"],
             item["expected_version"]),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("controller attempt recovery CAS failed")
    if inventory_ids != sorted(set(inventory_ids)) or inventory_ids != expected_attempts:
        raise DurableStoreError("controller attempt recovery inventory is ambiguous")
    inventory_ids = []
    for item in units:
        if not isinstance(item, dict) or set(item) != {
            "attempt_id", "state", "recovery_from", "expected_version", "version",
        }:
            raise DurableStoreError("controller unit recovery item is malformed")
        if (item["state"] == "STOPPED"
                or any(
                    _require_integer(item[name], f"controller unit {name}") < 1
                    for name in ("expected_version", "version")
                )
                or item["version"] != item["expected_version"] + 1
                or item["recovery_from"] not in {"PREPARED", "RUNNING", "STOPPING"}):
            raise DurableStoreError("controller unit recovery item is invalid")
        inventory_ids.append(item["attempt_id"])
        cursor = db.execute(
            "UPDATE attempt_units SET state='RECOVERY_REQUIRED',recovery_from=?,"
            "recovery_required=1,version=?,updated_event_seq=? "
            "WHERE attempt_id=? AND state=? AND version=?",
            (item["recovery_from"], item["version"], event["seq"],
             item["attempt_id"], item["state"], item["expected_version"]),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("controller unit recovery CAS failed")
    if inventory_ids != sorted(set(inventory_ids)) or inventory_ids != expected_units:
        raise DurableStoreError("controller unit recovery inventory is ambiguous")
    inventory_ids = []
    for item in merge_claims:
        if not isinstance(item, dict) or set(item) != {
            "resource", "stale_epoch", "expected_generation", "generation",
        }:
            raise DurableStoreError("controller merge recovery item is malformed")
        expected_generation = item["expected_generation"]
        generation = item["generation"]
        if (item["resource"] != "merge/global" or item["stale_epoch"] >= epoch
                or _require_integer(
                    item["stale_epoch"], "controller merge stale epoch",
                ) < 1
                or isinstance(expected_generation, bool)
                or not isinstance(expected_generation, int) or expected_generation < 1
                or generation != expected_generation + 1):
            raise DurableStoreError("controller merge recovery item is invalid")
        inventory_ids.append(item["resource"])
        cursor = db.execute(
            "UPDATE merge_claims SET status='RECOVERY_REQUIRED',epoch=?,"
            "grant_generation=?,updated_at=? WHERE resource=? AND status='HELD' "
            "AND epoch=? AND grant_generation=?",
            (epoch, generation, event["created_at"], item["resource"],
             item["stale_epoch"], expected_generation),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("controller merge recovery CAS failed")
    if (inventory_ids != sorted(set(inventory_ids))
            or inventory_ids != expected_merge_claims):
        raise DurableStoreError("controller merge recovery inventory is ambiguous")
    db.execute(
        "INSERT INTO controller VALUES('epoch',?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (epoch,),
    )


def _apply_identity_registered_v2(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    payload = _v2_payload(event, {
        "identity_receipt_sha256", "lineage_id", "manifest_sha256", "principal_id",
        "authority_domain", "adapter", "generation", "account_binding_sha256",
        "executable_sha256", "network_profile_sha256", "checked_at",
        "expires_at", "epoch", "superseded_attempts", "superseded_units",
    })
    _require_hex(payload["identity_receipt_sha256"], 64, "identity receipt digest")
    _require_hex(payload["lineage_id"], 64, "identity lineage digest")
    _require_hex(payload["manifest_sha256"], 64, "identity manifest digest")
    _require_hex(payload["account_binding_sha256"], 64, "account binding digest")
    _require_hex(payload["executable_sha256"], 64, "identity executable digest")
    _require_hex(payload["network_profile_sha256"], 64, "network profile digest")
    _require_identifier(payload["principal_id"], "identity principal")
    _require_identifier(payload["authority_domain"], "identity authority domain")
    controller = db.execute("SELECT value FROM controller WHERE key='epoch'").fetchone()
    expected_lineage_id = _identity_lineage_id(
        payload["principal_id"], payload["authority_domain"],
        payload["account_binding_sha256"],
    )
    lineage_rows = db.execute(
        "SELECT * FROM identity_lineages WHERE principal_id=? "
        "OR authority_domain=? OR account_binding_sha256=? ORDER BY lineage_id",
        (payload["principal_id"], payload["authority_domain"],
         payload["account_binding_sha256"]),
    ).fetchall()
    if payload["lineage_id"] != expected_lineage_id or len(lineage_rows) > 1:
        raise DurableStoreError("identity lineage event is aliased or malformed")
    if lineage_rows:
        lineage = lineage_rows[0]
        if any(lineage[key] != payload[key] for key in (
            "lineage_id", "principal_id", "authority_domain",
            "account_binding_sha256",
        )):
            raise DurableStoreError("identity lineage event contains an alias")
    else:
        db.execute(
            "INSERT INTO identity_lineages VALUES(?,?,?,?,?)",
            (payload["lineage_id"], payload["principal_id"],
             payload["authority_domain"], payload["account_binding_sha256"],
             event["seq"]),
        )
    latest = db.execute(
        "SELECT max(generation) FROM identity_registry WHERE lineage_id=?",
        (payload["lineage_id"],),
    ).fetchone()[0]
    generation = _require_integer(payload["generation"], "identity generation")
    registration_epoch = _require_integer(payload["epoch"], "identity epoch")
    if (payload["adapter"] not in {"codex", "claude", "cursor", "grok"}
            or (latest is not None and generation <= latest)
            or controller is None or registration_epoch != controller[0]
            or any(
                isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value)
                for value in (payload["checked_at"], payload["expires_at"])
            )
            or not payload["checked_at"] <= event["created_at"] < payload["expires_at"]):
        raise DurableStoreError("identity registration event is stale or malformed")
    attempts = payload["superseded_attempts"]
    units = payload["superseded_units"]
    if not isinstance(attempts, list) or not isinstance(units, list):
        raise DurableStoreError("identity supersession inventory is malformed")
    expected_attempts = [
        {
            "attempt_id": row["attempt_id"], "state": row["state"],
            "expected_version": row["version"], "version": row["version"] + 1,
        }
        for row in db.execute(
            "SELECT DISTINCT a.attempt_id,a.state,a.version "
            "FROM phase_attempts a JOIN consumed_authority_bindings b "
            "ON b.binding_id=a.binding_id WHERE a.state IN "
            "('CLAIMED','SPECIFIED','LAUNCH_PREPARED','RUNNING','STOPPING','EXITED') "
            "AND b.principal_id=? AND b.authority_domain=? "
            "AND b.account_binding_sha256=? "
            "ORDER BY a.attempt_id",
            (payload["principal_id"], payload["authority_domain"],
             payload["account_binding_sha256"]),
        )
    ]
    if attempts != expected_attempts:
        raise DurableStoreError("identity supersession attempt inventory is stale")
    expected_units = [
        {
            "attempt_id": row["attempt_id"], "state": row["state"],
            "expected_version": row["version"], "version": row["version"] + 1,
        }
        for row in db.execute(
            "SELECT u.attempt_id,u.state,u.version FROM attempt_units u "
            "JOIN phase_attempts a ON a.attempt_id=u.attempt_id "
            "WHERE u.state IN ('PREPARED','RUNNING','STOPPING') "
            "AND a.attempt_id IN ("
            "SELECT a2.attempt_id FROM phase_attempts a2 "
            "JOIN consumed_authority_bindings b2 ON b2.binding_id=a2.binding_id "
            "WHERE b2.principal_id=? AND b2.authority_domain=? "
            "AND b2.account_binding_sha256=?) "
            "ORDER BY u.attempt_id",
            (payload["principal_id"], payload["authority_domain"],
             payload["account_binding_sha256"]),
        )
    ]
    if units != expected_units:
        raise DurableStoreError("identity supersession unit inventory is stale")
    for item in attempts:
        if (not isinstance(item, dict) or set(item) != {
                "attempt_id", "state", "expected_version", "version",
        } or item["version"] != item["expected_version"] + 1):
            raise DurableStoreError("identity supersession attempt is malformed")
        cursor = db.execute(
            "UPDATE phase_attempts SET state='RECOVERY_REQUIRED',"
            "interrupted_state=?,version=?,updated_event_seq=? "
            "WHERE attempt_id=? AND state=? AND version=?",
            (item["state"], item["version"], event["seq"], item["attempt_id"],
             item["state"], item["expected_version"]),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("identity supersession attempt CAS failed")
    for item in units:
        if (not isinstance(item, dict) or set(item) != {
                "attempt_id", "state", "expected_version", "version",
        } or item["state"] not in {"PREPARED", "RUNNING", "STOPPING"}
                or item["version"] != item["expected_version"] + 1):
            raise DurableStoreError("identity supersession unit is malformed")
        cursor = db.execute(
            "UPDATE attempt_units SET state='RECOVERY_REQUIRED',recovery_from=?,"
            "recovery_required=1,version=?,updated_event_seq=? "
            "WHERE attempt_id=? AND state=? AND version=?",
            (item["state"], item["version"], event["seq"], item["attempt_id"],
             item["state"], item["expected_version"]),
        )
        if cursor.rowcount != 1:
            raise DurableStoreError("identity supersession unit CAS failed")
    db.execute(
        "INSERT INTO identity_registry("
        "identity_receipt_sha256,lineage_id,manifest_sha256,principal_id,"
        "authority_domain,adapter,generation,account_binding_sha256,"
        "executable_sha256,network_profile_sha256,checked_at,expires_at,"
        "registered_epoch,registered_event_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (payload["identity_receipt_sha256"], payload["lineage_id"],
         payload["manifest_sha256"],
         payload["principal_id"], payload["authority_domain"], payload["adapter"],
         payload["generation"], payload["account_binding_sha256"],
         payload["executable_sha256"], payload["network_profile_sha256"],
         payload["checked_at"], payload["expires_at"], payload["epoch"], event["seq"]),
    )


def _campaign_recovery_is_unresolved(
    db: sqlite3.Connection, campaign_id: str,
) -> bool:
    return db.execute(
        "SELECT 1 FROM phase_attempts a JOIN tasks t ON t.id=a.task_id "
        "WHERE t.campaign_id=? AND a.state='RECOVERY_REQUIRED' "
        "UNION ALL SELECT 1 FROM attempt_units u "
        "JOIN phase_attempts a ON a.attempt_id=u.attempt_id "
        "JOIN tasks t ON t.id=a.task_id WHERE t.campaign_id=? "
        "AND u.state='RECOVERY_REQUIRED' "
        "UNION ALL SELECT 1 FROM merge_recovery_tasks r "
        "JOIN tasks t ON t.id=r.task_id WHERE t.campaign_id=? "
        "UNION ALL SELECT 1 FROM merge_claims m JOIN tasks t ON t.id=m.task_id "
        "WHERE t.campaign_id=? AND m.status='RECOVERY_REQUIRED' "
        "UNION ALL SELECT 1 FROM merge_claims m WHERE m.resource='merge/global' "
        "AND m.status='RECOVERY_REQUIRED' AND m.task_id IS NULL "
        "AND NOT EXISTS(SELECT 1 FROM merge_recovery_tasks) LIMIT 1",
        (campaign_id, campaign_id, campaign_id, campaign_id),
    ).fetchone() is not None


def _apply_campaign_recovery_cleared_v2(
    db: sqlite3.Connection, event: Mapping[str, object]
) -> None:
    payload = _v2_payload(event, {
        "campaign_id", "expected_version", "version", "epoch", "evidence_sha256",
    })
    _require_identifier(payload["campaign_id"], "campaign id")
    _require_hex(payload["evidence_sha256"], 64, "recovery evidence digest")
    for key in ("expected_version", "version", "epoch"):
        _require_integer(payload[key], f"campaign recovery {key}")
    current = db.execute(
        "SELECT state,epoch,version,recovery_required FROM campaigns WHERE id=?",
        (payload["campaign_id"],),
    ).fetchone()
    if (current is None or current["state"] in TERMINAL_CAMPAIGN_STATES
            or current["epoch"] != payload["epoch"]
            or current["version"] != payload["expected_version"]
            or current["recovery_required"] != 1
            or _campaign_recovery_is_unresolved(db, payload["campaign_id"])):
        raise DurableStoreError("campaign recovery clearance has unresolved state")
    cursor = db.execute(
        "UPDATE campaigns SET recovery_required=0,version=?,epoch=?,updated_at=? "
        "WHERE id=? AND version=? AND recovery_required=1",
        (payload["version"], payload["epoch"], event["created_at"],
         payload["campaign_id"], payload["expected_version"]),
    )
    if cursor.rowcount != 1 or payload["version"] != payload["expected_version"] + 1:
        raise DurableStoreError("campaign recovery clearance CAS failed")


def _apply_task_destination_bound_v2(
    db: sqlite3.Connection, event: Mapping[str, object]
) -> None:
    payload = _v2_payload(event, {
        "task_id", "repository", "base_sha", "pr_number", "subject_sha",
        "protocol_version", "expected_version", "version", "epoch",
    })
    _require_identifier(payload["task_id"], "task id")
    _require_repository(payload["repository"])
    _require_hex(payload["base_sha"], 40, "base SHA")
    _require_hex(payload["subject_sha"], 40, "subject SHA")
    for key in ("pr_number", "protocol_version", "expected_version", "version", "epoch"):
        _require_integer(payload[key], f"task destination {key}")
    task = db.execute(
        "SELECT t.*,c.state AS campaign_state,c.recovery_required,"
        "c.epoch AS campaign_epoch FROM tasks t JOIN campaigns c "
        "ON c.id=t.campaign_id WHERE t.id=?", (payload["task_id"],),
    ).fetchone()
    controller = db.execute(
        "SELECT value FROM controller WHERE key='epoch'"
    ).fetchone()
    if (task is None or controller is None or payload["epoch"] != controller[0]
            or task["campaign_epoch"] != payload["epoch"]
            or task["campaign_state"] != "ACTIVE" or task["recovery_required"] != 0
            or task["state"] != "READY" or task["version"] != payload["expected_version"]
            or payload["version"] != payload["expected_version"] + 1
            or payload["protocol_version"] != 2 or payload["pr_number"] <= 0
            or any(task[name] is not None for name in (
                "repository", "base_sha", "pr_number", "protocol_version",
                "subject_sha", "merge_sha", "active_role",
            ))):
        raise DurableStoreError("task destination binding epoch or campaign is stale")
    cursor = db.execute(
        "UPDATE tasks SET repository=?,base_sha=?,pr_number=?,protocol_version=?,"
        "subject_sha=?,version=?,updated_at=? WHERE id=? AND version=? "
        "AND repository IS NULL AND base_sha IS NULL AND pr_number IS NULL",
        (payload["repository"], payload["base_sha"], payload["pr_number"],
         payload["protocol_version"], payload["subject_sha"], payload["version"],
         event["created_at"], payload["task_id"], payload["expected_version"]),
    )
    if cursor.rowcount != 1:
        raise DurableStoreError("task destination binding CAS failed")


def _apply_phase_claimed_v2(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    payload = _v2_payload(event, {
        "attempt_id", "task_id", "task_attempt", "execution_generation",
        "role", "principal_id",
        "authority_domain", "binding_id", "account_binding_sha256",
        "identity_receipt_sha256", "manifest_sha256", "operation_sha256",
        "binding_expires_at",
        "resource", "previous_token", "token", "run_id", "epoch",
        "expected_task_version", "task_version", "task_state_before",
        "task_state_after", "subject_sha", "base_sha", "heartbeat_at", "expires_at",
    })
    _require_hex(payload["attempt_id"], 64, "phase attempt id")
    _require_hex(payload["binding_id"], 64, "authority binding id")
    _require_hex(payload["account_binding_sha256"], 64, "account binding digest")
    _require_hex(payload["identity_receipt_sha256"], 64, "identity receipt digest")
    _require_hex(payload["manifest_sha256"], 64, "identity manifest digest")
    _require_hex(payload["operation_sha256"], 64, "phase operation digest")
    _require_hex(payload["run_id"], 64, "phase run id")
    _require_hex(payload["subject_sha"], 40, "phase subject SHA")
    _require_hex(payload["base_sha"], 40, "phase base SHA")
    _require_identifier(payload["task_id"], "task id")
    _require_identifier(payload["principal_id"], "phase principal")
    _require_identifier(payload["authority_domain"], "phase authority domain")
    _require_role(payload["role"])
    for key in (
        "task_attempt", "execution_generation", "token", "epoch",
        "expected_task_version", "task_version",
    ):
        _require_integer(payload[key], f"phase claim {key}")
    _require_integer(
        payload["previous_token"], "phase claim previous token", minimum=0,
    )
    if payload["role"] in {"integrator", "post-merge-verifier"}:
        raise DurableStoreError("merge-bound phase claim API is not registered")
    task = db.execute(
        "SELECT t.*,c.state AS campaign_state,c.recovery_required,"
        "c.epoch AS campaign_epoch FROM tasks t JOIN campaigns c "
        "ON c.id=t.campaign_id WHERE t.id=?", (payload["task_id"],),
    ).fetchone()
    controller = db.execute("SELECT value FROM controller WHERE key='epoch'").fetchone()
    identity = db.execute(
        "SELECT * FROM identity_registry WHERE identity_receipt_sha256=?",
        (payload["identity_receipt_sha256"],),
    ).fetchone()
    latest_identity = db.execute(
        "SELECT identity_receipt_sha256 FROM identity_registry "
        "WHERE principal_id=? AND authority_domain=? AND account_binding_sha256=? "
        "ORDER BY generation DESC,registered_event_seq DESC LIMIT 1",
        (payload["principal_id"], payload["authority_domain"],
         payload["account_binding_sha256"]),
    ).fetchone()
    generation = db.execute(
        "SELECT coalesce(max(execution_generation),0)+1 FROM phase_attempts "
        "WHERE task_id=? AND task_attempt=? AND role=?",
        (payload["task_id"], payload["task_attempt"], payload["role"]),
    ).fetchone()[0]
    expected_task_attempt = (
        task["attempts"] + 1 if task is not None and payload["role"] == "builder"
        else task["attempts"] if task is not None else None
    )
    expected_state = (
        phase_claim_transition(payload["role"], task["state"])
        if task is not None else None
    )
    if (task is None or controller is None or controller[0] != payload["epoch"]
            or task["campaign_state"] != "ACTIVE" or task["recovery_required"] != 0
            or task["campaign_epoch"] != payload["epoch"]
            or task["version"] != payload["expected_task_version"]
            or payload["task_version"] != payload["expected_task_version"] + 1
            or payload["task_attempt"] != expected_task_attempt
            or payload["execution_generation"] != generation
            or payload["task_state_before"] != task["state"]
            or payload["task_state_after"] != expected_state
            or payload["subject_sha"] != task["subject_sha"]
            or payload["base_sha"] != task["base_sha"]
            or identity is None or latest_identity is None
            or latest_identity[0] != payload["identity_receipt_sha256"]
            or identity["manifest_sha256"] != payload["manifest_sha256"]
            or identity["principal_id"] != payload["principal_id"]
            or identity["authority_domain"] != payload["authority_domain"]
            or identity["account_binding_sha256"] != payload["account_binding_sha256"]):
        raise DurableStoreError("phase claim event bindings are stale")
    expected_operation = _sha256(_canonical({
        "kind": "protocol.phase_claim.v2", "task_id": payload["task_id"],
        "task_attempt": payload["task_attempt"],
        "execution_generation": payload["execution_generation"],
        "role": payload["role"], "epoch": payload["epoch"],
        "repository": task["repository"], "base_sha": task["base_sha"],
        "pr_number": task["pr_number"], "subject_sha": task["subject_sha"],
        "task_version": task["version"],
    }))
    expected_resource = (
        f"task:{payload['task_id']}:{payload['task_attempt']}:"
        f"{payload['role']}"
    )
    expected_run = _sha256(_canonical([
        "phase-run-v2", payload["binding_id"], payload["epoch"],
        payload["token"], payload["execution_generation"],
    ]))
    expected_attempt = _sha256(_canonical([
        "phase-attempt-v2", payload["task_id"], payload["task_attempt"],
        payload["role"], payload["execution_generation"], payload["binding_id"],
        payload["epoch"], payload["token"],
    ]))
    if (payload["operation_sha256"] != expected_operation
            or payload["resource"] != expected_resource
            or payload["run_id"] != expected_run
            or payload["attempt_id"] != expected_attempt
            or any(
                isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value)
                for value in (
                    payload["heartbeat_at"], payload["expires_at"],
                    payload["binding_expires_at"],
                )
            )
            or not payload["heartbeat_at"] <= event["created_at"] < payload["expires_at"]
            or payload["expires_at"] > payload["binding_expires_at"]
            or payload["expires_at"] > identity["expires_at"]):
        raise DurableStoreError("phase claim event derivation is invalid")
    prior_identities = db.execute(
        "SELECT a.role,a.principal_id,a.authority_domain,"
        "b.account_binding_sha256,b.identity_receipt_sha256 "
        "FROM phase_attempts a JOIN consumed_authority_bindings b "
        "ON b.binding_id=a.binding_id WHERE a.task_id=? AND a.task_attempt=?",
        (payload["task_id"], payload["task_attempt"]),
    ).fetchall()
    for prior in prior_identities:
        if phase_identity_reuse_allowed(prior["role"], payload["role"]):
            continue
        if (prior["principal_id"] == payload["principal_id"]
                or prior["authority_domain"] == payload["authority_domain"]
                or prior["account_binding_sha256"] == payload["account_binding_sha256"]
                or prior["identity_receipt_sha256"] == payload["identity_receipt_sha256"]):
            raise DurableStoreError("phase claim identity is not independent")
    if db.execute(
        "SELECT 1 FROM phase_attempts WHERE epoch<>? AND state IN "
        "('CLAIMED','SPECIFIED','LAUNCH_PREPARED','RUNNING','STOPPING','EXITED',"
        "'RECOVERY_REQUIRED') UNION ALL SELECT 1 FROM phase_leases WHERE epoch<>? "
        "UNION ALL SELECT 1 FROM attempt_units WHERE state='RECOVERY_REQUIRED' "
        "UNION ALL SELECT 1 FROM merge_claims WHERE status='RECOVERY_REQUIRED' LIMIT 1",
        (payload["epoch"], payload["epoch"]),
    ).fetchone() is not None:
        raise DurableStoreError("phase claim event crossed an unresolved recovery fence")
    if db.execute(
        "SELECT 1 FROM phase_leases WHERE task_id=? OR principal_id=? "
        "OR authority_domain=? OR account_binding_sha256=? "
        "OR identity_receipt_sha256=? LIMIT 1",
        (payload["task_id"], payload["principal_id"],
         payload["authority_domain"], payload["account_binding_sha256"],
         payload["identity_receipt_sha256"]),
    ).fetchone() is not None:
        raise DurableStoreError("phase claim crossed an active identity or task lease")
    cursor = db.execute(
        "UPDATE protocol_counters SET value=? WHERE name='phase_fence' AND value=?",
        (payload["token"], payload["previous_token"]),
    )
    if cursor.rowcount != 1 or payload["token"] != payload["previous_token"] + 1:
        raise DurableStoreError("phase token allocation CAS failed")
    db.execute(
        "INSERT INTO consumed_authority_bindings VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (payload["binding_id"], payload["task_id"], payload["task_attempt"],
         payload["execution_generation"], payload["role"], payload["principal_id"],
         payload["authority_domain"],
         payload["account_binding_sha256"], payload["identity_receipt_sha256"],
         payload["manifest_sha256"], payload["operation_sha256"],
         payload["binding_expires_at"], payload["run_id"],
         payload["epoch"], event["seq"]),
    )
    db.execute(
        "INSERT INTO phase_attempts("
        "attempt_id,task_id,task_attempt,execution_generation,role,principal_id,authority_domain,"
        "binding_id,lease_resource,lease_token,run_id,epoch,state,recovery_from,"
        "version,created_event_seq,updated_event_seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (payload["attempt_id"], payload["task_id"], payload["task_attempt"],
         payload["execution_generation"], payload["role"], payload["principal_id"],
         payload["authority_domain"],
         payload["binding_id"], payload["resource"], payload["token"],
         payload["run_id"], payload["epoch"], "CLAIMED", payload["task_state_before"],
         1, event["seq"], event["seq"]),
    )
    db.execute(
        "INSERT INTO task_specs(attempt_id,task_id,task_attempt,execution_generation,"
        "role,controller_epoch) VALUES(?,?,?,?,?,?)",
        (payload["attempt_id"], payload["task_id"], payload["task_attempt"],
         payload["execution_generation"], payload["role"], payload["epoch"]),
    )
    db.execute(
        "INSERT INTO phase_leases VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (payload["resource"], payload["attempt_id"], payload["task_id"],
         payload["task_attempt"], payload["execution_generation"], payload["role"],
         payload["run_id"],
         payload["principal_id"], payload["authority_domain"],
         payload["account_binding_sha256"], payload["identity_receipt_sha256"],
         payload["binding_id"],
         payload["token"], payload["heartbeat_at"], payload["expires_at"],
         payload["epoch"], 1),
    )
    attempts_expression = "attempts+1" if payload["role"] == "builder" else "attempts"
    cursor = db.execute(
        f"UPDATE tasks SET state=?,attempts={attempts_expression},active_role=?,"
        "version=?,updated_at=? WHERE id=? AND version=? AND state=? AND subject_sha=?",
        (payload["task_state_after"], payload["role"], payload["task_version"],
         event["created_at"], payload["task_id"], payload["expected_task_version"],
         payload["task_state_before"], payload["subject_sha"]),
    )
    if cursor.rowcount != 1 or payload["task_version"] != payload["expected_task_version"] + 1:
        raise DurableStoreError("phase claim task CAS failed")


def _apply_phase_heartbeat_v2(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    payload = _v2_payload(event, {
        "attempt_id", "resource", "token", "run_id", "principal_id", "role",
        "epoch", "expected_lease_version", "lease_version", "heartbeat_at",
        "expires_at",
    })
    _require_hex(payload["attempt_id"], 64, "heartbeat attempt id")
    _require_hex(payload["run_id"], 64, "heartbeat run id")
    _require_identifier(payload["principal_id"], "heartbeat principal")
    _require_role(payload["role"])
    for key in ("token", "epoch", "expected_lease_version", "lease_version"):
        _require_integer(payload[key], f"heartbeat {key}")
    if (not isinstance(payload["resource"], str)
            or not 1 <= len(payload["resource"]) <= 240
            or any(
                isinstance(payload[key], bool)
                or not isinstance(payload[key], (int, float))
                or not math.isfinite(payload[key])
                for key in ("heartbeat_at", "expires_at")
            )):
        raise DurableStoreError("phase heartbeat fields are malformed")
    lease = db.execute(
        "SELECT l.*,b.expires_at AS binding_expires_at,i.expires_at AS identity_expires_at,"
        "a.state AS attempt_state FROM phase_leases l "
        "JOIN consumed_authority_bindings b ON b.binding_id=l.binding_id "
        "JOIN identity_registry i ON i.identity_receipt_sha256=b.identity_receipt_sha256 "
        "JOIN phase_attempts a ON a.attempt_id=l.attempt_id WHERE l.attempt_id=?",
        (payload["attempt_id"],),
    ).fetchone()
    latest_identity = None if lease is None else db.execute(
        "SELECT identity_receipt_sha256 FROM identity_registry "
        "WHERE principal_id=? AND authority_domain=? AND account_binding_sha256=? "
        "ORDER BY generation DESC,registered_event_seq DESC LIMIT 1",
        (lease["principal_id"], lease["authority_domain"],
         lease["account_binding_sha256"]),
    ).fetchone()
    if (lease is None or lease["attempt_state"] in {"RECOVERY_REQUIRED", "RECOVERED"}
            or latest_identity is None
            or latest_identity[0] != lease["identity_receipt_sha256"]
            or payload["heartbeat_at"] < lease["heartbeat_at"]
            or payload["heartbeat_at"] > event["created_at"]
            or payload["expires_at"] <= payload["heartbeat_at"]
            or payload["expires_at"] > lease["binding_expires_at"]
            or payload["expires_at"] > lease["identity_expires_at"]):
        raise DurableStoreError("phase heartbeat evidence is stale")
    cursor = db.execute(
        "UPDATE phase_leases SET heartbeat_at=?,expires_at=?,version=? "
        "WHERE attempt_id=? AND resource=? AND token=? AND run_id=? "
        "AND principal_id=? AND role=? AND epoch=? AND version=?",
        (payload["heartbeat_at"], payload["expires_at"], payload["lease_version"],
         payload["attempt_id"], payload["resource"], payload["token"],
         payload["run_id"], payload["principal_id"], payload["role"],
         payload["epoch"], payload["expected_lease_version"]),
    )
    if cursor.rowcount != 1 or payload["lease_version"] != payload["expected_lease_version"] + 1:
        raise DurableStoreError("phase heartbeat lease CAS failed")


def _apply_phase_recovered_v2(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    payload = _v2_payload(event, {
        "attempt_id", "task_id", "role", "stale_epoch", "epoch",
        "attempt_state_before",
        "expected_attempt_version", "attempt_version", "expected_task_version",
        "task_version", "task_state_before", "task_state_after",
        "cleanup_evidence_sha256", "cgroup_empty",
    })
    if payload["cgroup_empty"] is not True:
        raise DurableStoreError("phase recovery requires cgroup-empty evidence")
    _require_hex(payload["cleanup_evidence_sha256"], 64, "cleanup evidence digest")
    _require_hex(payload["attempt_id"], 64, "recovery attempt id")
    _require_identifier(payload["task_id"], "recovery task id")
    _require_role(payload["role"])
    for key in (
        "stale_epoch", "epoch", "expected_attempt_version", "attempt_version",
        "expected_task_version", "task_version",
    ):
        _require_integer(payload[key], f"phase recovery {key}")
    attempt = db.execute(
        "SELECT a.*,t.state AS task_state,t.version AS task_version,"
        "c.recovery_required,c.epoch AS campaign_epoch FROM phase_attempts a "
        "JOIN tasks t ON t.id=a.task_id JOIN campaigns c ON c.id=t.campaign_id "
        "WHERE a.attempt_id=?", (payload["attempt_id"],),
    ).fetchone()
    lease = db.execute(
        "SELECT * FROM phase_leases WHERE attempt_id=?", (payload["attempt_id"],)
    ).fetchone()
    unit = db.execute(
        "SELECT state,cgroup_empty FROM attempt_units WHERE attempt_id=?",
        (payload["attempt_id"],),
    ).fetchone()
    if (attempt is None or lease is None or attempt["role"] == "integrator"
            or attempt["state"] != "RECOVERY_REQUIRED"
            or payload["attempt_state_before"] != "RECOVERY_REQUIRED"
            or attempt["epoch"] != payload["stale_epoch"]
            or attempt["epoch"] >= payload["epoch"]
            or attempt["version"] != payload["expected_attempt_version"]
            or attempt["task_id"] != payload["task_id"]
            or attempt["role"] != payload["role"]
            or attempt["task_state"] != payload["task_state_before"]
            or attempt["task_version"] != payload["expected_task_version"]
            or attempt["recovery_from"] != payload["task_state_after"]
            or attempt["recovery_required"] != 1
            or attempt["campaign_epoch"] != payload["epoch"]
            or (attempt["interrupted_state"] in {
                "LAUNCH_PREPARED", "RUNNING", "STOPPING", "EXITED",
            } and unit is None)
            or (unit is not None and not (
                unit["state"] == "STOPPED" and unit["cgroup_empty"] == 1
            ))):
        raise DurableStoreError("phase recovery event bindings are stale")
    retired = db.execute(
        "DELETE FROM phase_leases WHERE attempt_id=?", (payload["attempt_id"],)
    )
    if retired.rowcount != 1:
        raise DurableStoreError("phase recovery lease is missing")
    cursor = db.execute(
        "UPDATE phase_attempts SET state='RECOVERED',interrupted_state=NULL,"
        "version=?,updated_event_seq=? WHERE attempt_id=? AND version=? AND epoch=? "
        "AND state=?",
        (payload["attempt_version"], event["seq"], payload["attempt_id"],
         payload["expected_attempt_version"], payload["stale_epoch"],
         payload["attempt_state_before"]),
    )
    if cursor.rowcount != 1 or payload["attempt_version"] != payload["expected_attempt_version"] + 1:
        raise DurableStoreError("phase recovery attempt CAS failed")
    cursor = db.execute(
        "UPDATE tasks SET state=?,active_role=?,recovery_from=?,version=?,updated_at=? "
        "WHERE id=? AND version=? AND state=?",
        (payload["task_state_after"], None, payload["task_state_before"],
         payload["task_version"], event["created_at"], payload["task_id"],
         payload["expected_task_version"], payload["task_state_before"]),
    )
    if cursor.rowcount != 1 or payload["task_version"] != payload["expected_task_version"] + 1:
        raise DurableStoreError("phase recovery task CAS failed")


def _apply_phase_result_v2(db: sqlite3.Connection, event: Mapping[str, object]) -> None:
    payload = _v2_payload(event, {
        "receipt_id", "attempt_id", "task_id", "task_attempt",
        "execution_generation", "phase", "role",
        "principal_id", "authority_domain", "verdict", "subject_sha", "base_sha",
        "result_sha", "evidence_sha256", "cleanup_evidence_sha256", "cgroup_empty",
        "identity_receipt_sha256", "account_binding_sha256", "task_spec_sha256",
        "instruction_sha256", "instruction_bytes",
        "instruction_materialization_sha256", "instruction_materialization_bytes",
        "instruction_transport_sha256", "instruction_transport_bytes",
        "unit_identity_sha256", "cpu_usage_ns", "memory_peak_bytes", "tasks_peak",
        "oom_count", "oom_killed", "systemd_service_result",
        "systemd_exec_code", "systemd_exec_status", "resource_outcome_sha256",
        "resource", "token", "run_id", "binding_id",
        "epoch", "expected_task_version", "task_version", "task_state_before",
        "task_state_after", "expected_attempt_version", "attempt_version",
    })
    if payload["cgroup_empty"] is not True:
        raise DurableStoreError("phase result requires cgroup-empty evidence")
    for key, length, label in (
        ("receipt_id", 64, "phase receipt id"),
        ("attempt_id", 64, "phase attempt id"),
        ("subject_sha", 40, "result subject SHA"),
        ("base_sha", 40, "result base SHA"),
        ("result_sha", 40, "result SHA"),
        ("evidence_sha256", 64, "result evidence digest"),
        ("cleanup_evidence_sha256", 64, "cleanup evidence digest"),
        ("identity_receipt_sha256", 64, "identity receipt digest"),
        ("account_binding_sha256", 64, "account binding digest"),
        ("task_spec_sha256", 64, "task spec digest"),
        ("instruction_sha256", 64, "instruction digest"),
        ("instruction_materialization_sha256", 64,
         "instruction materialization digest"),
        ("instruction_transport_sha256", 64, "instruction transport digest"),
        ("unit_identity_sha256", 64, "unit identity digest"),
        ("resource_outcome_sha256", 64, "resource outcome digest"),
        ("run_id", 64, "phase run id"),
        ("binding_id", 64, "authority binding id"),
    ):
        _require_hex(payload[key], length, label)
    _require_identifier(payload["task_id"], "result task id")
    _require_identifier(payload["principal_id"], "result principal")
    _require_identifier(payload["authority_domain"], "result authority domain")
    _require_role(payload["role"])
    if payload["phase"] != payload["role"] or payload["verdict"] not in {"PASS", "FAIL"}:
        raise DurableStoreError("phase result role or verdict is invalid")
    for key in (
        "task_attempt", "execution_generation", "token", "epoch",
        "expected_task_version", "task_version", "expected_attempt_version",
        "attempt_version",
    ):
        _require_integer(payload[key], f"phase result {key}")
    if (not isinstance(payload["resource"], str)
            or not 1 <= len(payload["resource"]) <= 240):
        raise DurableStoreError("phase result resource is invalid")
    instruction_lengths = (
        payload["instruction_bytes"], payload["instruction_materialization_bytes"],
        payload["instruction_transport_bytes"],
    )
    if (any(isinstance(value, bool) or not isinstance(value, int)
            or not 1 <= value <= 1048576 for value in instruction_lengths)
            or payload["instruction_materialization_sha256"]
            != payload["instruction_sha256"]
            or payload["instruction_transport_sha256"]
            != payload["instruction_sha256"]
            or payload["instruction_materialization_bytes"]
            != payload["instruction_bytes"]
            or payload["instruction_transport_bytes"] != payload["instruction_bytes"]):
        raise DurableStoreError("result instruction evidence is invalid")
    for key, maximum in (
        ("cpu_usage_ns", 9223372036854775807),
        ("memory_peak_bytes", 9223372036854775807),
        ("tasks_peak", 1000000), ("oom_count", 2147483647),
        ("systemd_exec_status", 255),
    ):
        value = payload[key]
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
            raise DurableStoreError(f"result {key} is invalid")
    if (not isinstance(payload["oom_killed"], bool)
            or (payload["oom_killed"] and payload["oom_count"] == 0)
            or payload["systemd_service_result"] not in {
                "success", "exit-code", "signal", "core-dump", "watchdog",
                "start-limit-hit", "resources", "timeout", "oom-kill", "protocol",
            }
            or isinstance(payload["systemd_exec_code"], bool)
            or payload["systemd_exec_code"] not in {1, 2, 3}):
        raise DurableStoreError("result systemd resource evidence is invalid")
    lease = db.execute(
        "SELECT * FROM phase_leases WHERE attempt_id=?", (payload["attempt_id"],)
    ).fetchone()
    attempt = db.execute(
        "SELECT * FROM phase_attempts WHERE attempt_id=?", (payload["attempt_id"],)
    ).fetchone()
    task = db.execute(
        "SELECT * FROM tasks WHERE id=?", (payload["task_id"],)
    ).fetchone()
    binding = db.execute(
        "SELECT * FROM consumed_authority_bindings WHERE binding_id=?",
        (payload["binding_id"],),
    ).fetchone()
    spec = db.execute(
        "SELECT * FROM task_specs WHERE attempt_id=?", (payload["attempt_id"],)
    ).fetchone()
    unit = db.execute(
        "SELECT * FROM attempt_units WHERE attempt_id=?", (payload["attempt_id"],)
    ).fetchone()
    latest_identity = None if binding is None else db.execute(
        "SELECT identity_receipt_sha256 FROM identity_registry "
        "WHERE principal_id=? AND authority_domain=? AND account_binding_sha256=? "
        "ORDER BY generation DESC,registered_event_seq DESC LIMIT 1",
        (binding["principal_id"], binding["authority_domain"],
         binding["account_binding_sha256"]),
    ).fetchone()
    expected_task_state = {
        "builder": "RUNNING", "verifier": "VERIFYING",
        "spec-reviewer": "REVIEWING", "regression-reviewer": "REVIEWING",
        "independent-reviewer": "REVIEWING", "integrator": "INTEGRATING",
        "post-merge-verifier": "POST_MERGE_VERIFYING",
    }.get(payload["role"])
    passed: tuple[str, ...] = ()
    if payload["role"] in REVIEW_ROLES:
        passed = tuple(sorted(
            row[0] for row in db.execute(
                "SELECT role FROM phase_receipts WHERE task_id=? AND task_attempt=? "
                "AND verdict='PASS' AND role IN "
                "('spec-reviewer','regression-reviewer','independent-reviewer')",
                (payload["task_id"], payload["task_attempt"]),
            )
        ))
    expected_state_after = phase_result_transition(
        payload["role"], payload["verdict"], passed,
    )
    expected_receipt = _sha256(_canonical([
        "phase-result-v2", payload["attempt_id"], payload["verdict"],
        event["seq"], payload["evidence_sha256"], payload["task_spec_sha256"],
        payload["instruction_sha256"], payload["resource_outcome_sha256"],
    ]))
    unit_hash_fields = (
        "launch_intent_sha256", "argv_sha256", "bwrap_sha256",
        "executable_sha256", "requested_properties_sha256",
        "observed_unit_sha256", "effective_properties_sha256",
        "cgroup_identity_sha256", "stdout_observed_sha256",
        "stdout_retained_sha256", "stderr_observed_sha256",
        "stderr_retained_sha256", "instruction_materialization_sha256",
        "instruction_transport_sha256", "resource_outcome_sha256",
    )
    expected_lease = {
        "resource": payload["resource"], "attempt_id": payload["attempt_id"],
        "task_id": payload["task_id"], "task_attempt": payload["task_attempt"],
        "execution_generation": payload["execution_generation"],
        "role": payload["role"], "run_id": payload["run_id"],
        "principal_id": payload["principal_id"],
        "authority_domain": payload["authority_domain"],
        "account_binding_sha256": payload["account_binding_sha256"],
        "identity_receipt_sha256": payload["identity_receipt_sha256"],
        "binding_id": payload["binding_id"], "token": payload["token"],
        "epoch": payload["epoch"],
    }
    expected_unit = {
        "task_id": payload["task_id"],
        "task_attempt": payload["task_attempt"],
        "execution_generation": payload["execution_generation"],
        "role": payload["role"], "binding_id": payload["binding_id"],
        "principal_id": payload["principal_id"],
        "authority_domain": payload["authority_domain"],
        "account_binding_sha256": payload["account_binding_sha256"],
        "identity_receipt_sha256": payload["identity_receipt_sha256"],
        "task_spec_sha256": payload["task_spec_sha256"],
        "instruction_sha256": payload["instruction_sha256"],
        "instruction_bytes": payload["instruction_bytes"],
        "instruction_materialization_sha256":
            payload["instruction_materialization_sha256"],
        "instruction_materialization_bytes":
            payload["instruction_materialization_bytes"],
        "instruction_transport_sha256": payload["instruction_transport_sha256"],
        "instruction_transport_bytes": payload["instruction_transport_bytes"],
        "cpu_usage_ns": payload["cpu_usage_ns"],
        "memory_peak_bytes": payload["memory_peak_bytes"],
        "tasks_peak": payload["tasks_peak"], "oom_count": payload["oom_count"],
        "oom_killed": payload["oom_killed"],
        "systemd_service_result": payload["systemd_service_result"],
        "systemd_exec_code": payload["systemd_exec_code"],
        "systemd_exec_status": payload["systemd_exec_status"],
        "resource_outcome_sha256": payload["resource_outcome_sha256"],
    }
    if (lease is None or attempt is None or task is None or binding is None
            or spec is None or unit is None or payload["receipt_id"] != expected_receipt
            or payload["phase"] != payload["role"]
            or payload["task_state_before"] != expected_task_state
            or payload["task_state_after"] != expected_state_after
            or task["state"] != expected_task_state
            or task["version"] != payload["expected_task_version"]
            or payload["task_version"] != payload["expected_task_version"] + 1
            or task["subject_sha"] != payload["subject_sha"]
            or task["base_sha"] != payload["base_sha"]
            or attempt["state"] != "EXITED"
            or attempt["version"] != payload["expected_attempt_version"]
            or payload["attempt_version"] != payload["expected_attempt_version"] + 1
            or attempt["task_id"] != payload["task_id"]
            or attempt["task_attempt"] != payload["task_attempt"]
            or attempt["execution_generation"] != payload["execution_generation"]
            or attempt["role"] != payload["role"]
            or attempt["principal_id"] != payload["principal_id"]
            or attempt["authority_domain"] != payload["authority_domain"]
            or binding["identity_receipt_sha256"] != payload["identity_receipt_sha256"]
            or binding["account_binding_sha256"] != payload["account_binding_sha256"]
            or latest_identity is None
            or latest_identity[0] != payload["identity_receipt_sha256"]
            or any(lease[key] != value for key, value in expected_lease.items())
            or lease["expires_at"] <= event["created_at"]
            or spec["task_spec_sha256"] != payload["task_spec_sha256"]
            or spec["schema_version"] != 2 or spec["controller_epoch"] != payload["epoch"]
            or spec["instruction_sha256"] != payload["instruction_sha256"]
            or spec["instruction_bytes"] != payload["instruction_bytes"]
            or spec["expires_at"] is None or spec["expires_at"] <= event["created_at"]
            or not _trusted_unit_success_evidence(unit)
            or unit["observed_unit_sha256"] != payload["unit_identity_sha256"]
            or any(unit[key] != value for key, value in expected_unit.items())
            or any(
                not isinstance(unit[name], str) or len(unit[name]) != 64
                or any(character not in "0123456789abcdef" for character in unit[name])
                for name in unit_hash_fields
            )
            or (payload["role"] != "builder"
                and payload["result_sha"] != payload["subject_sha"])):
        raise DurableStoreError("phase result event bindings are stale or incomplete")
    cursor = db.execute(
        "DELETE FROM phase_leases WHERE attempt_id=? AND resource=? AND token=? "
        "AND run_id=? AND principal_id=? AND role=? AND epoch=?",
        (payload["attempt_id"], payload["resource"], payload["token"],
         payload["run_id"], payload["principal_id"], payload["role"], payload["epoch"]),
    )
    if cursor.rowcount != 1:
        raise DurableStoreError("phase result lease is stale")
    terminal = "COMPLETED" if payload["verdict"] == "PASS" else "FAILED"
    cursor = db.execute(
        "UPDATE phase_attempts SET state=?,version=?,updated_event_seq=? "
        "WHERE attempt_id=? AND version=? AND state='EXITED'",
        (terminal, payload["attempt_version"], event["seq"], payload["attempt_id"],
         payload["expected_attempt_version"]),
    )
    if cursor.rowcount != 1 or payload["attempt_version"] != payload["expected_attempt_version"] + 1:
        raise DurableStoreError("phase result attempt CAS failed")
    subject_after = (
        payload["result_sha"]
        if payload["role"] == "builder" and payload["verdict"] == "PASS"
        else payload["subject_sha"]
    )
    cursor = db.execute(
        "UPDATE tasks SET state=?,active_role=NULL,subject_sha=?,version=?,updated_at=? "
        "WHERE id=? AND version=? AND state=? AND subject_sha=?",
        (payload["task_state_after"], subject_after, payload["task_version"],
         event["created_at"], payload["task_id"], payload["expected_task_version"],
         payload["task_state_before"], payload["subject_sha"]),
    )
    if cursor.rowcount != 1 or payload["task_version"] != payload["expected_task_version"] + 1:
        raise DurableStoreError("phase result task CAS failed")
    db.execute(
        "INSERT INTO phase_receipts("
        "id,attempt_id,task_id,task_attempt,execution_generation,phase,role,"
        "principal_id,authority_domain,"
        "verdict,subject_sha,base_sha,result_sha,evidence_sha256,cleanup_evidence_sha256,"
        "cgroup_empty,identity_receipt_sha256,account_binding_sha256,task_spec_sha256,"
        "instruction_sha256,instruction_bytes,instruction_materialization_sha256,"
        "instruction_materialization_bytes,instruction_transport_sha256,"
        "instruction_transport_bytes,unit_identity_sha256,cpu_usage_ns,"
        "memory_peak_bytes,tasks_peak,oom_count,oom_killed,systemd_service_result,"
        "systemd_exec_code,systemd_exec_status,resource_outcome_sha256,"
        "lease_resource,lease_token,run_id,binding_id,epoch,"
        "task_version_before,task_version_after,event_seq,authoritative,created_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,"
        "?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (payload["receipt_id"], payload["attempt_id"], payload["task_id"],
         payload["task_attempt"], payload["execution_generation"], payload["phase"],
         payload["role"],
         payload["principal_id"], payload["authority_domain"], payload["verdict"],
         payload["subject_sha"], payload["base_sha"], payload["result_sha"],
         payload["evidence_sha256"], payload["cleanup_evidence_sha256"], 1,
         payload["identity_receipt_sha256"], payload["account_binding_sha256"],
         payload["task_spec_sha256"], payload["instruction_sha256"],
         payload["instruction_bytes"],
         payload["instruction_materialization_sha256"],
         payload["instruction_materialization_bytes"],
         payload["instruction_transport_sha256"],
         payload["instruction_transport_bytes"], payload["unit_identity_sha256"],
         payload["cpu_usage_ns"], payload["memory_peak_bytes"],
         payload["tasks_peak"], payload["oom_count"], payload["oom_killed"],
         payload["systemd_service_result"], payload["systemd_exec_code"],
         payload["systemd_exec_status"], payload["resource_outcome_sha256"],
         payload["resource"], payload["token"], payload["run_id"],
         payload["binding_id"], payload["epoch"], payload["expected_task_version"],
         payload["task_version"], event["seq"], 1, event["created_at"]),
    )


V2_EVENT_APPLIERS = MappingProxyType({
    "controller.epoch.v2": _apply_controller_epoch_v2,
    "identity.registered.v2": _apply_identity_registered_v2,
    "campaign.recovery_cleared.v2": _apply_campaign_recovery_cleared_v2,
    "task.destination_bound.v2": _apply_task_destination_bound_v2,
    "protocol.phase_claimed.v2": _apply_phase_claimed_v2,
    "protocol.phase_heartbeat.v2": _apply_phase_heartbeat_v2,
    "protocol.phase_recovered.v2": _apply_phase_recovered_v2,
    "protocol.phase_result.v2": _apply_phase_result_v2,
})


def _replay_v2(ledger: bytes) -> sqlite3.Connection:
    events = _parse_ledger(ledger, allow_schema_v2=True)
    schema_event = _schema_event(events)
    payload = _validate_schema_payload(schema_event["payload"])
    prefix_description = payload["ledger_prefix"]
    prefix_bytes = prefix_description["bytes"]
    if isinstance(prefix_bytes, bool) or not isinstance(prefix_bytes, int) or prefix_bytes < 0 or prefix_bytes > len(ledger):
        raise DurableStoreError("schema.v2 ledger prefix length is invalid")
    prefix = ledger[:prefix_bytes]
    if _sha256(prefix) != prefix_description["sha256"]:
        raise DurableStoreError("schema.v2 ledger prefix digest is invalid")
    prefix_events = _parse_ledger(prefix, allow_schema_v2=False)
    if (len(prefix_events) != prefix_description["event_count"]
            or (prefix_events[-1]["hash"] if prefix_events else GENESIS) != prefix_description["tip_hash"]
            or schema_event["seq"] != len(prefix_events) + 1):
        raise DurableStoreError("schema.v2 ledger prefix inventory is invalid")
    db = _replay_v1(prefix_events)
    try:
        inventory_sha256, _ = _v1_inventory(db, prefix, prefix_events)
        plan = _disposition_plan(db)
        if inventory_sha256 != payload["v1_inventory_sha256"] or plan != payload["disposition_plan"]:
            raise DurableStoreError("schema.v2 event differs from deterministic v1 inventory")
        report = MigrationPreflight(
            1, "V1_READY", prefix_description["sha256"], prefix_description["bytes"],
            prefix_description["event_count"], prefix_description["tip_hash"],
            payload["v1_inventory_sha256"], payload["disposition_sha256"],
        )
        db.execute("BEGIN IMMEDIATE")
        _apply_v2_ddl(db)
        schema_event_bytes = _canonical(
            {key: value for key, value in schema_event.items() if key != "seq"}
        ) + b"\n"
        _insert_prepared_metadata(
            db, report, plan, schema_event, schema_event_bytes
        )
        db.execute("COMMIT")
        db.execute("BEGIN IMMEDIATE")
        _insert_projected_event(db, schema_event)
        _apply_disposition_plan(
            db, plan, event_created_at=schema_event["created_at"]
        )
        for event in events[schema_event["seq"]:]:
            _insert_projected_event(db, event)
            _apply_registered_v2_event(db, event)
        db.execute("UPDATE schema_metadata SET state='COMMITTED' WHERE singleton=1 AND state='PREPARED'")
        db.execute("COMMIT")
        return db
    except BaseException:
        if db.in_transaction:
            db.execute("ROLLBACK")
        db.close()
        raise


class DurableProtocolStore:
    """Inert handle for explicit migration and deterministic replay operations."""

    def __init__(self, state_dir: str | os.PathLike[str], *,
                 crash_hook: Optional[Callable[[str], None]] = None):
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
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid():
            raise DurableStoreError("state directory must be an owned real directory")
        if stat.S_IMODE(info.st_mode) != 0o700:
            raise DurableStoreError("state directory must be mode-0700")
        root_flags = (
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            self._root_fd = os.open(supplied_root, root_flags)
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
        self.root = canonical_root
        self.db_path = self.root / "state.sqlite3"
        self.wal_path = self.root / "state.sqlite3-wal"
        self.shm_path = self.root / "state.sqlite3-shm"
        self.events_path = self.root / "events.jsonl"
        self.lock_path = self.root / ".writer.lock"
        self.controller_path = self.root / ".controller.lock"
        self._crash_hook = crash_hook
        try:
            self._handle_process_identity = _linux_process_identity()
        except BaseException:
            os.close(self._root_fd)
            raise
        self._controller_fd: Optional[int] = None
        self.claimed_epoch: Optional[int] = None
        self._controller_guard = threading.RLock()
        self._closed = False
        try:
            for name, label in (
                ("state.sqlite3", "projection database"),
                ("state.sqlite3-wal", "projection WAL"),
                ("state.sqlite3-shm", "projection SHM"),
                ("events.jsonl", "ledger"),
                (".writer.lock", "writer lock"),
                (".controller.lock", "controller lock"),
            ):
                self._named_file_identity(name, required=False, label=label)
        except BaseException:
            os.close(self._root_fd)
            self._closed = True
            raise

    def __enter__(self) -> "DurableProtocolStore":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        self.release_controller()
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
        if _linux_process_identity() != self._handle_process_identity:
            raise DurableStoreError("durable store handle belongs to a different process")
        try:
            held = os.fstat(self._root_fd)
            current = os.lstat(self.root)
        except OSError as exc:
            raise DurableStoreError("state directory path was replaced or removed") from exc
        if (not stat.S_ISDIR(held.st_mode) or held.st_uid != os.geteuid()
                or stat.S_IMODE(held.st_mode) != 0o700
                or not stat.S_ISDIR(current.st_mode) or stat.S_ISLNK(current.st_mode)
                or current.st_uid != os.geteuid()
                or stat.S_IMODE(current.st_mode) != 0o700
                or (held.st_dev, held.st_ino) != self._root_identity
                or (current.st_dev, current.st_ino) != self._root_identity):
            raise DurableStoreError("state directory path was replaced or is not mode-0700")

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
            info = os.stat(
                name, dir_fd=self._root_fd, follow_symlinks=False,
            )
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
        safe_flags = flags | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(name, safe_flags, dir_fd=self._root_fd)
        except OSError as exc:
            raise DurableStoreError(f"{label} cannot be opened safely") from exc
        try:
            held = self._private_file_identity(os.fstat(fd), label)
            if ((held.device, held.inode, held.size)
                    != (before.device, before.inode, before.size)):
                raise DurableStoreError(f"{label} changed while being opened")
            self._assert_named_identity(
                name, held, label=label, expected_size=held.size,
            )
            return fd, held
        except BaseException:
            os.close(fd)
            raise

    def _crash(self, stage: str, override: Optional[Callable[[str], None]]) -> None:
        hook = override if override is not None else self._crash_hook
        if hook is not None:
            hook(stage)

    def _validate_writable_state_files(self) -> None:
        self._named_file_identity(
            "state.sqlite3", required=True, label="projection database",
        )
        self._named_file_identity(
            "state.sqlite3-wal", required=False, label="projection WAL",
        )
        self._named_file_identity(
            "state.sqlite3-shm", required=False, label="projection SHM",
        )
        self._named_file_identity("events.jsonl", required=False, label="ledger")
        self._named_file_identity(
            ".controller.lock", required=True, label="controller lock",
        )
        self._named_file_identity(
            ".writer.lock", required=True, label="writer lock",
        )

    def _validate_controller_lock_identity(self, fd: Optional[int] = None) -> None:
        if _linux_process_identity() != self._handle_process_identity:
            raise DurableStoreError("controller handle belongs to a different process")
        held_fd = self._controller_fd if fd is None else fd
        if held_fd is None:
            raise DurableStoreError("controller claim required")
        try:
            held = self._private_file_identity(
                os.fstat(held_fd), "controller lock",
            )
        except OSError as exc:
            raise DurableStoreError("controller lock path was replaced or removed") from exc
        self._assert_named_identity(
            ".controller.lock", held, label="controller lock",
            expected_size=held.size,
        )
        try:
            fcntl.flock(held_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise DurableStoreError("controller lock ownership was lost") from exc

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
                raise DurableStoreError("controller is active; migration requires quiescence") from exc
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
        fd, opened = self._open_named_file(
            "events.jsonl",
            os.O_RDONLY | getattr(os, "O_NOATIME", 0),
            label="ledger",
        )
        try:
            chunks = []
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            data = b"".join(chunks)
            held_after = self._private_file_identity(os.fstat(fd), "ledger")
            if (held_after != opened or len(data) != opened.size):
                raise DurableStoreError("ledger changed while being read")
            self._assert_named_identity(
                "events.jsonl", opened, label="ledger",
                expected_size=opened.size,
            )
            return _LedgerSnapshot(data, opened)
        finally:
            os.close(fd)

    def _assert_ledger_snapshot(self, expected: _LedgerSnapshot) -> None:
        observed = self._read_ledger()
        if observed != expected:
            raise DurableStoreError("ledger inode, length, or content hash changed")

    @staticmethod
    def _runtime_event(
        ledger: bytes, events: list[dict], event_type: str, payload: dict,
    ) -> tuple[dict, bytes]:
        if event_type not in V2_EVENT_APPLIERS:
            raise DurableStoreError("runtime event type is not registered")
        _schema_event(events)
        created_at = time.time()
        previous = events[-1]["hash"]
        raw = _raw_event(previous, event_type, payload, created_at)
        event = {
            "prev": previous, "hash": _sha256(raw.encode()), "type": event_type,
            "payload": payload, "created_at": created_at, "seq": len(events) + 1,
        }
        encoded = _canonical({key: value for key, value in event.items() if key != "seq"}) + b"\n"
        if _sha256(ledger) == _sha256(ledger + encoded):
            raise DurableStoreError("runtime event encoding is empty")
        return event, encoded

    @staticmethod
    def _runtime_intent_event(row: sqlite3.Row) -> tuple[dict, bytes]:
        stored = row["event_bytes"]
        if isinstance(stored, memoryview):
            stored = stored.tobytes()
        if (not isinstance(stored, bytes) or not stored.endswith(b"\n")
                or b"\n" in stored[:-1] or _sha256(stored) != row["event_bytes_sha256"]):
            raise DurableStoreError("runtime append intent bytes are malformed")
        try:
            decoded = json.loads(stored[:-1].decode("ascii"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise DurableStoreError("runtime append intent bytes are not canonical JSON") from exc
        if (not isinstance(decoded, dict) or set(decoded) != {
                "prev", "hash", "type", "payload", "created_at"
        } or _canonical(decoded) + b"\n" != stored):
            raise DurableStoreError("runtime append intent envelope is not canonical")
        if (decoded["type"] != row["event_type"]
                or decoded["hash"] != row["event_hash"]
                or decoded["created_at"] != row["event_created_at"]
                or decoded["prev"] != row["ledger_prefix_tip_hash"]
                or row["event_seq"] != row["ledger_prefix_seq"] + 1
                or decoded["type"] not in V2_EVENT_APPLIERS):
            raise DurableStoreError("runtime append intent binding is inconsistent")
        if (not isinstance(decoded["payload"], dict)
                or isinstance(decoded["created_at"], bool)
                or not isinstance(decoded["created_at"], (int, float))
                or not math.isfinite(decoded["created_at"])):
            raise DurableStoreError("runtime append intent fields are invalid")
        expected_hash = _sha256(
            _raw_event(
                decoded["prev"], decoded["type"], decoded["payload"],
                decoded["created_at"],
            ).encode()
        )
        if decoded["hash"] != expected_hash:
            raise DurableStoreError("runtime append intent event hash is invalid")
        decoded = dict(decoded)
        decoded["seq"] = row["event_seq"]
        return decoded, stored

    @staticmethod
    def _assert_projection_equivalent(
        db: sqlite3.Connection, ledger: bytes, *, ignore_runtime_intent: bool = False,
    ) -> list[dict]:
        events = _parse_ledger(ledger, allow_schema_v2=True)
        _schema_event(events)
        replay = _replay_v2(ledger)
        try:
            actual = _v2_projection_digest(
                db, ignore_runtime_intent=ignore_runtime_intent
            )
            expected = _v2_projection_digest(replay)
        finally:
            replay.close()
        if actual != expected:
            raise DurableStoreError("runtime projection differs from deterministic replay")
        return events

    @staticmethod
    def _persist_runtime_intent(
        db: sqlite3.Connection, ledger: bytes, events: list[dict], event: dict,
        encoded: bytes, prepared_epoch: int,
    ) -> None:
        if db.execute("SELECT 1 FROM runtime_append_intent").fetchone() is not None:
            raise DurableStoreError("runtime append intent is already prepared")
        db.execute("BEGIN IMMEDIATE")
        try:
            db.execute(
                "INSERT INTO runtime_append_intent("
                "singleton,state,event_type,event_seq,event_hash,event_created_at,"
                "event_bytes,event_bytes_sha256,ledger_prefix_bytes,"
                "ledger_prefix_sha256,ledger_prefix_tip_hash,ledger_prefix_seq,"
                "prepared_epoch) VALUES(1,'PREPARED',?,?,?,?,?,?,?,?,?,?,?)",
                (event["type"], event["seq"], event["hash"], event["created_at"],
                 sqlite3.Binary(encoded), _sha256(encoded), len(ledger),
                 _sha256(ledger), events[-1]["hash"], len(events), prepared_epoch),
            )
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise

    def _append_prepared_runtime_bytes(
        self, snapshot: _LedgerSnapshot, row: sqlite3.Row, encoded: bytes,
        crash_hook: Optional[Callable[[str], None]],
        writer_identity: _FileIdentity, db_identity: _FileIdentity,
        controller_fd: int,
    ) -> _LedgerSnapshot:
        ledger = snapshot.data
        prefix_bytes = row["ledger_prefix_bytes"]
        if (isinstance(prefix_bytes, bool) or not isinstance(prefix_bytes, int)
                or prefix_bytes < 0 or len(ledger) < prefix_bytes
                or _sha256(ledger[:prefix_bytes]) != row["ledger_prefix_sha256"]):
            raise DurableStoreError("runtime ledger prefix diverges from append intent")
        tail = ledger[prefix_bytes:]
        if len(tail) > len(encoded) or not encoded.startswith(tail):
            raise DurableStoreError("runtime ledger has a divergent append-intent tail")
        self._crash("before_runtime_append", crash_hook)
        self._validate_controller_lock_identity(controller_fd)
        self._validate_root_identity()
        self._assert_named_identity(
            ".writer.lock", writer_identity, label="writer lock",
            expected_size=writer_identity.size,
        )
        self._assert_named_identity(
            "state.sqlite3", db_identity, label="projection database",
        )
        if snapshot.identity is None:
            raise DurableStoreError("runtime ledger is required")
        remainder = encoded[len(tail):]
        fd, opened = self._open_named_file(
            "events.jsonl", os.O_RDWR | os.O_APPEND, label="ledger",
        )
        if opened != snapshot.identity:
            os.close(fd)
            raise DurableStoreError("runtime ledger path was replaced or changed")
        try:
            current = bytearray()
            offset = 0
            while offset < opened.size:
                chunk = os.pread(fd, min(1024 * 1024, opened.size - offset), offset)
                if not chunk:
                    raise DurableStoreError("runtime ledger changed before append")
                current.extend(chunk)
                offset += len(chunk)
            if bytes(current) != ledger:
                raise DurableStoreError("runtime ledger content changed before append")
            if remainder:
                boundary = max(1, len(remainder) // 2)
                offset = 0
                while offset < boundary:
                    offset += os.write(fd, remainder[offset:boundary])
                self._crash("during_runtime_ledger_append", crash_hook)
                while offset < len(remainder):
                    offset += os.write(fd, remainder[offset:])
            os.fsync(fd)
            completed = self._private_file_identity(os.fstat(fd), "ledger")
            expected_size = len(ledger) + len(remainder)
            if ((completed.device, completed.inode)
                    != (opened.device, opened.inode)
                    or completed.size != expected_size):
                raise DurableStoreError("runtime ledger changed during append")
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
        self._assert_named_identity(
            "events.jsonl", completed, label="ledger",
            expected_size=completed.size,
        )
        completed_data = ledger[:prefix_bytes] + encoded
        completed_snapshot = _LedgerSnapshot(completed_data, completed)
        self._crash("after_runtime_ledger_fsync", crash_hook)
        self._validate_controller_lock_identity(controller_fd)
        self._assert_ledger_snapshot(completed_snapshot)
        return completed_snapshot

    def _complete_runtime_intent(
        self, db: sqlite3.Connection, snapshot: _LedgerSnapshot,
        writer_identity: _FileIdentity, db_identity: _FileIdentity,
        controller_fd: int,
        crash_hook: Optional[Callable[[str], None]] = None,
    ) -> tuple[dict, _LedgerSnapshot]:
        ledger = snapshot.data
        rows = db.execute(
            "SELECT * FROM runtime_append_intent ORDER BY singleton"
        ).fetchall()
        if len(rows) != 1 or rows[0]["singleton"] != 1 or rows[0]["state"] != "PREPARED":
            raise DurableStoreError("runtime append intent is missing or ambiguous")
        row = rows[0]
        for name in ("event_seq", "ledger_prefix_bytes", "ledger_prefix_seq", "prepared_epoch"):
            value = row[name]
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise DurableStoreError("runtime append intent counters are invalid")
        if row["event_seq"] <= 0 or row["prepared_epoch"] <= 0:
            raise DurableStoreError("runtime append intent counters are invalid")
        _require_hex(row["event_hash"], 64, "runtime intent event hash")
        _require_hex(row["event_bytes_sha256"], 64, "runtime intent bytes digest")
        _require_hex(row["ledger_prefix_sha256"], 64, "runtime intent prefix digest")
        _require_hex(row["ledger_prefix_tip_hash"], 64, "runtime intent prefix tip")
        event, encoded = self._runtime_intent_event(row)
        prefix_bytes = row["ledger_prefix_bytes"]
        if len(ledger) < prefix_bytes:
            raise DurableStoreError("runtime ledger prefix diverges from append intent")
        prefix = ledger[:prefix_bytes]
        prefix_events = self._assert_projection_equivalent(
            db, prefix, ignore_runtime_intent=True,
        )
        if (len(prefix_events) != row["ledger_prefix_seq"]
                or prefix_events[-1]["hash"] != row["ledger_prefix_tip_hash"]
                or event["seq"] != len(prefix_events) + 1):
            raise DurableStoreError("runtime append intent prefix inventory diverges")
        controller = db.execute(
            "SELECT value FROM controller WHERE key='epoch'"
        ).fetchone()
        if (isinstance(row["prepared_epoch"], bool)
                or not isinstance(row["prepared_epoch"], int)
                or row["prepared_epoch"] <= 0
                or (
                    event["type"] == "controller.epoch.v2"
                    and event["payload"].get("epoch") != row["prepared_epoch"]
                )
                or (
                    event["type"] != "controller.epoch.v2"
                    and (controller is None or controller[0] != row["prepared_epoch"])
                )):
            raise DurableStoreError("runtime append intent controller epoch diverges")
        completed_snapshot = self._append_prepared_runtime_bytes(
            snapshot, row, encoded, crash_hook, writer_identity, db_identity,
            controller_fd,
        )
        db.execute("BEGIN IMMEDIATE")
        try:
            projected = db.execute(
                "SELECT seq,hash FROM events ORDER BY seq"
            ).fetchall()
            if (len(projected) != len(prefix_events)
                    or any(
                        item["seq"] != prefix_events[index]["seq"]
                        or item["hash"] != prefix_events[index]["hash"]
                        for index, item in enumerate(projected)
                    )):
                raise DurableStoreError("runtime projection changed after intent preparation")
            _insert_projected_event(db, event)
            _apply_registered_v2_event(db, event)
            deleted = db.execute(
                "DELETE FROM runtime_append_intent WHERE singleton=1 AND state='PREPARED' "
                "AND event_hash=? AND event_seq=?",
                (event["hash"], event["seq"]),
            )
            if deleted.rowcount != 1:
                raise DurableStoreError("runtime append intent changed before projection")
            self._crash("before_runtime_projection_commit", crash_hook)
            self._validate_controller_lock_identity(controller_fd)
            self._assert_ledger_snapshot(completed_snapshot)
            self._assert_named_identity(
                ".writer.lock", writer_identity, label="writer lock",
                expected_size=writer_identity.size,
            )
            self._assert_named_identity(
                "state.sqlite3", db_identity, label="projection database",
            )
            db.execute("COMMIT")
        except BaseException:
            if db.in_transaction:
                db.execute("ROLLBACK")
            raise
        return event, completed_snapshot

    def _recover_runtime_intent(
        self, db: sqlite3.Connection, snapshot: _LedgerSnapshot,
        writer_identity: _FileIdentity, db_identity: _FileIdentity,
        controller_fd: int,
    ) -> _LedgerSnapshot:
        count = db.execute("SELECT count(*) FROM runtime_append_intent").fetchone()[0]
        if count == 0:
            return snapshot
        if count != 1:
            raise DurableStoreError("runtime append intent is ambiguous")
        _event, completed = self._complete_runtime_intent(
            db, snapshot, writer_identity, db_identity, controller_fd,
        )
        return completed

    @staticmethod
    def _sync_runtime_tail(db: sqlite3.Connection, ledger: bytes) -> list[dict]:
        _assert_exact_v2_schema(db)
        metadata = _read_metadata(db)
        if metadata["state"] != "COMMITTED":
            raise DurableStoreError("runtime requires a committed v2 store")
        if db.execute("SELECT 1 FROM runtime_append_intent").fetchone() is not None:
            raise DurableStoreError("runtime append intent must be recovered first")
        return DurableProtocolStore._assert_projection_equivalent(db, ledger)

    def _require_controller(self, db: sqlite3.Connection) -> int:
        if self._controller_fd is None or self.claimed_epoch is None:
            raise DurableStoreError("controller claim required")
        self._validate_controller_lock_identity()
        row = db.execute("SELECT value FROM controller WHERE key='epoch'").fetchone()
        if row is None or row[0] != self.claimed_epoch:
            raise DurableStoreError("stale controller epoch")
        return self.claimed_epoch

    def _runtime_mutation(
        self, event_type: str,
        payload_factory: Callable[[sqlite3.Connection, int, list[dict]], dict], *,
        crash_hook: Optional[Callable[[str], None]] = None,
    ) -> tuple[dict, dict]:
        with self._controller_guard:
            self._validate_controller_lock_identity()
            controller_fd = self._controller_fd
            if controller_fd is None:
                raise DurableStoreError("controller claim required")
            with self._lock(exclusive=True) as writer_identity:
                self._validate_writable_state_files()
                snapshot = self._read_ledger()
                with self._writable_db() as (db, db_identity):
                    snapshot = self._recover_runtime_intent(
                        db, snapshot, writer_identity, db_identity, controller_fd,
                    )
                    ledger = snapshot.data
                    events = self._sync_runtime_tail(db, ledger)
                    epoch = self._require_controller(db)
                    db.execute("BEGIN IMMEDIATE")
                    try:
                        payload = payload_factory(db, epoch, events)
                        event, encoded = self._runtime_event(
                            ledger, events, event_type, payload,
                        )
                        _insert_projected_event(db, event)
                        _apply_registered_v2_event(db, event)
                    except BaseException:
                        if db.in_transaction:
                            db.execute("ROLLBACK")
                        raise
                    db.execute("ROLLBACK")
                    self._persist_runtime_intent(
                        db, ledger, events, event, encoded, epoch,
                    )
                    self._complete_runtime_intent(
                        db, snapshot, writer_identity, db_identity, controller_fd,
                        crash_hook,
                    )
        return event, payload

    @staticmethod
    def _copy_regular_fd(source_fd: int, destination: Path) -> None:
        destination_fd = os.open(
            destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600,
        )
        try:
            while True:
                chunk = os.read(source_fd, 1024 * 1024)
                if not chunk:
                    break
                offset = 0
                while offset < len(chunk):
                    offset += os.write(destination_fd, chunk[offset:])
            os.fsync(destination_fd)
        finally:
            os.close(destination_fd)

    @staticmethod
    def _stat_fingerprint(info: os.stat_result) -> tuple[int, int, int, int, int]:
        return (
            info.st_dev, info.st_ino, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns,
        )

    @contextlib.contextmanager
    def _snapshot_db(self) -> Iterator[sqlite3.Connection]:
        names = ("state.sqlite3", "state.sqlite3-wal", "state.sqlite3-shm")
        before = {}
        for name in names:
            identity = self._named_file_identity(
                name, required=name == "state.sqlite3",
                label={
                    "state.sqlite3": "projection database",
                    "state.sqlite3-wal": "projection WAL",
                    "state.sqlite3-shm": "projection SHM",
                }[name],
            )
            if identity is not None:
                info = os.stat(name, dir_fd=self._root_fd, follow_symlinks=False)
                before[name] = self._stat_fingerprint(info)
        with tempfile.TemporaryDirectory(prefix="kizuki-durable-preflight-") as temporary:
            target_root = Path(temporary)
            for name in before:
                label = {
                    "state.sqlite3": "projection database",
                    "state.sqlite3-wal": "projection WAL",
                    "state.sqlite3-shm": "projection SHM",
                }[name]
                fd, identity = self._open_named_file(
                    name, os.O_RDONLY | getattr(os, "O_NOATIME", 0), label=label,
                )
                try:
                    held_before = self._stat_fingerprint(os.fstat(fd))
                    if held_before != before[name]:
                        raise DurableStoreError(
                            "projection DB/WAL/SHM changed before read-only snapshot"
                        )
                    self._copy_regular_fd(fd, target_root / name)
                    held_after = self._stat_fingerprint(os.fstat(fd))
                    if held_after != held_before:
                        raise DurableStoreError(
                            "projection DB/WAL/SHM changed during read-only snapshot"
                        )
                    self._assert_named_identity(
                        name, identity, label=label, expected_size=identity.size,
                    )
                finally:
                    os.close(fd)
            after = {}
            for name in names:
                identity = self._named_file_identity(
                    name, required=name == "state.sqlite3",
                    label={
                        "state.sqlite3": "projection database",
                        "state.sqlite3-wal": "projection WAL",
                        "state.sqlite3-shm": "projection SHM",
                    }[name],
                )
                if identity is not None:
                    after[name] = self._stat_fingerprint(
                        os.stat(name, dir_fd=self._root_fd, follow_symlinks=False)
                    )
            if before != after:
                raise DurableStoreError("projection DB/WAL/SHM changed during read-only snapshot")
            target = target_root / "state.sqlite3"
            try:
                db = sqlite3.connect(target)
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA query_only=ON")
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
        anchored_path = f"/proc/self/fd/{self._root_fd}/state.sqlite3"
        uri = "file:" + quote(anchored_path, safe="/") + "?mode=rw"
        try:
            db = sqlite3.connect(uri, uri=True, isolation_level=None, timeout=30)
            db.row_factory = sqlite3.Row
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA busy_timeout=30000")
        except sqlite3.Error as exc:
            raise DurableStoreError("projection database cannot be opened for explicit migration") from exc
        try:
            after = self._named_file_identity(
                "state.sqlite3", required=True, label="projection database",
            )
            assert after is not None
            if ((before.device, before.inode) != (after.device, after.inode)):
                raise DurableStoreError("projection database changed while opening")
            yield db, before
        finally:
            db.close()
            self._validate_root_identity()
            self._validate_writable_state_files()
            self._assert_named_identity(
                "state.sqlite3", before, label="projection database",
            )

    @staticmethod
    def _v1_report(db: sqlite3.Connection, ledger: bytes,
                   events: list[dict]) -> tuple[MigrationPreflight, dict]:
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
            ledger_tip_hash=events[-1]["hash"] if events else GENESIS,
            v1_inventory_sha256=inventory_sha256,
            disposition_sha256=_sha256(_canonical(plan)),
        )
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
        ledger: bytes, report: MigrationPreflight, metadata: sqlite3.Row, *,
        allow_later_events: bool = False,
    ) -> tuple[dict, bytes, bool]:
        prefix = ledger[:report.ledger_prefix_bytes]
        if (len(prefix) != report.ledger_prefix_bytes
                or _sha256(prefix) != report.ledger_prefix_sha256):
            raise DurableStoreError("schema.v2 did not preserve the exact v1 ledger prefix")
        event, line = _prepared_schema_event(metadata)
        tail = ledger[report.ledger_prefix_bytes:]
        if len(tail) < len(line):
            if not line.startswith(tail):
                raise DurableStoreError("ledger has a divergent partial schema.v2 tail")
            return event, line, False
        if not tail.startswith(line):
            raise DurableStoreError("ledger schema.v2 bytes differ from PREPARED metadata")
        if len(tail) > len(line) and not allow_later_events:
            raise DurableStoreError("PREPARED ledger contains events after schema.v2")
        return event, line, True

    def _append_schema_event(
        self, report: MigrationPreflight, metadata: sqlite3.Row,
        current_snapshot: _LedgerSnapshot, writer_identity: _FileIdentity,
        db_identity: _FileIdentity,
        crash_hook: Optional[Callable[[str], None]],
    ) -> tuple[dict, _LedgerSnapshot]:
        current_ledger = current_snapshot.data
        event, line, complete = self._schema_event_for_prepared(
            current_ledger, report, metadata
        )
        tail = current_ledger[report.ledger_prefix_bytes:]
        remainder = b"" if complete else line[len(tail):]
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
                fd = os.open(
                    "events.jsonl", flags, 0o600, dir_fd=self._root_fd,
                )
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
                raise DurableStoreError("ledger path was replaced before schema.v2 append")
        try:
            current = bytearray()
            offset = 0
            while offset < opened.size:
                chunk = os.pread(fd, min(1024 * 1024, opened.size - offset), offset)
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
                    offset += os.write(fd, remainder[offset:boundary])
                self._crash("during_ledger_append", crash_hook)
                while offset < len(remainder):
                    offset += os.write(fd, remainder[offset:])
            os.fsync(fd)
            completed = self._private_file_identity(os.fstat(fd), "ledger")
            expected_size = len(current_ledger) + len(remainder)
            if ((completed.device, completed.inode)
                    != (opened.device, opened.inode)
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
        with self._lock(exclusive=False):
            ledger = self._read_ledger().data
            with self._snapshot_db() as db:
                table_names = {
                    row[0] for row in db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    )
                }
                if table_names == set(V1_LAYOUT):
                    events = _parse_ledger(ledger, allow_schema_v2=False)
                    report, _ = self._v1_report(db, ledger, events)
                else:
                    _assert_exact_v2_schema(db)
                    metadata = _read_metadata(db)
                    report = self._report_from_metadata(metadata)
                    prefix = ledger[:report.ledger_prefix_bytes]
                    if (_sha256(prefix) != report.ledger_prefix_sha256
                            or len(prefix) != report.ledger_prefix_bytes):
                        raise DurableStoreError("v2 ledger no longer contains its exact v1 prefix")
                    prefix_events = _parse_ledger(prefix, allow_schema_v2=False)
                    if (len(prefix_events) != report.ledger_event_count
                            or (prefix_events[-1]["hash"] if prefix_events else GENESIS) != report.ledger_tip_hash):
                        raise DurableStoreError("v2 ledger prefix inventory changed")
                    plan = json.loads(metadata["disposition_json"])
                    if metadata["state"] == "PREPARED":
                        self._schema_event_for_prepared(ledger, report, metadata)
                        _assert_v1_projection_matches_ledger(db, prefix_events)
                        inventory_sha256, _ = _v1_inventory(db, prefix, prefix_events)
                        if inventory_sha256 != report.v1_inventory_sha256 or _disposition_plan(db) != plan:
                            raise DurableStoreError("PREPARED projection differs from its v1 inventory")
                    else:
                        self._committed_result(db, ledger, metadata)
        return report

    preflight = preflight_migration

    def claim_controller(self) -> int:
        with self._controller_guard:
            if _linux_process_identity() != self._handle_process_identity:
                raise DurableStoreError("controller handle belongs to a different process")
            if self._controller_fd is not None and self.claimed_epoch is not None:
                self._validate_controller_lock_identity()
                return self.claimed_epoch
            fd, controller_identity = self._open_named_file(
                ".controller.lock", os.O_RDWR, label="controller lock",
            )
            locked = False
            try:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as exc:
                    raise DurableStoreError("controller is already claimed") from exc
                locked = True
                self._validate_controller_lock_identity(fd)
                with self._lock(exclusive=True) as writer_identity:
                    self._validate_controller_lock_identity(fd)
                    self._validate_writable_state_files()
                    snapshot = self._read_ledger()
                    with self._writable_db() as (db, db_identity):
                        snapshot = self._recover_runtime_intent(
                            db, snapshot, writer_identity, db_identity, fd,
                        )
                        ledger = snapshot.data
                        events = self._sync_runtime_tail(db, ledger)
                        row = db.execute(
                            "SELECT value FROM controller WHERE key='epoch'"
                        ).fetchone()
                        previous = row[0] if row else 0
                        epoch = previous + 1
                        campaigns = [
                            {
                                "campaign_id": row["id"], "state": row["state"],
                                "expected_epoch": row["epoch"],
                                "expected_version": row["version"],
                                "version": row["version"] + 1,
                            }
                            for row in db.execute(
                                "SELECT id,state,epoch,version FROM campaigns "
                                "WHERE state NOT IN ('ABORTED','RELEASED') ORDER BY id"
                            )
                        ]
                        if any(item["expected_epoch"] != previous for item in campaigns):
                            raise DurableStoreError("nonterminal campaign epoch is inconsistent")
                        attempts = [
                            {
                                "attempt_id": row["attempt_id"], "state": row["state"],
                                "interrupted_state": (
                                    row["interrupted_state"]
                                    if row["state"] == "RECOVERY_REQUIRED"
                                    else row["state"]
                                ),
                                "stale_epoch": row["epoch"],
                                "expected_version": row["version"],
                                "version": row["version"] + 1,
                            }
                            for row in db.execute(
                                "SELECT attempt_id,state,interrupted_state,epoch,version "
                                "FROM phase_attempts WHERE epoch<? AND state IN "
                                "('CLAIMED','SPECIFIED','LAUNCH_PREPARED','RUNNING',"
                                "'STOPPING','EXITED','RECOVERY_REQUIRED') ORDER BY attempt_id",
                                (epoch,),
                            )
                        ]
                        units = [
                            {
                                "attempt_id": row["attempt_id"], "state": row["state"],
                                "recovery_from": (
                                    row["recovery_from"]
                                    if row["state"] == "RECOVERY_REQUIRED"
                                    else row["state"]
                                ),
                                "expected_version": row["version"],
                                "version": row["version"] + 1,
                            }
                            for row in db.execute(
                                "SELECT u.attempt_id,u.state,u.recovery_from,u.version "
                                "FROM attempt_units u JOIN phase_attempts a "
                                "ON a.attempt_id=u.attempt_id WHERE a.epoch<? "
                                "AND u.state<>'STOPPED' ORDER BY u.attempt_id",
                                (epoch,),
                            )
                        ]
                        merge_claims = [
                            {
                                "resource": row["resource"],
                                "stale_epoch": row["epoch"],
                                "expected_generation": row["grant_generation"],
                                "generation": row["grant_generation"] + 1,
                            }
                            for row in db.execute(
                                "SELECT resource,epoch,grant_generation FROM merge_claims "
                                "WHERE status='HELD' AND epoch<? ORDER BY resource", (epoch,)
                            )
                        ]
                        payload = {
                            "epoch": epoch, "previous_epoch": previous,
                            "campaigns": campaigns, "attempts": attempts,
                            "units": units, "merge_claims": merge_claims,
                        }
                        db.execute("BEGIN IMMEDIATE")
                        try:
                            event, encoded = self._runtime_event(
                                ledger, events, "controller.epoch.v2", payload,
                            )
                            _insert_projected_event(db, event)
                            _apply_registered_v2_event(db, event)
                        except BaseException:
                            if db.in_transaction:
                                db.execute("ROLLBACK")
                            raise
                        db.execute("ROLLBACK")
                        self._persist_runtime_intent(
                            db, ledger, events, event, encoded, epoch,
                        )
                        self._complete_runtime_intent(
                            db, snapshot, writer_identity, db_identity,
                            fd, self._crash_hook,
                        )
                self._validate_controller_lock_identity(fd)
                self._assert_named_identity(
                    ".controller.lock", controller_identity,
                    label="controller lock", expected_size=controller_identity.size,
                )
                self._controller_fd = fd
                self.claimed_epoch = epoch
                return self.claimed_epoch
            except BaseException:
                if locked:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)
                raise

    def release_controller(self) -> None:
        with self._controller_guard:
            fd = self._controller_fd
            self._controller_fd = None
            self.claimed_epoch = None
            if fd is not None:
                if _linux_process_identity() == self._handle_process_identity:
                    fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)

    def migrate_v1_to_v2(self, *,
                         crash_hook: Optional[Callable[[str], None]] = None) -> MigrationResult:
        """Explicitly migrate, or idempotently resume, one exact v1 store."""
        with self._controller_quiescent():
            return self._migrate_under_writer(crash_hook)

    def _migrate_under_writer(
        self, crash_hook: Optional[Callable[[str], None]]
    ) -> MigrationResult:
        with self._lock(exclusive=True) as writer_identity:
            self._validate_writable_state_files()
            ledger_snapshot = self._read_ledger()
            ledger = ledger_snapshot.data
            with self._snapshot_db() as inspection:
                inspected_tables = {
                    row[0] for row in inspection.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    )
                }
                starts_as_v1 = inspected_tables == set(V1_LAYOUT)
                if starts_as_v1:
                    events = _parse_ledger(ledger, allow_schema_v2=False)
                    inspected_report, inspected_plan = self._v1_report(
                        inspection, ledger, events
                    )
                else:
                    _assert_exact_v2_schema(inspection)
                    inspected_metadata = _read_metadata(inspection)
                    inspected_report = self._report_from_metadata(inspected_metadata)
                    inspected_plan = json.loads(inspected_metadata["disposition_json"])
                    self._schema_event_for_prepared(
                        ledger, inspected_report, inspected_metadata,
                        allow_later_events=inspected_metadata["state"] == "COMMITTED",
                    )

            # This boundary must precede every writable open. Merely opening a
            # WAL-backed SQLite database read-write may checkpoint its WAL/SHM.
            if starts_as_v1:
                self._crash("before_ddl", crash_hook)

            current_snapshot = self._read_ledger()
            if current_snapshot != ledger_snapshot:
                raise DurableStoreError("ledger changed after read-only migration inspection")
            self._validate_writable_state_files()
            with self._writable_db() as (db, db_identity):
                table_names = {
                    row[0] for row in db.execute(
                        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    )
                }
                if starts_as_v1:
                    if table_names != set(V1_LAYOUT):
                        raise DurableStoreError("projection schema changed after migration inspection")
                    report, plan = self._v1_report(db, ledger, events)
                    if report != inspected_report or plan != inspected_plan:
                        raise DurableStoreError("v1 inventory changed after migration inspection")
                    prepared_event, prepared_event_bytes = _make_schema_event(report, plan)
                    db.execute("BEGIN IMMEDIATE")
                    try:
                        _assert_exact_v1_schema(db)
                        _apply_v2_ddl(db)
                        _insert_prepared_metadata(
                            db, report, plan, prepared_event, prepared_event_bytes
                        )
                        db.execute("COMMIT")
                    except BaseException:
                        if db.in_transaction:
                            db.execute("ROLLBACK")
                        raise
                    self._crash("after_ddl", crash_hook)
                    metadata = _read_metadata(db)
                else:
                    _assert_exact_v2_schema(db)
                    metadata = _read_metadata(db)
                    report = self._report_from_metadata(metadata)
                    plan = json.loads(metadata["disposition_json"])
                    if report != inspected_report or plan != inspected_plan:
                        raise DurableStoreError("v2 recovery state changed after migration inspection")

                if metadata["state"] == "COMMITTED":
                    return self._committed_result(db, ledger, metadata)

                prefix = ledger[:report.ledger_prefix_bytes]
                prefix_events = _parse_ledger(prefix, allow_schema_v2=False)
                if (len(prefix_events) != report.ledger_event_count
                        or (prefix_events[-1]["hash"] if prefix_events else GENESIS) != report.ledger_tip_hash):
                    raise DurableStoreError("PREPARED v1 event inventory changed")
                _assert_v1_projection_matches_ledger(db, prefix_events)
                current_inventory, _ = _v1_inventory(db, prefix, prefix_events)
                current_plan = _disposition_plan(db)
                if current_inventory != report.v1_inventory_sha256 or current_plan != plan:
                    raise DurableStoreError("PREPARED v1 projection changed")

                schema_event, ledger_snapshot = self._append_schema_event(
                    report, metadata, ledger_snapshot, writer_identity,
                    db_identity, crash_hook,
                )
                ledger = ledger_snapshot.data
                self._crash("after_ledger_fsync", crash_hook)
                self._assert_ledger_snapshot(ledger_snapshot)

                db.execute("BEGIN IMMEDIATE")
                try:
                    if db.execute("SELECT 1 FROM events WHERE seq=? OR hash=?", (schema_event["seq"], schema_event["hash"])).fetchone():
                        raise DurableStoreError("schema.v2 is already partially projected")
                    _insert_projected_event(db, schema_event)
                    _apply_disposition_plan(
                        db, plan, event_created_at=schema_event["created_at"]
                    )
                    cursor = db.execute(
                        "UPDATE schema_metadata SET state='COMMITTED' "
                        "WHERE singleton=1 AND schema_version=2 AND state='PREPARED'"
                    )
                    if cursor.rowcount != 1:
                        raise DurableStoreError("migration metadata was not PREPARED")
                    self._crash("before_projection_commit", crash_hook)
                    self._assert_ledger_snapshot(ledger_snapshot)
                    self._assert_named_identity(
                        ".writer.lock", writer_identity, label="writer lock",
                        expected_size=writer_identity.size,
                    )
                    self._assert_named_identity(
                        "state.sqlite3", db_identity, label="projection database",
                    )
                    db.execute("COMMIT")
                except BaseException:
                    if db.in_transaction:
                        db.execute("ROLLBACK")
                    raise
                metadata = _read_metadata(db)
                return self._committed_result(db, ledger, metadata)

    migrate = migrate_v1_to_v2

    @staticmethod
    def _committed_result(db: sqlite3.Connection, ledger: bytes,
                          metadata: sqlite3.Row) -> MigrationResult:
        if metadata["state"] != "COMMITTED":
            raise DurableStoreError("migration is not committed")
        events = _parse_ledger(ledger, allow_schema_v2=True)
        schema_event = _schema_event(events)
        _validate_schema_payload(schema_event["payload"], metadata)
        expected_event, expected_bytes = _prepared_schema_event(metadata)
        if schema_event != expected_event:
            raise DurableStoreError("committed schema.v2 event differs from PREPARED metadata")
        boundary = metadata["ledger_prefix_bytes"]
        if ledger[boundary:boundary + len(expected_bytes)] != expected_bytes:
            raise DurableStoreError("committed ledger lost exact schema.v2 event bytes")
        live_digest = _v2_projection_digest(db)
        replay = _replay_v2(ledger)
        try:
            replay_digest = _v2_projection_digest(replay)
        finally:
            replay.close()
        if live_digest != replay_digest:
            raise DurableStoreError("committed projection differs from deterministic empty-v2 replay")
        return MigrationResult(
            schema_version=2, state="COMMITTED", schema_event_hash=schema_event["hash"],
            schema_event_sequence=schema_event["seq"],
            ledger_prefix_sha256=metadata["ledger_prefix_sha256"],
            ledger_prefix_bytes=metadata["ledger_prefix_bytes"],
            v1_inventory_sha256=metadata["v1_inventory_sha256"],
            disposition_sha256=metadata["disposition_sha256"],
            projection_sha256=live_digest, replay_projection_sha256=replay_digest,
        )

    @staticmethod
    def _task_view(row: sqlite3.Row) -> TaskView:
        return TaskView(
            row["id"], row["state"], row["attempts"], row["version"],
            row["repository"], row["base_sha"], row["pr_number"],
            row["subject_sha"], row["active_role"],
        )

    @staticmethod
    def _attempt_view(row: sqlite3.Row) -> PhaseAttemptView:
        return PhaseAttemptView(
            row["attempt_id"], row["task_id"], row["task_attempt"],
            row["execution_generation"], row["role"],
            row["principal_id"], row["authority_domain"], row["lease_token"],
            row["run_id"], row["epoch"], row["state"], row["version"],
        )

    @staticmethod
    def _claim_state(role: str, current_state: str) -> str:
        return phase_claim_transition(role, current_state)

    @classmethod
    def _authority_request_from_db(
        cls, db: sqlite3.Connection, task_id: str, role: str, epoch: int,
    ) -> PhaseAuthorityRequest:
        row = db.execute(
            "SELECT t.*,c.state AS campaign_state,c.recovery_required,c.epoch AS campaign_epoch "
            "FROM tasks t JOIN campaigns c ON c.id=t.campaign_id WHERE t.id=?",
            (task_id,),
        ).fetchone()
        if row is None:
            raise DurableStoreError("unknown task")
        cls._claim_state(role, row["state"])
        if (row["campaign_state"] != "ACTIVE" or row["recovery_required"] != 0
                or row["campaign_epoch"] != epoch):
            raise DurableStoreError("campaign recovery blocks phase execution")
        if (row["protocol_version"] != 2 or row["repository"] is None
                or row["base_sha"] is None or row["pr_number"] is None
                or row["subject_sha"] is None):
            raise DurableStoreError("task destination is not fully bound")
        task_attempt = row["attempts"] + 1 if role == "builder" else row["attempts"]
        if task_attempt <= 0:
            raise DurableStoreError("phase role requires an existing task attempt")
        generation_row = db.execute(
            "SELECT coalesce(max(execution_generation),0)+1 FROM phase_attempts "
            "WHERE task_id=? AND task_attempt=? AND role=?",
            (task_id, task_attempt, role),
        ).fetchone()
        execution_generation = generation_row[0]
        operation = _sha256(_canonical({
            "kind": "protocol.phase_claim.v2", "task_id": task_id,
            "task_attempt": task_attempt,
            "execution_generation": execution_generation,
            "role": role, "epoch": epoch,
            "repository": row["repository"], "base_sha": row["base_sha"],
            "pr_number": row["pr_number"], "subject_sha": row["subject_sha"],
            "task_version": row["version"],
        }))
        return PhaseAuthorityRequest(
            task_id, task_attempt, execution_generation, role, epoch,
            row["subject_sha"], row["version"], operation,
        )

    def clear_campaign_recovery(
        self, campaign_id: str, *, expected_version: int, evidence_sha256: str,
    ) -> int:
        _require_identifier(campaign_id, "campaign id")
        _require_hex(evidence_sha256, 64, "recovery evidence digest")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int):
            raise DurableStoreError("invalid campaign version")

        def payload(db: sqlite3.Connection, epoch: int, _events: list[dict]) -> dict:
            row = db.execute(
                "SELECT version,recovery_required,state,epoch FROM campaigns WHERE id=?",
                (campaign_id,),
            ).fetchone()
            if (row is None or row["version"] != expected_version
                    or row["recovery_required"] != 1
                    or row["state"] in TERMINAL_CAMPAIGN_STATES
                    or row["epoch"] != epoch):
                raise DurableStoreError("campaign recovery clearance rejected")
            if _campaign_recovery_is_unresolved(db, campaign_id):
                raise DurableStoreError("campaign recovery clearance rejected: unresolved recovery")
            return {
                "campaign_id": campaign_id, "expected_version": expected_version,
                "version": expected_version + 1, "epoch": epoch,
                "evidence_sha256": evidence_sha256,
            }

        self._runtime_mutation("campaign.recovery_cleared.v2", payload)
        return expected_version + 1

    def bind_task_destination(
        self, task_id: str, *, repository: str, base_sha: str, pr_number: int,
        subject_sha: str, expected_version: int,
    ) -> TaskView:
        _require_identifier(task_id, "task id")
        _require_repository(repository)
        _require_hex(base_sha, 40, "base SHA")
        _require_hex(subject_sha, 40, "subject SHA")
        if isinstance(pr_number, bool) or not isinstance(pr_number, int) or pr_number <= 0:
            raise DurableStoreError("invalid PR number")
        if isinstance(expected_version, bool) or not isinstance(expected_version, int):
            raise DurableStoreError("invalid task version")

        def payload(db: sqlite3.Connection, epoch: int, _events: list[dict]) -> dict:
            row = db.execute(
                "SELECT t.*,c.state AS campaign_state,c.recovery_required,"
                "c.epoch AS campaign_epoch FROM tasks t JOIN campaigns c "
                "ON c.id=t.campaign_id WHERE t.id=?", (task_id,)
            ).fetchone()
            if (row is None or row["version"] != expected_version
                    or row["state"] != "READY" or row["campaign_state"] != "ACTIVE"
                    or row["recovery_required"] != 0 or row["campaign_epoch"] != epoch
                    or any(row[name] is not None for name in (
                        "repository", "base_sha", "pr_number", "protocol_version",
                        "subject_sha", "merge_sha", "active_role",
                    ))):
                raise DurableStoreError(
                    "task destination rejected by campaign recovery or stale binding"
                )
            return {
                "task_id": task_id, "repository": repository, "base_sha": base_sha,
                "pr_number": pr_number, "subject_sha": subject_sha,
                "protocol_version": 2, "expected_version": expected_version,
                "version": expected_version + 1, "epoch": epoch,
            }

        self._runtime_mutation("task.destination_bound.v2", payload)
        return self.task(task_id)

    def register_identity(
        self, manifest: IdentityManifest, receipt: IdentityReceipt,
    ) -> IdentityRegistration:
        if not isinstance(manifest, IdentityManifest) or not isinstance(receipt, IdentityReceipt):
            raise DurableStoreError("identity manifest and receipt are required")
        now = time.time()
        if not receipt_is_current(manifest, receipt, now):
            raise DurableStoreError("identity receipt is not current")
        manifest_sha256 = _identity_manifest_sha256(manifest)
        receipt_sha256 = _identity_receipt_sha256(receipt)
        lineage_id = _identity_lineage_id(
            manifest.principal_id, manifest.authority_domain,
            manifest.account_binding_sha256,
        )

        def payload(db: sqlite3.Connection, epoch: int, _events: list[dict]) -> dict:
            if db.execute(
                "SELECT 1 FROM identity_registry WHERE identity_receipt_sha256=?",
                (receipt_sha256,),
            ).fetchone():
                raise DurableStoreError("identity receipt is already registered")
            lineage_rows = db.execute(
                "SELECT * FROM identity_lineages WHERE principal_id=? "
                "OR authority_domain=? OR account_binding_sha256=? ORDER BY lineage_id",
                (manifest.principal_id, manifest.authority_domain,
                 manifest.account_binding_sha256),
            ).fetchall()
            if len(lineage_rows) > 1 or (lineage_rows and any(
                lineage_rows[0][key] != expected for key, expected in (
                    ("lineage_id", lineage_id),
                    ("principal_id", manifest.principal_id),
                    ("authority_domain", manifest.authority_domain),
                    ("account_binding_sha256", manifest.account_binding_sha256),
                )
            )):
                raise DurableStoreError("identity lineage alias is rejected")
            latest_generation = db.execute(
                "SELECT max(generation) FROM identity_registry WHERE lineage_id=?",
                (lineage_id,),
            ).fetchone()[0]
            if latest_generation is not None and manifest.generation <= latest_generation:
                raise DurableStoreError("identity generation is not monotonic")
            superseded_attempts = [
                {
                    "attempt_id": row["attempt_id"], "state": row["state"],
                    "expected_version": row["version"],
                    "version": row["version"] + 1,
                }
                for row in db.execute(
                    "SELECT DISTINCT a.attempt_id,a.state,a.version "
                    "FROM phase_attempts a JOIN consumed_authority_bindings b "
                    "ON b.binding_id=a.binding_id WHERE a.state IN "
                    "('CLAIMED','SPECIFIED','LAUNCH_PREPARED','RUNNING','STOPPING','EXITED') "
                    "AND b.principal_id=? AND b.authority_domain=? "
                    "AND b.account_binding_sha256=? "
                    "ORDER BY a.attempt_id",
                    (manifest.principal_id, manifest.authority_domain,
                     manifest.account_binding_sha256),
                )
            ]
            superseded_units = [
                {
                    "attempt_id": row["attempt_id"], "state": row["state"],
                    "expected_version": row["version"],
                    "version": row["version"] + 1,
                }
                for row in db.execute(
                    "SELECT u.attempt_id,u.state,u.version FROM attempt_units u "
                    "WHERE u.state IN ('PREPARED','RUNNING','STOPPING') "
                    "AND u.attempt_id IN ("
                    "SELECT a.attempt_id FROM phase_attempts a "
                    "JOIN consumed_authority_bindings b ON b.binding_id=a.binding_id "
                    "WHERE b.principal_id=? AND b.authority_domain=? "
                    "AND b.account_binding_sha256=?) "
                    "ORDER BY u.attempt_id",
                    (manifest.principal_id, manifest.authority_domain,
                     manifest.account_binding_sha256),
                )
            ]
            return {
                "identity_receipt_sha256": receipt_sha256,
                "lineage_id": lineage_id,
                "manifest_sha256": manifest_sha256,
                "principal_id": manifest.principal_id,
                "authority_domain": manifest.authority_domain,
                "adapter": manifest.adapter, "generation": manifest.generation,
                "account_binding_sha256": manifest.account_binding_sha256,
                "executable_sha256": manifest.executable_sha256,
                "network_profile_sha256": manifest.network_profile_sha256,
                "checked_at": receipt.checked_at, "expires_at": receipt.expires_at,
                "epoch": epoch,
                "superseded_attempts": superseded_attempts,
                "superseded_units": superseded_units,
            }

        self._runtime_mutation("identity.registered.v2", payload)
        return IdentityRegistration(
            manifest.principal_id, manifest.authority_domain, receipt_sha256,
            manifest_sha256, manifest.generation,
        )

    def phase_authority_request(self, task_id: str, role: str) -> PhaseAuthorityRequest:
        _require_identifier(task_id, "task id")
        _require_role(role)
        with self._lock(exclusive=False):
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                epoch = self._require_controller(db)
                return self._authority_request_from_db(db, task_id, role, epoch)

    def task(self, task_id: str) -> TaskView:
        _require_identifier(task_id, "task id")
        with self._lock(exclusive=False):
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                row = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
                if row is None:
                    raise DurableStoreError("unknown task")
                return self._task_view(row)

    def campaign(self, campaign_id: str) -> CampaignView:
        _require_identifier(campaign_id, "campaign id")
        with self._lock(exclusive=False):
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                row = db.execute(
                    "SELECT id,state,epoch,version,recovery_required FROM campaigns "
                    "WHERE id=?", (campaign_id,),
                ).fetchone()
                if row is None:
                    raise DurableStoreError("unknown campaign")
                return CampaignView(
                    row["id"], row["state"], row["epoch"], row["version"],
                    bool(row["recovery_required"]),
                )

    def claim_phase(
        self, task_id: str, role: str, authority: AuthorityBinding,
        manifest: IdentityManifest, receipt: IdentityReceipt, *,
        expected_task_version: int, ttl_seconds: int, controller_hmac_key: bytes,
        crash_hook: Optional[Callable[[str], None]] = None,
    ) -> LeaseGrant:
        _require_identifier(task_id, "task id")
        _require_role(role)
        if (isinstance(expected_task_version, bool)
                or not isinstance(expected_task_version, int)
                or isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int)
                or not 5 <= ttl_seconds <= 600):
            raise DurableStoreError("invalid phase claim bounds")
        now = time.time()
        captured: dict[str, object] = {}

        def payload(db: sqlite3.Connection, epoch: int, _events: list[dict]) -> dict:
            request = self._authority_request_from_db(db, task_id, role, epoch)
            if role in {"integrator", "post-merge-verifier"}:
                raise DurableStoreError("merge-bound phase claim API is not registered")
            if request.task_version != expected_task_version:
                raise DurableStoreError("phase claim task CAS failed")
            stale = db.execute(
                "SELECT 1 FROM phase_attempts WHERE epoch<>? AND state IN "
                "('CLAIMED','SPECIFIED','LAUNCH_PREPARED','RUNNING','STOPPING','EXITED','RECOVERY_REQUIRED') "
                "UNION ALL SELECT 1 FROM phase_leases WHERE epoch<>? "
                "UNION ALL SELECT 1 FROM attempt_units WHERE state='RECOVERY_REQUIRED' "
                "UNION ALL SELECT 1 FROM merge_claims WHERE status='RECOVERY_REQUIRED' LIMIT 1",
                (epoch, epoch),
            ).fetchone()
            if stale is not None:
                raise DurableStoreError("stale phase recovery blocks new claims")
            try:
                authenticated = authenticate_authority_binding(
                    authority, manifest, receipt, now, controller_hmac_key,
                    request.operation_sha256,
                )
            except IdentityError as exc:
                raise DurableStoreError("authority binding authentication failed") from exc
            receipt_sha256 = _identity_receipt_sha256(receipt)
            manifest_sha256 = _identity_manifest_sha256(manifest)
            identity = db.execute(
                "SELECT * FROM identity_registry WHERE identity_receipt_sha256=?",
                (receipt_sha256,),
            ).fetchone()
            if (identity is None or identity["manifest_sha256"] != manifest_sha256
                    or identity["principal_id"] != authenticated.principal_id
                    or identity["authority_domain"] != authenticated.authority_domain
                    or identity["account_binding_sha256"] != authenticated.account_binding_sha256
                    or identity["expires_at"] <= now):
                raise DurableStoreError("authority identity is not durably registered")
            latest_identity = db.execute(
                "SELECT * FROM identity_registry WHERE principal_id=? "
                "AND authority_domain=? AND account_binding_sha256=? "
                "ORDER BY generation DESC,registered_event_seq DESC LIMIT 1",
                (authenticated.principal_id, authenticated.authority_domain,
                 authenticated.account_binding_sha256),
            ).fetchone()
            if (latest_identity is None
                    or latest_identity["identity_receipt_sha256"] != receipt_sha256
                    or latest_identity["manifest_sha256"] != manifest_sha256
                    or latest_identity["generation"] != authenticated.generation
                    or latest_identity["account_binding_sha256"]
                    != authenticated.account_binding_sha256
                    or latest_identity["executable_sha256"]
                    != authenticated.executable_sha256
                    or latest_identity["network_profile_sha256"]
                    != authenticated.network_profile_sha256):
                raise DurableStoreError("authority is not the latest registered identity generation")
            if db.execute(
                "SELECT 1 FROM consumed_authority_bindings WHERE binding_id=?",
                (authenticated.binding_id,),
            ).fetchone():
                raise DurableStoreError("authority binding was already consumed")
            if db.execute(
                "SELECT 1 FROM phase_leases WHERE task_id=? OR principal_id=? "
                "OR authority_domain=? OR account_binding_sha256=? "
                "OR identity_receipt_sha256=? LIMIT 1",
                (task_id, authenticated.principal_id,
                 authenticated.authority_domain,
                 authenticated.account_binding_sha256, receipt_sha256),
            ).fetchone():
                raise DurableStoreError("task or identity already has an active phase lease")
            prior_identities = db.execute(
                "SELECT a.role,a.principal_id,a.authority_domain,"
                "b.account_binding_sha256,b.identity_receipt_sha256 "
                "FROM phase_attempts a JOIN consumed_authority_bindings b "
                "ON b.binding_id=a.binding_id WHERE a.task_id=? "
                "AND a.task_attempt=? ORDER BY a.created_event_seq",
                (task_id, request.task_attempt),
            ).fetchall()
            for prior in prior_identities:
                if phase_identity_reuse_allowed(prior["role"], role):
                    continue
                if (authenticated.principal_id == prior["principal_id"]
                        or authenticated.authority_domain == prior["authority_domain"]
                        or authenticated.account_binding_sha256
                        == prior["account_binding_sha256"]
                        or receipt_sha256 == prior["identity_receipt_sha256"]):
                    raise DurableStoreError(
                        "phase role identity dimensions are not independent"
                    )
            if db.execute(
                "SELECT 1 FROM phase_attempts WHERE task_id=? AND task_attempt=? "
                "AND role=? AND state NOT IN ('RECOVERED','FAILED')",
                (task_id, request.task_attempt, role),
            ).fetchone():
                raise DurableStoreError("phase role attempt already exists")
            task = db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            previous_token = db.execute(
                "SELECT value FROM protocol_counters WHERE name='phase_fence'"
            ).fetchone()
            if task is None or previous_token is None:
                raise DurableStoreError("phase claim projection is incomplete")
            token = previous_token[0] + 1
            resource = f"task:{task_id}:{request.task_attempt}:{role}"
            run_id = _sha256(_canonical([
                "phase-run-v2", authenticated.binding_id, epoch, token,
                request.execution_generation,
            ]))
            attempt_id = _sha256(_canonical([
                "phase-attempt-v2", task_id, request.task_attempt, role,
                request.execution_generation, authenticated.binding_id, epoch, token,
            ]))
            expires_at = min(now + ttl_seconds, authenticated.expires_at)
            if expires_at <= now:
                raise DurableStoreError("authority binding expires before lease")
            state_after = self._claim_state(role, task["state"])
            value = {
                "attempt_id": attempt_id, "task_id": task_id,
                "task_attempt": request.task_attempt,
                "execution_generation": request.execution_generation,
                "role": role,
                "principal_id": authenticated.principal_id,
                "authority_domain": authenticated.authority_domain,
                "binding_id": authenticated.binding_id,
                "account_binding_sha256": authenticated.account_binding_sha256,
                "identity_receipt_sha256": receipt_sha256,
                "manifest_sha256": manifest_sha256,
                "operation_sha256": authenticated.operation_sha256,
                "binding_expires_at": authenticated.expires_at,
                "resource": resource, "previous_token": previous_token[0],
                "token": token, "run_id": run_id, "epoch": epoch,
                "expected_task_version": expected_task_version,
                "task_version": expected_task_version + 1,
                "task_state_before": task["state"], "task_state_after": state_after,
                "subject_sha": task["subject_sha"], "base_sha": task["base_sha"],
                "heartbeat_at": now, "expires_at": expires_at,
            }
            captured.update(value)
            return value

        self._runtime_mutation(
            "protocol.phase_claimed.v2", payload, crash_hook=crash_hook
        )
        return LeaseGrant(
            captured["attempt_id"], captured["task_id"], captured["task_attempt"],
            captured["execution_generation"], captured["role"],
            captured["principal_id"], captured["authority_domain"],
            captured["binding_id"], captured["identity_receipt_sha256"],
            captured["account_binding_sha256"], captured["resource"],
            captured["token"], captured["run_id"], captured["epoch"],
            captured["task_version"], 1, 1, captured["subject_sha"],
            captured["base_sha"], captured["expires_at"],
        )

    def binding_consumed(self, binding_id: str) -> bool:
        _require_hex(binding_id, 64, "authority binding id")
        with self._lock(exclusive=False):
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                return db.execute(
                    "SELECT 1 FROM consumed_authority_bindings WHERE binding_id=?",
                    (binding_id,),
                ).fetchone() is not None

    def phase_attempt(self, attempt_id: str) -> PhaseAttemptView:
        _require_hex(attempt_id, 64, "phase attempt id")
        with self._lock(exclusive=False):
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                row = db.execute(
                    "SELECT * FROM phase_attempts WHERE attempt_id=?", (attempt_id,)
                ).fetchone()
                if row is None:
                    raise DurableStoreError("unknown phase attempt")
                return self._attempt_view(row)

    def active_grant(self, attempt_id: str) -> LeaseGrant:
        """Reconstitute only a currently live controller-owned lease grant."""
        _require_hex(attempt_id, 64, "phase attempt id")
        with self._lock(exclusive=False):
            ledger = self._read_ledger().data
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                self._sync_runtime_tail(db, ledger)
                epoch = self._require_controller(db)
                row = db.execute(
                    "SELECT l.*,a.version AS attempt_version,t.version AS task_version,"
                    "t.subject_sha,t.base_sha,b.identity_receipt_sha256,"
                    "b.account_binding_sha256 FROM phase_leases l "
                    "JOIN phase_attempts a ON a.attempt_id=l.attempt_id "
                    "JOIN tasks t ON t.id=l.task_id "
                    "JOIN consumed_authority_bindings b ON b.binding_id=l.binding_id "
                    "WHERE l.attempt_id=?", (attempt_id,),
                ).fetchone()
                if row is None or row["epoch"] != epoch:
                    raise DurableStoreError("phase grant is not live in this epoch")
                grant = LeaseGrant(
                    row["attempt_id"], row["task_id"], row["task_attempt"],
                    row["execution_generation"], row["role"],
                    row["principal_id"], row["authority_domain"],
                    row["binding_id"], row["identity_receipt_sha256"],
                    row["account_binding_sha256"], row["resource"], row["token"],
                    row["run_id"], row["epoch"], row["task_version"],
                    row["attempt_version"], row["version"], row["subject_sha"],
                    row["base_sha"], row["expires_at"],
                )
                self._live_grant_rows(db, grant, epoch)
                return grant

    def recover_runtime_tail(self) -> RuntimeRecoveryView:
        with self._controller_guard:
            self._validate_controller_lock_identity()
            controller_fd = self._controller_fd
            if controller_fd is None:
                raise DurableStoreError("controller claim required")
            with self._lock(exclusive=True) as writer_identity:
                self._validate_writable_state_files()
                snapshot = self._read_ledger()
                with self._writable_db() as (db, db_identity):
                    snapshot = self._recover_runtime_intent(
                        db, snapshot, writer_identity, db_identity, controller_fd,
                    )
                    self._sync_runtime_tail(db, snapshot.data)
                    self._require_controller(db)
                    attempts = tuple(
                        self._attempt_view(row) for row in db.execute(
                            "SELECT * FROM phase_attempts ORDER BY attempt_id"
                        )
                    )
        return RuntimeRecoveryView(attempts)

    @staticmethod
    def _live_grant_rows(
        db: sqlite3.Connection, grant: LeaseGrant, epoch: int,
    ) -> tuple[sqlite3.Row, sqlite3.Row, sqlite3.Row]:
        if not isinstance(grant, LeaseGrant):
            raise DurableStoreError("LeaseGrant required")
        lease = db.execute(
            "SELECT * FROM phase_leases WHERE attempt_id=?", (grant.attempt_id,)
        ).fetchone()
        attempt = db.execute(
            "SELECT * FROM phase_attempts WHERE attempt_id=?", (grant.attempt_id,)
        ).fetchone()
        task = db.execute("SELECT * FROM tasks WHERE id=?", (grant.task_id,)).fetchone()
        binding = db.execute(
            "SELECT * FROM consumed_authority_bindings WHERE binding_id=?",
            (grant.binding_id,),
        ).fetchone()
        identity = db.execute(
            "SELECT * FROM identity_registry WHERE identity_receipt_sha256=?",
            (grant.identity_receipt_sha256,),
        ).fetchone()
        if lease is None or attempt is None or task is None or binding is None or identity is None:
            raise DurableStoreError("phase grant is no longer live")
        expected_lease = {
            "resource": grant.resource, "attempt_id": grant.attempt_id,
            "task_id": grant.task_id, "task_attempt": grant.task_attempt,
            "execution_generation": grant.execution_generation,
            "role": grant.role, "run_id": grant.run_id,
            "principal_id": grant.principal_id,
            "authority_domain": grant.authority_domain,
            "account_binding_sha256": grant.account_binding_sha256,
            "identity_receipt_sha256": grant.identity_receipt_sha256,
            "binding_id": grant.binding_id, "token": grant.token,
            "epoch": grant.epoch, "version": grant.lease_version,
            "expires_at": grant.expires_at,
        }
        if any(lease[key] != value for key, value in expected_lease.items()):
            raise DurableStoreError("phase grant lease binding is stale")
        expected_attempt = {
            "task_id": grant.task_id, "task_attempt": grant.task_attempt,
            "execution_generation": grant.execution_generation,
            "role": grant.role, "principal_id": grant.principal_id,
            "authority_domain": grant.authority_domain, "binding_id": grant.binding_id,
            "lease_resource": grant.resource, "lease_token": grant.token,
            "run_id": grant.run_id, "epoch": grant.epoch,
            "version": grant.attempt_version,
        }
        if any(attempt[key] != value for key, value in expected_attempt.items()):
            raise DurableStoreError("phase grant attempt binding is stale")
        expected_binding = {
            "task_id": grant.task_id, "task_attempt": grant.task_attempt,
            "execution_generation": grant.execution_generation,
            "role": grant.role, "principal_id": grant.principal_id,
            "authority_domain": grant.authority_domain,
            "account_binding_sha256": grant.account_binding_sha256,
            "identity_receipt_sha256": grant.identity_receipt_sha256,
            "run_id": grant.run_id, "epoch": grant.epoch,
        }
        if any(binding[key] != value for key, value in expected_binding.items()):
            raise DurableStoreError("phase grant consumed binding is stale")
        if (identity["principal_id"] != grant.principal_id
                or identity["authority_domain"] != grant.authority_domain
                or identity["account_binding_sha256"] != grant.account_binding_sha256
                or identity["manifest_sha256"] != binding["manifest_sha256"]):
            raise DurableStoreError("phase grant identity binding is stale")
        latest_identity = db.execute(
            "SELECT identity_receipt_sha256 FROM identity_registry "
            "WHERE principal_id=? AND authority_domain=? AND account_binding_sha256=? "
            "ORDER BY generation DESC,registered_event_seq DESC LIMIT 1",
            (grant.principal_id, grant.authority_domain,
             grant.account_binding_sha256),
        ).fetchone()
        now = time.time()
        if (grant.epoch != epoch or task["version"] != grant.task_version
                or task["attempts"] != grant.task_attempt
                or task["subject_sha"] != grant.subject_sha
                or task["base_sha"] != grant.base_sha
                or task["active_role"] != grant.role
                or lease["expires_at"] <= now
                or binding["expires_at"] <= now
                or identity["expires_at"] <= now
                or latest_identity is None
                or latest_identity[0] != grant.identity_receipt_sha256):
            raise DurableStoreError("phase grant task/SHA/epoch binding is stale")
        return lease, attempt, task

    def heartbeat(
        self, grant: LeaseGrant, *, expected_lease_version: int, ttl_seconds: int,
        crash_hook: Optional[Callable[[str], None]] = None,
    ) -> LeaseGrant:
        if (isinstance(expected_lease_version, bool)
                or not isinstance(expected_lease_version, int)
                or isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int)
                or not 5 <= ttl_seconds <= 600):
            raise DurableStoreError("invalid heartbeat bounds")
        now = time.time()
        captured: dict[str, object] = {}

        def payload(db: sqlite3.Connection, epoch: int, _events: list[dict]) -> dict:
            lease, _attempt, _task = self._live_grant_rows(db, grant, epoch)
            if (expected_lease_version != grant.lease_version
                    or lease["version"] != expected_lease_version):
                raise DurableStoreError("heartbeat lease CAS failed")
            identity = db.execute(
                "SELECT i.expires_at AS identity_expires_at,b.expires_at AS binding_expires_at "
                "FROM identity_registry i JOIN consumed_authority_bindings b "
                "ON b.identity_receipt_sha256=i.identity_receipt_sha256 "
                "WHERE i.identity_receipt_sha256=? AND b.binding_id=?",
                (grant.identity_receipt_sha256, grant.binding_id),
            ).fetchone()
            if identity is None:
                raise DurableStoreError("heartbeat identity registration is missing")
            expires_at = min(
                now + ttl_seconds, identity["identity_expires_at"],
                identity["binding_expires_at"],
            )
            if expires_at <= now:
                raise DurableStoreError("heartbeat identity evidence expired")
            value = {
                "attempt_id": grant.attempt_id, "resource": grant.resource,
                "token": grant.token, "run_id": grant.run_id,
                "principal_id": grant.principal_id, "role": grant.role,
                "epoch": epoch, "expected_lease_version": expected_lease_version,
                "lease_version": expected_lease_version + 1,
                "heartbeat_at": now, "expires_at": expires_at,
            }
            captured.update(value)
            return value

        self._runtime_mutation(
            "protocol.phase_heartbeat.v2", payload, crash_hook=crash_hook,
        )
        return replace(
            grant, lease_version=captured["lease_version"],
            expires_at=captured["expires_at"],
        )

    def recover_phase(
        self, attempt_id: str, *, expected_attempt_version: int,
        expected_task_version: int, cleanup: CleanupEvidence,
    ) -> TaskView:
        _require_hex(attempt_id, 64, "phase attempt id")
        if (not isinstance(cleanup, CleanupEvidence) or not cleanup.cgroup_empty
                or isinstance(expected_attempt_version, bool)
                or not isinstance(expected_attempt_version, int)
                or isinstance(expected_task_version, bool)
                or not isinstance(expected_task_version, int)):
            raise DurableStoreError("bounded cgroup-empty recovery evidence required")
        task_id: list[str] = []

        def payload(db: sqlite3.Connection, epoch: int, _events: list[dict]) -> dict:
            attempt = db.execute(
                "SELECT * FROM phase_attempts WHERE attempt_id=?", (attempt_id,)
            ).fetchone()
            if (attempt is None or attempt["state"] != "RECOVERY_REQUIRED"
                    or attempt["epoch"] >= epoch
                    or attempt["version"] != expected_attempt_version):
                raise DurableStoreError("phase attempt is not eligible for recovery")
            if attempt["role"] == "integrator":
                raise DurableStoreError("integrator requires merge-specific recovery")
            task = db.execute(
                "SELECT * FROM tasks WHERE id=?", (attempt["task_id"],)
            ).fetchone()
            lease = db.execute(
                "SELECT 1 FROM phase_leases WHERE attempt_id=? AND epoch=?",
                (attempt_id, attempt["epoch"]),
            ).fetchone()
            if task is None or lease is None or task["version"] != expected_task_version:
                raise DurableStoreError("phase recovery task/lease CAS failed")
            unit = db.execute(
                "SELECT state,cgroup_empty FROM attempt_units WHERE attempt_id=?",
                (attempt_id,),
            ).fetchone()
            if (attempt["interrupted_state"] in {
                    "LAUNCH_PREPARED", "RUNNING", "STOPPING", "EXITED"
            } and unit is None):
                raise DurableStoreError("launched attempt is missing its trusted unit registry")
            if unit is not None and not (
                unit["state"] == "STOPPED" and unit["cgroup_empty"] == 1
            ):
                raise DurableStoreError("attempt unit requires explicit trusted recovery")
            state_after = attempt["recovery_from"]
            if not isinstance(state_after, str):
                raise DurableStoreError("phase recovery lacks a safe task state")
            task_id.append(attempt["task_id"])
            return {
                "attempt_id": attempt_id, "task_id": attempt["task_id"],
                "role": attempt["role"], "stale_epoch": attempt["epoch"],
                "attempt_state_before": attempt["state"],
                "epoch": epoch, "expected_attempt_version": expected_attempt_version,
                "attempt_version": expected_attempt_version + 1,
                "expected_task_version": expected_task_version,
                "task_version": expected_task_version + 1,
                "task_state_before": task["state"], "task_state_after": state_after,
                "cleanup_evidence_sha256": cleanup.evidence_sha256,
                "cgroup_empty": True,
            }

        self._runtime_mutation("protocol.phase_recovered.v2", payload)
        return self.task(task_id[0])

    @staticmethod
    def _result_state(
        db: sqlite3.Connection, role: str, verdict: str, task_id: str,
        task_attempt: int,
    ) -> str:
        passed: set[str] = set()
        if role in REVIEW_ROLES:
            passed = {
                row[0] for row in db.execute(
                    "SELECT role FROM phase_receipts WHERE task_id=? AND task_attempt=? "
                    "AND verdict='PASS' AND role IN "
                    "('spec-reviewer','regression-reviewer','independent-reviewer')",
                    (task_id, task_attempt),
                )
            }
        return phase_result_transition(role, verdict, tuple(sorted(passed)))

    def _record_phase_result(
        self, grant: LeaseGrant, *, expected_task_version: int,
        result: PhaseResult, verdict: str,
    ) -> TaskView:
        if not isinstance(result, PhaseResult) or verdict not in {"PASS", "FAIL"}:
            raise DurableStoreError("bounded PhaseResult required")
        if not isinstance(grant, LeaseGrant):
            raise DurableStoreError("LeaseGrant required")
        if grant.role == "integrator":
            raise DurableStoreError("integrator result requires the merge-specific protocol")
        if grant.role == "builder" and verdict == "FAIL":
            raise DurableStoreError("builder FAIL requires a new-attempt failure protocol")
        if not result.cleanup.cgroup_empty:
            raise DurableStoreError("phase result requires cgroup-empty cleanup evidence")
        if (isinstance(expected_task_version, bool)
                or not isinstance(expected_task_version, int)):
            raise DurableStoreError("invalid result task version")

        def payload(db: sqlite3.Connection, epoch: int, events: list[dict]) -> dict:
            lease, attempt, task = self._live_grant_rows(db, grant, epoch)
            if expected_task_version != grant.task_version:
                raise DurableStoreError("phase result task CAS failed")
            if attempt["state"] != "EXITED":
                raise DurableStoreError("phase result requires an EXITED attempt")
            expected_task_state = {
                "builder": "RUNNING", "verifier": "VERIFYING",
                "spec-reviewer": "REVIEWING",
                "regression-reviewer": "REVIEWING",
                "independent-reviewer": "REVIEWING",
                "integrator": "INTEGRATING",
                "post-merge-verifier": "POST_MERGE_VERIFYING",
            }[grant.role]
            if task["state"] != expected_task_state:
                raise DurableStoreError("phase result task is not in its running state")
            if (result.subject_sha != grant.subject_sha
                    or result.base_sha != grant.base_sha):
                raise DurableStoreError("phase result SHA binding is stale")
            if grant.role != "builder" and result.result_sha != grant.subject_sha:
                raise DurableStoreError("non-builder result cannot change subject SHA")
            if (result.task_spec_sha256 is None
                    or result.unit_identity_sha256 is None
                    or result.instruction_sha256 is None
                    or result.instruction_bytes is None):
                raise DurableStoreError(
                    "phase result requires exact task-spec, instruction, and unit evidence"
                )
            spec = db.execute(
                "SELECT * FROM task_specs WHERE attempt_id=?",
                (grant.attempt_id,),
            ).fetchone()
            if (spec is None or spec["task_spec_sha256"] != result.task_spec_sha256
                    or spec["schema_version"] != 2
                    or spec["canonical_json"] is None
                    or spec["instruction_sha256"] != result.instruction_sha256
                    or spec["instruction_bytes"] != result.instruction_bytes
                    or spec["signing_key_id"] is None
                    or spec["signature_sha256"] is None
                    or spec["controller_epoch"] != grant.epoch
                    or spec["expires_at"] is None or spec["expires_at"] <= time.time()
                    or spec["attached_event_seq"] is None):
                raise DurableStoreError("phase result task spec binding is stale")
            unit = db.execute(
                "SELECT * FROM attempt_units WHERE attempt_id=?", (grant.attempt_id,)
            ).fetchone()
            unit_hash_fields = (
                "launch_intent_sha256", "argv_sha256", "bwrap_sha256",
                "executable_sha256", "requested_properties_sha256",
                "observed_unit_sha256", "effective_properties_sha256",
                "cgroup_identity_sha256", "stdout_observed_sha256",
                "stdout_retained_sha256", "stderr_observed_sha256",
                "stderr_retained_sha256", "instruction_materialization_sha256",
                "instruction_transport_sha256", "resource_outcome_sha256",
            )
            expected_unit = {
                "task_id": grant.task_id, "task_attempt": grant.task_attempt,
                "execution_generation": grant.execution_generation,
                "role": grant.role, "binding_id": grant.binding_id,
                "principal_id": grant.principal_id,
                "authority_domain": grant.authority_domain,
                "account_binding_sha256": grant.account_binding_sha256,
                "identity_receipt_sha256": grant.identity_receipt_sha256,
                "task_spec_sha256": result.task_spec_sha256,
                "instruction_sha256": result.instruction_sha256,
                "instruction_bytes": result.instruction_bytes,
                "instruction_materialization_sha256":
                    result.instruction_materialization_sha256,
                "instruction_materialization_bytes":
                    result.instruction_materialization_bytes,
                "instruction_transport_sha256": result.instruction_transport_sha256,
                "instruction_transport_bytes": result.instruction_transport_bytes,
                "cpu_usage_ns": result.cpu_usage_ns,
                "memory_peak_bytes": result.memory_peak_bytes,
                "tasks_peak": result.tasks_peak, "oom_count": result.oom_count,
                "oom_killed": result.oom_killed,
                "systemd_service_result": result.systemd_service_result,
                "systemd_exec_code": result.systemd_exec_code,
                "systemd_exec_status": result.systemd_exec_status,
                "resource_outcome_sha256": result.resource_outcome_sha256,
            }
            if (unit is None or not _trusted_unit_success_evidence(unit)
                    or unit["observed_unit_sha256"] != result.unit_identity_sha256
                    or any(unit[key] != value for key, value in expected_unit.items())
                    or any(
                        not isinstance(unit[name], str) or len(unit[name]) != 64
                        or any(character not in "0123456789abcdef" for character in unit[name])
                        for name in unit_hash_fields
                    )):
                raise DurableStoreError("phase result trusted unit evidence is incomplete")
            state_after = self._result_state(
                db, grant.role, verdict, grant.task_id, grant.task_attempt
            )
            event_sequence = len(events) + 1
            receipt_id = _sha256(_canonical([
                "phase-result-v2", grant.attempt_id, verdict, event_sequence,
                result.evidence_sha256, result.task_spec_sha256,
                result.instruction_sha256, result.resource_outcome_sha256,
            ]))
            return {
                "receipt_id": receipt_id, "attempt_id": grant.attempt_id,
                "task_id": grant.task_id, "task_attempt": grant.task_attempt,
                "execution_generation": grant.execution_generation,
                "phase": grant.role, "role": grant.role,
                "principal_id": grant.principal_id,
                "authority_domain": grant.authority_domain, "verdict": verdict,
                "subject_sha": result.subject_sha, "base_sha": result.base_sha,
                "result_sha": result.result_sha,
                "evidence_sha256": result.evidence_sha256,
                "cleanup_evidence_sha256": result.cleanup.evidence_sha256,
                "cgroup_empty": True,
                "identity_receipt_sha256": grant.identity_receipt_sha256,
                "account_binding_sha256": grant.account_binding_sha256,
                "task_spec_sha256": result.task_spec_sha256,
                "instruction_sha256": result.instruction_sha256,
                "instruction_bytes": result.instruction_bytes,
                "instruction_materialization_sha256":
                    result.instruction_materialization_sha256,
                "instruction_materialization_bytes":
                    result.instruction_materialization_bytes,
                "instruction_transport_sha256": result.instruction_transport_sha256,
                "instruction_transport_bytes": result.instruction_transport_bytes,
                "unit_identity_sha256": result.unit_identity_sha256,
                "cpu_usage_ns": result.cpu_usage_ns,
                "memory_peak_bytes": result.memory_peak_bytes,
                "tasks_peak": result.tasks_peak, "oom_count": result.oom_count,
                "oom_killed": result.oom_killed,
                "systemd_service_result": result.systemd_service_result,
                "systemd_exec_code": result.systemd_exec_code,
                "systemd_exec_status": result.systemd_exec_status,
                "resource_outcome_sha256": result.resource_outcome_sha256,
                "resource": grant.resource, "token": grant.token,
                "run_id": grant.run_id, "binding_id": grant.binding_id,
                "epoch": epoch, "expected_task_version": expected_task_version,
                "task_version": expected_task_version + 1,
                "task_state_before": task["state"], "task_state_after": state_after,
                "expected_attempt_version": attempt["version"],
                "attempt_version": attempt["version"] + 1,
            }

        self._runtime_mutation("protocol.phase_result.v2", payload)
        return self.task(grant.task_id)

    def commit_phase(
        self, grant: LeaseGrant, *, expected_task_version: int, result: PhaseResult,
    ) -> TaskView:
        return self._record_phase_result(
            grant, expected_task_version=expected_task_version,
            result=result, verdict="PASS",
        )

    def reject_phase(
        self, grant: LeaseGrant, *, expected_task_version: int, result: PhaseResult,
    ) -> TaskView:
        return self._record_phase_result(
            grant, expected_task_version=expected_task_version,
            result=result, verdict="FAIL",
        )

    def phase_receipts(self, task_id: str) -> tuple[PhaseReceiptView, ...]:
        _require_identifier(task_id, "task id")
        with self._lock(exclusive=False):
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                return tuple(
                    PhaseReceiptView(
                        row["id"], row["attempt_id"], row["task_id"],
                        row["task_attempt"], row["execution_generation"],
                        row["role"], row["verdict"],
                        row["subject_sha"], row["result_sha"],
                        row["evidence_sha256"], row["event_seq"],
                    )
                    for row in db.execute(
                        "SELECT * FROM phase_receipts WHERE task_id=? ORDER BY event_seq",
                        (task_id,),
                    )
                )

    def legacy_receipts(self) -> tuple[LegacyReceipt, ...]:
        with self._lock(exclusive=False):
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                metadata = _read_metadata(db)
                if metadata["state"] != "COMMITTED":
                    raise DurableStoreError("legacy receipts are unavailable before COMMITTED")
                return _legacy_receipts(db)

    def migration_view(self) -> MigrationView:
        """Return bounded migration dispositions without exposing holders/tokens."""
        with self._lock(exclusive=False):
            with self._snapshot_db() as db:
                _assert_exact_v2_schema(db)
                metadata = _read_metadata(db)
                if metadata["state"] != "COMMITTED":
                    raise DurableStoreError("migration view is unavailable before COMMITTED")
                campaigns = tuple(
                    MigratedCampaign(row["id"], row["state"], bool(row["recovery_required"]))
                    for row in db.execute(
                        "SELECT id,state,recovery_required FROM campaigns ORDER BY id"
                    )
                )
                tasks = tuple(
                    MigratedTask(row["id"], row["state"], row["version"], row["recovery_from"])
                    for row in db.execute(
                        "SELECT id,state,version,recovery_from FROM tasks ORDER BY id"
                    )
                )
                lease_count = db.execute("SELECT count(*) FROM leases").fetchone()[0]
                hold = db.execute(
                    "SELECT status FROM merge_claims WHERE resource='merge/global'"
                ).fetchone()
                hold_task_count = db.execute(
                    "SELECT count(*) FROM merge_recovery_tasks "
                    "WHERE resource='merge/global'"
                ).fetchone()[0]
                if ((hold is None) != (hold_task_count == 0)
                        or (hold is not None and hold["status"] != "RECOVERY_REQUIRED")):
                    raise DurableStoreError("merge recovery hold projection is inconsistent")
                return MigrationView(
                    campaigns, tasks, lease_count, hold is not None, hold_task_count
                )

    def projection_digest(self) -> str:
        with self._lock(exclusive=False):
            with self._snapshot_db() as db:
                metadata = _read_metadata(db)
                if metadata["state"] != "COMMITTED":
                    raise DurableStoreError("projection is not committed")
                return _v2_projection_digest(db)

    def replay_projection(self) -> ReplayProjection:
        with self._lock(exclusive=False):
            ledger = self._read_ledger().data
        db = _replay_v2(ledger)
        try:
            metadata = _read_metadata(db)
            return ReplayProjection(
                2, metadata["state"], _v2_projection_digest(db), _legacy_receipts(db)
            )
        finally:
            db.close()

    def verify_replay_equivalence(self) -> bool:
        return self.projection_digest() == self.replay_projection().projection_sha256


def preflight_migration(state_dir: str | os.PathLike[str]) -> MigrationPreflight:
    return DurableProtocolStore(state_dir).preflight_migration()
