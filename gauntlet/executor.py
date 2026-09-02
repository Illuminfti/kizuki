"""Execution validation primitives; process launch is hard-disabled in this bootstrap.

The eventual worker runner must replace ``Supervisor.run`` with an outer OS
sandbox implementation.  Keeping this gate here means a caller cannot turn
on direct host execution merely by setting ``RunSpec.execution_enabled``.
"""
import hashlib, json, os, subprocess, time
from dataclasses import dataclass, field
from pathlib import Path
from .process_proof import ProcessProof, argv_digest
from .safe_io import SafeIOError, read_regular_nofollow

class ExecutionError(RuntimeError): pass
HEX=set("0123456789abcdef")
def _sha(value,name,length=40):
    if not isinstance(value,str) or len(value)!=length or any(c not in HEX for c in value): raise ExecutionError(f"{name} must be lowercase hex ({length})")
def _component(value): return isinstance(value,str) and bool(value) and all(c.isalnum() or c in "._-" for c in value)

@dataclass(frozen=True)
class RunSpec:
    campaign_id:str; task_id:str; attempt:int; controller_epoch:int; lease_scope:str; lease_token:int; base_sha:str; task_hash:str
    worktree:str; branch:str; argv:tuple; deadline_monotonic:float
    # Requested budgets, not enforcement guarantees until an OS sandbox is added.
    log_bytes:int=1_048_576; cpu_seconds:int=300; memory_bytes:int=2*1024**3; network_allowed:bool=False; execution_enabled:bool=False; env:dict=field(default_factory=dict)
    def __post_init__(self):
        if not all(isinstance(x,str) and x for x in (self.campaign_id,self.task_id,self.lease_scope,self.branch)): raise ExecutionError("incomplete identity")
        if self.attempt<1 or self.controller_epoch<1 or self.lease_token<1: raise ExecutionError("invalid fence identity")
        _sha(self.base_sha,"base_sha"); _sha(self.task_hash,"task_hash",64)
        if not self.argv or any(not isinstance(x,str) or not x or "\0" in x for x in self.argv): raise ExecutionError("invalid argv")
        exe=Path(self.argv[0])
        if not exe.is_absolute() or not exe.is_file() or not os.access(str(exe),os.X_OK) or exe.name in {"sh","bash","zsh","dash","fish"}: raise ExecutionError("unsafe executable")
        path=Path(self.worktree).resolve()
        if not Path(self.worktree).is_absolute() or not path.is_dir(): raise ExecutionError("worktree must be absolute existing path")
        object.__setattr__(self,"worktree",str(path))
        if self.deadline_monotonic<=time.monotonic() or min(self.log_bytes,self.cpu_seconds,self.memory_bytes)<1: raise ExecutionError("invalid requested budget")
        if self.network_allowed: raise ExecutionError("networked execution is not implemented")
        if any(k not in {"LANG","LC_ALL","TZ"} or not isinstance(v,str) or "\0" in v for k,v in self.env.items()): raise ExecutionError("environment key not allowlisted")

@dataclass(frozen=True)
class Submission:
    campaign_id:str; task_id:str; attempt:int; controller_epoch:int; lease_scope:str; lease_token:int; base_sha:str; head_sha:str; diff_sha256:str; changed_paths:tuple; argv_sha256:str; stdout_sha256:str; stderr_sha256:str; exit_code:int
    def __post_init__(self):
        for key in ("base_sha","head_sha"): _sha(getattr(self,key),key)
        for key in ("diff_sha256","argv_sha256","stdout_sha256","stderr_sha256"): _sha(getattr(self,key),key,64)
        if self.exit_code!=0: raise ExecutionError("failed run is not submittable")
@dataclass(frozen=True)
class RunResult:
    proof:ProcessProof; exit_code:int; timed_out:bool; stdout:bytes; stderr:bytes; stdout_truncated:bool; stderr_truncated:bool; started_at:float; ended_at:float

def normalized_event(previous_hash,event_type,payload):
    event={"prev":previous_hash,"type":event_type,"payload":payload};event["hash"]=hashlib.sha256(json.dumps(event,sort_keys=True,separators=(",",":")).encode()).hexdigest();return event

class Supervisor:
    def __init__(self,authorize,allowed_executables,event_sink=None,safe_env=None):
        self.authorize=authorize;self.event_sink=event_sink
        self.allowed={str(Path(x).resolve()) for x in allowed_executables if Path(x).is_absolute()}
        if not self.allowed:raise ExecutionError("explicit absolute executable allowlist required")
        self.safe_env=dict(safe_env or {"PATH":"/usr/bin:/bin","HOME":"/nonexistent","LANG":"C","LC_ALL":"C"})
    def _emit(self,prev,kind,payload):
        event=normalized_event(prev,kind,payload)
        if self.event_sink:self.event_sink(event)
        return event["hash"]
    def run(self,spec):
        if not spec.execution_enabled or not self.authorize(spec):raise ExecutionError("per-run opt-in and controller authorization required")
        if str(Path(spec.argv[0]).resolve()) not in self.allowed:raise ExecutionError("executable is not allowlisted")
        raise ExecutionError("bootstrap hard-disable: an outer OS sandbox runner is required before process execution")

class WorktreeManager:
    """Never cleans or deletes. Registration is outside worktrees so clean checks are real."""
    REGISTRY=".kizuki-gauntlet-registry"
    def __init__(self,root,repository,git="/usr/bin/git"):
        self.root=Path(root).resolve();self.repository=Path(repository).resolve();self.git=git;self.registry=self.root/self.REGISTRY
        if not self.root.is_absolute() or not self.repository.is_dir() or not os.path.isabs(git):raise ExecutionError("absolute root/repository/git required")
    def _git(self,*args):return subprocess.run((self.git,*args),stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=False,shell=False)
    def _target(self,campaign,task,attempt):
        if attempt<1 or not _component(campaign) or not _component(task):raise ExecutionError("unsafe worktree identity")
        target=(self.root/campaign/task/str(attempt)).resolve()
        if self.root not in target.parents:raise ExecutionError("worktree escapes root")
        return target
    def _marker(self,campaign,task,attempt):return self.registry/campaign/task/(str(attempt)+".json")
    def create(self,campaign,task,attempt,base_sha,branch):
        _sha(base_sha,"base_sha");target=self._target(campaign,task,attempt);marker=self._marker(campaign,task,attempt)
        if not isinstance(branch,str) or not branch or any(ord(c)<32 for c in branch) or ".." in branch or branch.startswith("/") or self._git("check-ref-format","--branch",branch).returncode:raise ExecutionError("unsafe branch")
        if target.exists() or marker.exists():raise ExecutionError("worktree or registration exists")
        target.parent.mkdir(parents=True,exist_ok=True,mode=0o700);marker.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        if self._git("-C",str(self.repository),"worktree","add","-b",branch,str(target),base_sha).returncode or not target.is_dir():raise ExecutionError("git refused safe worktree creation")
        head=self._git("-C",str(target),"rev-parse","HEAD").stdout.decode().strip()
        if head!=base_sha:raise ExecutionError("worktree is not exact base")
        data={"owned_by":"kizuki-gauntlet","campaign_id":campaign,"task_id":task,"attempt":attempt,"base_sha":base_sha,"head_sha":head,"branch":branch,"path":str(target)}
        try:
            fd=os.open(str(marker),os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
            with os.fdopen(fd,"w",encoding="utf-8") as stream:json.dump(data,stream,sort_keys=True);stream.write("\n");stream.flush();os.fsync(stream.fileno())
        except OSError as exc:raise ExecutionError("cannot safely register worktree") from exc
        return target
    def assert_owned_clean(self,target):
        target=Path(target).resolve()
        if self.root not in target.parents:raise ExecutionError("worktree escapes root")
        parts=target.relative_to(self.root).parts
        if len(parts)!=3 or not parts[2].isdigit():raise ExecutionError("unregistered worktree path")
        try:data=json.loads(read_regular_nofollow(self._marker(parts[0],parts[1],int(parts[2])),65536).decode())
        except (SafeIOError,UnicodeError,ValueError) as exc:raise ExecutionError("invalid external registration") from exc
        if data.get("owned_by")!="kizuki-gauntlet" or data.get("path")!=str(target):raise ExecutionError("foreign registration")
        listed=self._git("-C",str(self.repository),"worktree","list","--porcelain").stdout.decode(errors="replace")
        if "worktree "+str(target)+"\n" not in listed:raise ExecutionError("target not a registered worktree")
        branch=self._git("-C",str(target),"symbolic-ref","--quiet","--short","HEAD")
        if branch.returncode or branch.stdout.decode().strip()!=data.get("branch"):raise ExecutionError("worktree is on the wrong branch")
        head_result=self._git("-C",str(target),"rev-parse","HEAD")
        if head_result.returncode:raise ExecutionError("worktree head is unavailable")
        head=head_result.stdout.decode().strip();_sha(head,"head_sha")
        base=data.get("base_sha")
        try:_sha(base,"registered base_sha")
        except ExecutionError as exc:raise ExecutionError("invalid external registration") from exc
        if self._git("-C",str(target),"merge-base","--is-ancestor",base,head).returncode:raise ExecutionError("worktree head is not a descendant of registered base")
        status=self._git("-C",str(target),"status","--porcelain")
        if status.returncode or status.stdout.strip():raise ExecutionError("worktree is dirty")
        return {**data,"head_sha":head}

def submission_from_result(spec,result,worktrees):
    if result.exit_code!=0 or result.timed_out or not result.proof.matches(spec.argv):raise ExecutionError("only successful proven runs submit")
    mark=worktrees.assert_owned_clean(spec.worktree)
    if any(mark.get(k)!=v for k,v in {"campaign_id":spec.campaign_id,"task_id":spec.task_id,"attempt":spec.attempt,"base_sha":spec.base_sha,"branch":spec.branch,"path":spec.worktree}.items()):raise ExecutionError("spec/registration mismatch")
    def out(*args):
        p=worktrees._git("-C",spec.worktree,*args)
        if p.returncode:raise ExecutionError("git evidence failed")
        return p.stdout
    head=out("rev-parse","HEAD").decode().strip();_sha(head,"head_sha")
    paths=tuple(x.decode("utf-8","surrogateescape") for x in out("diff","--name-only","-z",spec.base_sha,"HEAD").split(b"\0") if x)
    if any(x.startswith("/") or ".." in Path(x).parts for x in paths):raise ExecutionError("invalid changed path")
    return Submission(spec.campaign_id,spec.task_id,spec.attempt,spec.controller_epoch,spec.lease_scope,spec.lease_token,spec.base_sha,head,hashlib.sha256(out("diff","--binary",spec.base_sha,"HEAD")).hexdigest(),paths,argv_digest(spec.argv),hashlib.sha256(result.stdout).hexdigest(),hashlib.sha256(result.stderr).hexdigest(),result.exit_code)
def accept_submission(submission,current):
    if not current(submission):raise ExecutionError("stale controller epoch, lease fence, or task state")
    return submission
