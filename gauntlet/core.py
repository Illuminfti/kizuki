"""Durable, fail-closed controller state.

Opening a Store is deliberately inert.  Only ``claim_controller`` advances an
epoch or writes controller state; this keeps read-only observers harmless.
"""
import contextlib
import fcntl
import hashlib
import json
import os
import sqlite3
import stat
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

GENESIS = "0" * 64
PROJECTION_TABLES = (
    "controller", "campaigns", "tasks", "leases", "fences", "receipts",
    "incidents", "reconciliation", "adapter_receipts", "events",
)
ADAPTER_NAMES = {"codex", "claude", "cursor", "grok"}
AUTH_STATES = {"READY", "FAILED", "UNKNOWN"}
ROUTE_STATES = {"READY", "QUOTA_BLOCKED", "FAILED", "UNKNOWN"}
ADAPTER_REASON_CODES = {"ISOLATED_ROUTE_PROBE", "PROVIDER_QUOTA_BLOCKED", "AUTH_CHECK", "PROBE_FAILED"}
CAMPAIGN_TRANSITIONS = {
    "RECONCILING": {"READY", "PAUSED", "FAILED", "ABORTED"},
    "READY": {"ACTIVE", "PAUSED", "FAILED", "ABORTED"},
    "ACTIVE": {"QUIESCING", "PAUSED", "FAILED", "ABORTED"},
    "QUIESCING": {"VERIFYING", "PAUSED", "FAILED", "ABORTED"},
    "VERIFYING": {"RC_READY", "FAILED", "PAUSED"},
    "RC_READY": {"VALIDATING", "RELEASED", "PAUSED", "FAILED"},
    "VALIDATING": {"RELEASED", "FAILED", "PAUSED"},
    "PAUSED": {"RECONCILING", "READY", "ACTIVE", "ABORTED"},
    "FAILED": {"RECONCILING", "ABORTED"}, "ABORTED": set(), "RELEASED": set(),
}
TASK_TRANSITIONS = {
    "DISCOVERED": {"READY", "SUPERSEDED", "FAILED"},
    "READY": {"LEASED", "SUPERSEDED", "FAILED"},
    "LEASED": {"RUNNING", "RECOVERING", "FAILED"},
    "RUNNING": {"SUBMITTED", "RECOVERING", "FAILED"},
    "SUBMITTED": {"VERIFYING", "CHANGES_REQUESTED", "FAILED"},
    "VERIFYING": {"REVIEWING", "CHANGES_REQUESTED", "FAILED"},
    "REVIEWING": {"INTEGRATING", "CHANGES_REQUESTED", "FAILED"},
    "INTEGRATING": {"MERGED", "FAILED"}, "MERGED": {"POST_MERGE_VERIFYING", "FAILED"},
    "POST_MERGE_VERIFYING": {"DONE", "FAILED"},
    "CHANGES_REQUESTED": {"READY", "FAILED", "SUPERSEDED"},
    "RECOVERING": {"READY", "FAILED", "SUPERSEDED"},
    "FAILED": {"READY", "SUPERSEDED"}, "SUPERSEDED": set(), "DONE": set(),
}
class GuardError(RuntimeError): pass
class ConflictError(RuntimeError): pass
class FencedError(RuntimeError): pass
@dataclass
class Limits:
    min_free_bytes: int = 1_000_000_000
    max_running: int = 4
    max_attempts: int = 3
    max_crashes: int = 3

class Store:
    def __init__(self, state_dir: Optional[str] = None):
        self.root = Path(state_dir or os.environ.get("KIZUKI_GAUNTLET_STATE", "/var/lib/kizuki-gauntlet"))
        if self.root.is_symlink(): raise GuardError("state directory may not be a symlink")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        root_stat=os.lstat(self.root)
        if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid!=os.geteuid(): raise GuardError("state directory must be an owned real directory")
        os.chmod(self.root,0o700)
        self.events_path = self.root / "events.jsonl"; self.db_path = self.root / "state.sqlite3"
        self.lock_path = self.root / ".writer.lock"; self.controller_path = self.root / ".controller.lock"
        if any(path.is_symlink() for path in (self.events_path,self.db_path,self.lock_path,self.controller_path)): raise GuardError("state files may not be symlinks")
        self._root_fd=os.open(str(self.root),os.O_RDONLY|getattr(os,"O_DIRECTORY",0)|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0))
        self._writer_fd=self._open_private_regular(".writer.lock",os.O_RDWR|os.O_CREAT)
        self._controller_lock_fd=self._open_private_regular(".controller.lock",os.O_RDWR|os.O_CREAT)
        if self.events_path.exists():
            events_fd=self._open_private_regular("events.jsonl",os.O_RDWR)
            os.close(events_fd)
        self._thread_lock = threading.RLock(); self._controller_claimed = False; self.claimed_epoch = None; self._closed=False
        prior_umask=os.umask(0o077)
        try: self.db = sqlite3.connect(self.db_path, check_same_thread=False, isolation_level=None, timeout=30)
        finally: os.umask(prior_umask)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL"); self.db.execute("PRAGMA foreign_keys=ON"); self.db.execute("PRAGMA busy_timeout=30000")
        self._schema(); os.chmod(self.db_path, 0o600)
    def _open_private_regular(self,name,flags):
        try: fd=os.open(name,flags|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0),0o600,dir_fd=self._root_fd)
        except OSError as exc: raise GuardError("cannot safely open state file: "+name) from exc
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid(): raise GuardError("state file must be an owned regular file: "+name)
            os.fchmod(fd,0o600)
            return fd
        except Exception:
            os.close(fd); raise
    def close(self):
        if self._closed: return
        self.release_controller()
        self.db.close()
        os.close(self._writer_fd); os.close(self._controller_lock_fd); os.close(self._root_fd); self._closed=True
    def __enter__(self): return self
    def __exit__(self, *_): self.close()
    @contextlib.contextmanager
    def _writer(self):
        with self._thread_lock:
            fcntl.flock(self._writer_fd, fcntl.LOCK_EX)
            try: yield
            finally: fcntl.flock(self._writer_fd, fcntl.LOCK_UN)
    @staticmethod
    def _install_schema(db):
        db.executescript("""
        CREATE TABLE IF NOT EXISTS controller(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS campaigns(id TEXT PRIMARY KEY,state TEXT NOT NULL,epoch INTEGER NOT NULL,version INTEGER NOT NULL,created_at REAL NOT NULL,updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,scope TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL,updated_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS leases(scope TEXT PRIMARY KEY,task_id TEXT NOT NULL,holder TEXT NOT NULL,token INTEGER NOT NULL,expires_at REAL NOT NULL,heartbeat_at REAL NOT NULL,epoch INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS fences(scope TEXT PRIMARY KEY,token INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,sha TEXT NOT NULL,tests TEXT NOT NULL,scope TEXT NOT NULL,holder TEXT NOT NULL,token INTEGER NOT NULL,epoch INTEGER NOT NULL,artifact TEXT,created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS incidents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,detail TEXT NOT NULL,created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS reconciliation(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,evidence TEXT NOT NULL,created_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS adapter_receipts(name TEXT PRIMARY KEY,version TEXT NOT NULL,auth_status TEXT NOT NULL,route_status TEXT NOT NULL,evidence_sha256 TEXT NOT NULL,executable_sha256 TEXT NOT NULL,method TEXT NOT NULL,reason_code TEXT NOT NULL,checked_at REAL NOT NULL,expires_at REAL NOT NULL);
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,hash TEXT UNIQUE NOT NULL,type TEXT NOT NULL,payload TEXT NOT NULL,created_at REAL NOT NULL);
        """)
    def _schema(self):
        self._install_schema(self.db)
    @staticmethod
    def _raw(prev, typ, payload, created):
        return json.dumps({"prev":prev,"type":typ,"payload":payload,"created_at":created},sort_keys=True,separators=(",",":"))
    def _ledger(self):
        try: fd=os.open("events.jsonl",os.O_RDONLY|getattr(os,"O_CLOEXEC",0)|getattr(os,"O_NOFOLLOW",0),dir_fd=self._root_fd)
        except FileNotFoundError: return []
        except OSError as exc: raise GuardError("cannot safely read event ledger") from exc
        out=[]; previous=GENESIS
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid(): raise GuardError("event ledger must be an owned regular file")
        except Exception:
            os.close(fd); raise
        with os.fdopen(fd,encoding="utf-8") as stream:
            for seq,line in enumerate(stream,1):
                if not line.strip(): raise GuardError("blank ledger event")
                try: e=json.loads(line); raw=self._raw(e["prev"],e["type"],e["payload"],e["created_at"])
                except (json.JSONDecodeError, KeyError, TypeError) as exc: raise GuardError("malformed ledger event") from exc
                if e["prev"] != previous or hashlib.sha256(raw.encode()).hexdigest() != e.get("hash"):
                    raise GuardError("event hash chain invalid")
                e["seq"] = seq; out.append(e); previous=e["hash"]
        return out
    def _expected_projection(self, ledger):
        """Deterministically rebuild the complete projection for verification."""
        expected=sqlite3.connect(":memory:",isolation_level=None)
        self._install_schema(expected)
        for event in ledger:
            expected.execute(
                "INSERT INTO events VALUES(?,?,?,?,?)",
                (event["seq"],event["hash"],event["type"],json.dumps(event["payload"],sort_keys=True),event["created_at"]),
            )
            self._apply(event["type"],event["payload"],event_created_at=event["created_at"],db=expected)
        return expected
    def _verify_projection(self, ledger):
        expected=self._expected_projection(ledger)
        try:
            for table in PROJECTION_TABLES:
                actual_rows=self.db.execute("SELECT * FROM "+table+" ORDER BY 1").fetchall()
                expected_rows=expected.execute("SELECT * FROM "+table+" ORDER BY 1").fetchall()
                if [tuple(row) for row in actual_rows] != [tuple(row) for row in expected_rows]:
                    raise GuardError("derived projection mismatch: "+table)
        finally:
            expected.close()
    def verify_integrity(self):
        """Read-only full ledger/projection replay check; never heals."""
        with self._thread_lock:
            ledger=self._ledger()
            self._verify_projection(ledger)
            return True
    def _append(self, typ, payload, previous):
        created=time.time(); raw=self._raw(previous,typ,payload,created)
        event={"prev":previous,"hash":hashlib.sha256(raw.encode()).hexdigest(),"type":typ,"payload":payload,"created_at":created}
        fd=self._open_private_regular("events.jsonl",os.O_WRONLY|os.O_CREAT|os.O_APPEND)
        with os.fdopen(fd,"a",encoding="utf-8") as stream:
            stream.write(json.dumps(event,sort_keys=True,separators=(",",":"))+"\n"); stream.flush(); os.fsync(stream.fileno())
        # Directory metadata durability matters when this was the first entry.
        os.fsync(self._root_fd)
        return event
    def _apply(self, typ, p, event_created_at=None, db=None):
        db=db or self.db
        now=p.get("updated_at",event_created_at if event_created_at is not None else time.time())
        if typ=="controller.epoch":
            db.execute("INSERT INTO controller VALUES('epoch',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",(p["epoch"],))
            db.execute("UPDATE campaigns SET epoch=?,updated_at=?",(p["epoch"],now))
        elif typ=="campaign.created": db.execute("INSERT OR IGNORE INTO campaigns VALUES(?,?,?,?,?,?)",(p["id"],"RECONCILING",p["epoch"],1,now,now))
        elif typ=="campaign.state": db.execute("UPDATE campaigns SET state=?,version=version+1,updated_at=? WHERE id=?",(p["state"],now,p["id"]))
        elif typ=="task.created": db.execute("INSERT OR IGNORE INTO tasks VALUES(?,?,?,?,?,?,?)",(p["id"],p["campaign_id"],p["scope"],"DISCOVERED",0,1,now))
        elif typ=="task.state": db.execute("UPDATE tasks SET state=?,version=version+1,updated_at=? WHERE id=?",(p["state"],now,p["id"]))
        elif typ=="lease.acquired":
            db.execute("INSERT INTO fences VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET token=MAX(token,excluded.token)",(p["scope"],p["token"]))
            db.execute("INSERT OR REPLACE INTO leases VALUES(?,?,?,?,?,?,?)",(p["scope"],p["task_id"],p["holder"],p["token"],p["expires_at"],p["heartbeat_at"],p["epoch"]))
            if p.get("starts_attempt",False): db.execute("UPDATE tasks SET attempts=attempts+1,state='LEASED',version=version+1,updated_at=? WHERE id=?",(now,p["task_id"]))
        elif typ=="lease.heartbeat": db.execute("UPDATE leases SET expires_at=?,heartbeat_at=? WHERE scope=?",(p["expires_at"],p["heartbeat_at"],p["scope"]))
        elif typ=="lease.released": db.execute("DELETE FROM leases WHERE scope=?",(p["scope"],))
        elif typ=="receipt.recorded": db.execute("INSERT OR IGNORE INTO receipts VALUES(?,?,?,?,?,?,?,?,?,?)",(p["id"],p["task_id"],p["sha"],json.dumps(p["tests"],sort_keys=True),p["scope"],p["holder"],p["token"],p["epoch"],p.get("artifact"),now))
        elif typ=="incident": db.execute("INSERT OR IGNORE INTO incidents VALUES(?,?,?,?)",(p["id"],p["kind"],p["detail"],now))
        elif typ=="reconciliation": db.execute("INSERT OR REPLACE INTO reconciliation VALUES(?,?,?,?)",(p["id"],p["campaign_id"],json.dumps(p["evidence"],sort_keys=True),now))
        elif typ=="adapter.receipt": db.execute(
            "INSERT OR REPLACE INTO adapter_receipts VALUES(?,?,?,?,?,?,?,?,?,?)",
            (p["name"],p["version"],p["auth_status"],p["route_status"],p["evidence_sha256"],p["executable_sha256"],p["method"],p["reason_code"],p["checked_at"],p["expires_at"]),
        )
    def _sync_tail_locked(self):
        """Heal fsynced journal entries whose projection transaction crashed."""
        ledger=self._ledger(); rows=self.db.execute("SELECT seq,hash FROM events ORDER BY seq").fetchall()
        if len(rows)>len(ledger): raise GuardError("projection contains events absent from ledger")
        for idx,row in enumerate(rows):
            if row["seq"]!=ledger[idx]["seq"] or row["hash"]!=ledger[idx]["hash"]: raise GuardError("projection event mismatch")
        self._verify_projection(ledger[:len(rows)])
        for e in ledger[len(rows):]:
            self.db.execute("INSERT INTO events VALUES(?,?,?,?,?)",(e["seq"],e["hash"],e["type"],json.dumps(e["payload"],sort_keys=True),e["created_at"]))
            self._apply(e["type"],e["payload"],event_created_at=e["created_at"])
        return ledger
    def _emit_locked(self,typ,payload,ledger=None):
        ledger=self._sync_tail_locked() if ledger is None else ledger
        event=self._append(typ,payload,ledger[-1]["hash"] if ledger else GENESIS)
        self.db.execute("INSERT INTO events VALUES(?,?,?,?,?)",(len(ledger)+1,event["hash"],typ,json.dumps(payload,sort_keys=True),event["created_at"]))
        self._apply(typ,payload,event_created_at=event["created_at"]); return event
    def _write(self, validator, typ, payload):
        with self._writer():
            self.db.execute("BEGIN IMMEDIATE")
            try:
                # Never validate against a stale projection: recover a ledger
                # tail before applying guards/CAS and before appending again.
                ledger=self._sync_tail_locked()
                validator(); self._emit_locked(typ,payload,ledger); self.db.execute("COMMIT")
            except Exception:
                self.db.execute("ROLLBACK"); raise
    def claim_controller(self):
        if self._controller_claimed: return self.claimed_epoch
        try: fcntl.flock(self._controller_lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise ConflictError("controller already claimed")
        self._controller_claimed=True
        try:
            with self._writer():
                self.db.execute("BEGIN IMMEDIATE")
                try:
                    self._sync_tail_locked(); row=self.db.execute("SELECT value FROM controller WHERE key='epoch'").fetchone(); epoch=(row[0] if row else 0)+1
                    self._emit_locked("controller.epoch",{"epoch":epoch,"updated_at":time.time()}); self.db.execute("COMMIT"); self.claimed_epoch=epoch
                except Exception: self.db.execute("ROLLBACK"); raise
        except Exception:
            self.release_controller(); raise
        return self.claimed_epoch
    def release_controller(self):
        if self._controller_claimed:
            fcntl.flock(self._controller_lock_fd,fcntl.LOCK_UN); self._controller_claimed=False
        self.claimed_epoch=None
    def _require_controller(self):
        if self.claimed_epoch is None: raise GuardError("controller claim required")
        row=self.db.execute("SELECT value FROM controller WHERE key='epoch'").fetchone()
        if not row or row[0]!=self.claimed_epoch: raise FencedError("stale controller epoch")
    def _current_epoch(self):
        row=self.db.execute("SELECT value FROM controller WHERE key='epoch'").fetchone()
        if not row: raise GuardError("no claimed controller epoch")
        return row[0]
    def create_campaign(self,cid=None):
        self._require_controller(); cid=cid or str(uuid.uuid4())
        self._write(lambda: None,"campaign.created",{"id":cid,"epoch":self.claimed_epoch}); return cid
    def create_task(self,campaign_id,scope,tid=None):
        self._require_controller(); validate_scope(scope); tid=tid or str(uuid.uuid4())
        def validate():
            campaign=self._campaign(campaign_id)
            if campaign[0] in ("FAILED","ABORTED","RELEASED"): raise GuardError("cannot create task in terminal campaign")
        self._write(validate,"task.created",{"id":tid,"campaign_id":campaign_id,"scope":scope}); return tid
    def _campaign(self,cid):
        row=self.db.execute("SELECT state,version,epoch FROM campaigns WHERE id=?",(cid,)).fetchone()
        if not row: raise GuardError("unknown campaign")
        if row[2]!=self._current_epoch(): raise FencedError("stale campaign epoch")
        return row
    def campaign_state(self,cid,state,version):
        self._require_controller(); state=state.upper()
        def validate():
            row=self._campaign(cid)
            if row[1]!=version: raise ConflictError("campaign CAS failed")
            if state not in CAMPAIGN_TRANSITIONS.get(row[0],set()): raise GuardError("invalid campaign transition")
            if row[0]=="RECONCILING" and state=="READY":
                evidence=self.db.execute("SELECT evidence FROM reconciliation WHERE campaign_id=? ORDER BY created_at DESC LIMIT 1",(cid,)).fetchone()
                if not evidence or not json.loads(evidence[0]).get("safe_to_promote",False): raise GuardError("reconciliation evidence does not permit promotion")
        self._write(validate,"campaign.state",{"id":cid,"state":state}); return version+1
    def record_reconciliation(self,campaign_id,evidence):
        self._require_controller()
        if not isinstance(evidence,dict): raise GuardError("reconciliation evidence must be an object")
        def validate():
            campaign=self._campaign(campaign_id)
            if campaign[0] != "RECONCILING":
                raise GuardError("reconciliation evidence may only be recorded while RECONCILING")
        self._write(validate,"reconciliation",{"id":str(uuid.uuid4()),"campaign_id":campaign_id,"evidence":evidence})
    def task_state(self,tid,state,version,scope=None,holder=None,token=None):
        state=state.upper()
        def validate():
            row=self.db.execute("SELECT t.state,t.version,t.campaign_id,t.scope,c.epoch FROM tasks t JOIN campaigns c ON c.id=t.campaign_id WHERE t.id=?",(tid,)).fetchone()
            if not row or row[1]!=version: raise ConflictError("task CAS failed")
            if row[4]!=self._current_epoch(): raise FencedError("stale controller epoch")
            if state not in TASK_TRANSITIONS.get(row[0],set()): raise GuardError("invalid task transition")
            # Workers must present their live lease.  A controller may perform
            # recovery/admin transitions, but is fenced by its claimed epoch.
            if holder is None and token is None and scope is None: self._require_controller()
            else: self._assert_lease(scope or row[3],holder,token,tid)
        self._write(validate,"task.state",{"id":tid,"state":state}); return version+1
    def _assert_lease(self,scope,holder,token,task_id=None):
        row=self.db.execute("SELECT task_id,holder,token,expires_at,epoch FROM leases WHERE scope=?",(scope,)).fetchone(); epoch=self._current_epoch()
        if not row or row[0]!=(task_id or row[0]) or row[1]!=holder or row[2]!=token or row[3]<=time.time() or row[4]!=epoch: raise FencedError("stale, expired, or foreign lease")
        return row
    def acquire(self,task_id,scope,holder,ttl=60,limits=None):
        self._require_controller(); validate_scope(scope); limits=limits or Limits()
        if not holder or ttl<=0: raise GuardError("holder and positive ttl required")
        now=time.time(); payload={"scope":scope,"task_id":task_id,"holder":holder,"expires_at":now+ttl,"heartbeat_at":now,"epoch":self.claimed_epoch}
        def validate():
            task=self.db.execute("SELECT campaign_id,state,attempts FROM tasks WHERE id=?",(task_id,)).fetchone()
            if not task or task[1] not in ("READY","LEASED","RUNNING"): raise GuardError("task not leaseable")
            camp=self._campaign(task[0])
            if camp[0]!="ACTIVE": raise GuardError("campaign not active")
            existing=self.db.execute("SELECT holder,epoch FROM leases WHERE task_id=? AND epoch=? LIMIT 1",(task_id,self.claimed_epoch)).fetchone()
            if task[1]=="READY":
                if task[2]>=limits.max_attempts: raise GuardError("attempt circuit breaker")
                payload["starts_attempt"]=True
            else:
                if not existing or existing[0]!=holder: raise FencedError("foreign holder cannot add task scope")
                payload["starts_attempt"]=False
            if os.statvfs(self.root).f_bavail*os.statvfs(self.root).f_frsize<limits.min_free_bytes: raise GuardError("disk circuit breaker")
            if self.db.execute("SELECT count(*) FROM tasks WHERE state IN ('LEASED','RUNNING')").fetchone()[0]>=limits.max_running: raise GuardError("concurrency circuit breaker")
            if self.db.execute("SELECT count(*) FROM incidents WHERE kind='crash'").fetchone()[0]>=limits.max_crashes: raise GuardError("crash circuit breaker")
            lease=self.db.execute("SELECT expires_at,epoch FROM leases WHERE scope=?",(scope,)).fetchone()
            if lease and lease[1]==self.claimed_epoch and lease[0]>time.time(): raise ConflictError("scope leased")
            fence=self.db.execute("SELECT token FROM fences WHERE scope=?",(scope,)).fetchone(); payload["token"]=(fence[0] if fence else 0)+1
        self._write(validate,"lease.acquired",payload); return payload["token"]
    def heartbeat(self,scope,holder,token,ttl=60,task_id=None):
        if ttl<=0: raise GuardError("positive ttl required")
        now=time.time(); self._write(lambda: self._assert_lease(scope,holder,token,task_id),"lease.heartbeat",{"scope":scope,"holder":holder,"token":token,"task_id":task_id,"expires_at":now+ttl,"heartbeat_at":now,"epoch":self._current_epoch()})
    def release(self,scope,holder,token,task_id=None):
        self._write(lambda: self._assert_lease(scope,holder,token,task_id),"lease.released",{"scope":scope,"holder":holder,"token":token,"task_id":task_id,"epoch":self._current_epoch()})
    def receipt(self,task_id,sha,tests,scope,holder,token,artifact=None):
        if len(sha)!=40 or any(c not in "0123456789abcdef" for c in sha): raise GuardError("receipt requires exact 40-char lowercase SHA")
        if not isinstance(tests,list) or not tests: raise GuardError("receipt requires nonempty test evidence")
        payload={"id":str(uuid.uuid4()),"task_id":task_id,"sha":sha,"tests":tests,"scope":scope,"holder":holder,"token":token,"epoch":self._current_epoch(),"artifact":artifact}
        self._write(lambda: self._assert_lease(scope,holder,token,task_id),"receipt.recorded",payload); return payload["id"]
    def record_adapter_receipt(self,name,version,auth_status,route_status,evidence_sha256,executable_sha256,reason_code,ttl_seconds=21600):
        self._require_controller(); auth_status=auth_status.upper(); route_status=route_status.upper()
        if name not in ADAPTER_NAMES: raise GuardError("unknown adapter")
        if auth_status not in AUTH_STATES or route_status not in ROUTE_STATES: raise GuardError("invalid adapter readiness state")
        if route_status=="READY" and auth_status!="READY": raise GuardError("route readiness requires authentication")
        if not isinstance(version,str) or not version.strip() or len(version)>200: raise GuardError("invalid adapter version")
        if len(evidence_sha256)!=64 or any(c not in "0123456789abcdef" for c in evidence_sha256): raise GuardError("adapter receipt requires a lowercase SHA-256")
        if len(executable_sha256)!=64 or any(c not in "0123456789abcdef" for c in executable_sha256): raise GuardError("adapter receipt requires executable SHA-256")
        if reason_code not in ADAPTER_REASON_CODES: raise GuardError("invalid adapter receipt reason code")
        if not isinstance(ttl_seconds,int) or not 60<=ttl_seconds<=86400: raise GuardError("adapter receipt TTL must be 60..86400 seconds")
        checked_at=time.time()
        payload={"name":name,"version":version.strip(),"auth_status":auth_status,"route_status":route_status,"evidence_sha256":evidence_sha256,"executable_sha256":executable_sha256,"method":"operator-attested-isolated-probe-v1","reason_code":reason_code,"checked_at":checked_at,"expires_at":checked_at+ttl_seconds}
        self._write(lambda: None,"adapter.receipt",payload)
    def incident(self,kind,detail): self._write(lambda: None,"incident",{"id":str(uuid.uuid4()),"kind":kind,"detail":detail})
    def snapshot(self):
        with self._thread_lock:
            out={}
            for name in ("campaigns","tasks","leases","receipts","incidents","reconciliation","adapter_receipts"): out[name]=[dict(x) for x in self.db.execute("SELECT * FROM "+name).fetchall()]
            out["events"]=[dict(x) for x in self.db.execute("SELECT * FROM events ORDER BY seq DESC LIMIT 100").fetchall()]
            return out

class Guard:
    def __init__(self,limits=Limits()): self.limits=limits
    def check(self,store):
        if os.statvfs(store.root).f_bavail*os.statvfs(store.root).f_frsize<self.limits.min_free_bytes: raise GuardError("disk circuit breaker")
        if store.db.execute("SELECT count(*) FROM tasks WHERE state IN ('LEASED','RUNNING')").fetchone()[0]>self.limits.max_running: raise GuardError("concurrency circuit breaker")
        if store.db.execute("SELECT count(*) FROM incidents WHERE kind='crash'").fetchone()[0]>=self.limits.max_crashes: raise GuardError("crash circuit breaker")

def readonly_reconcile(repo):
    repo=str(repo)
    def run(args):
        try: p=subprocess.run(["/usr/bin/git","-C",repo,*args],text=True,capture_output=True,timeout=10)
        except (OSError,subprocess.TimeoutExpired) as e: raise GuardError("git reconciliation failed: "+str(e))
        if p.returncode: raise GuardError("git reconciliation failed: "+p.stderr.strip())
        return p.stdout.strip()
    raw=run(["worktree","list","--porcelain"]); worktrees=[]; item={}
    for line in raw.splitlines()+[""]:
        if not line:
            if item:
                path=item.get("worktree")
                if not path: raise GuardError("malformed git worktree evidence")
                item.update({"head":run(["-C",path,"rev-parse","HEAD"]),"branch":"DETACHED" if item.get("detached") else run(["-C",path,"symbolic-ref","--quiet","--short","HEAD"]),"dirty":bool(run(["-C",path,"status","--porcelain=v1","--untracked-files=all"])),"disposition":"EXTERNAL_UNRECONCILED"})
                worktrees.append(item); item={}
            continue
        key,_,value=line.partition(" "); item[key]=value or True
    return {"repo":repo,"head":run(["rev-parse","HEAD"]),"main":run(["rev-parse","main"]),"worktrees":worktrees,"branches":run(["for-each-ref","--format=%(refname:short) %(objectname)","refs/heads"]),"safe_to_promote":False,"state":"RECONCILING","github":"not queried: reconciliation is read-only and offline"}
def validate_scope(scope):
    if not scope or any(x in scope for x in ("..",".git","events.jsonl","state.sqlite","AGENTS.md")): raise GuardError("forbidden task scope")
def validate_change_plan(paths,commands=()):
    for path in paths:
        if any(x in path for x in (".git/","gauntlet/core.py","AGENTS.md")) or path.startswith("/"): raise GuardError("forbidden path")
    for command in commands:
        lower=command.lower()
        if ("rm " in lower and ("test" in lower or "spec" in lower)) or "--no-verify" in lower: raise GuardError("test weakening rejected")
    return True
