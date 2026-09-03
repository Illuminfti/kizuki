import argparse, copy, json, sys
from pathlib import Path
from .core import Store, Guard, GuardError, ConflictError, FencedError, Limits, readonly_reconcile
from .adapters import defaults, validate_identities
from .http import serve
from .safe_io import SafeIOError, sha256_regular_nofollow
from .control_loop import ControlLoop, LoopAlreadyRunning

DEFAULT_CONFIG={"state_dir":"/home/ubuntu/.local/state/kizuki-gauntlet","observer":{"host":"127.0.0.1","port":8765},"loop":{"interval_seconds":30},"limits":{"min_free_bytes":35*1024**3,"max_running":4,"max_attempts":3,"max_crashes":3},"adapters":{}}

def load_config(path=None):
 try:
  cfg=copy.deepcopy(DEFAULT_CONFIG)
  if path:
   config_path=Path(path)
   if not config_path.is_file(): raise ValueError("config file does not exist")
   cfg.update(json.loads(config_path.read_text(encoding="utf-8")))
  cfg["observer"]={**DEFAULT_CONFIG["observer"],**cfg.get("observer",{})}; cfg["loop"]={**DEFAULT_CONFIG["loop"],**cfg.get("loop",{})}; cfg["limits"]={**DEFAULT_CONFIG["limits"],**cfg.get("limits",{})}
  if not isinstance(cfg.get("state_dir"),str) or not cfg["state_dir"].startswith("/"): raise ValueError("state_dir must be an absolute path")
  if cfg["observer"]["host"]!="127.0.0.1": raise ValueError("observer host must be 127.0.0.1")
  if not isinstance(cfg["observer"]["port"],int) or not 1<=cfg["observer"]["port"]<=65535: raise ValueError("observer port invalid")
  if not isinstance(cfg["loop"].get("interval_seconds"),(int,float)) or isinstance(cfg["loop"]["interval_seconds"],bool) or not 1<=cfg["loop"]["interval_seconds"]<=3600: raise ValueError("loop.interval_seconds must be 1..3600")
  if not isinstance(cfg.get("adapters",{}),dict): raise ValueError("adapters must be an object")
  for name, adapter in cfg["adapters"].items():
   if name not in {"codex","claude","cursor","grok"}: raise ValueError("unknown adapter: %s"%name)
   if not isinstance(adapter,dict): raise ValueError("adapters.%s must be an object"%name)
   if "path" in adapter and (not isinstance(adapter["path"],str) or not Path(adapter["path"]).is_absolute()): raise ValueError("adapters.%s.path must be absolute"%name)
   if "timeout_seconds" in adapter and (not isinstance(adapter["timeout_seconds"],(int,float)) or not 0 < adapter["timeout_seconds"] <= 15): raise ValueError("adapters.%s.timeout_seconds invalid"%name)
   if adapter.get("execute_enabled",False) is not False: raise ValueError("adapters.%s.execute_enabled must remain false"%name)
  for key in ("min_free_bytes","max_running","max_attempts","max_crashes"):
   if not isinstance(cfg["limits"].get(key),int) or cfg["limits"][key]<1: raise ValueError("limits.%s must be a positive integer"%key)
  return cfg
 except (OSError, json.JSONDecodeError, ValueError, TypeError, AttributeError) as exc: raise ValueError("invalid config: %s"%exc)

def _campaign(snapshot, campaign_id=None):
 campaigns=snapshot["campaigns"]
 if campaign_id:
  row=next((row for row in campaigns if row["id"]==campaign_id),None)
  if not row: raise GuardError("unknown campaign")
  return row
 if len(campaigns)==1: return campaigns[0]
 if not campaigns: raise GuardError("no campaign: run init first")
 raise GuardError("campaign id required: multiple campaigns exist")

def main(argv=None):
 p=argparse.ArgumentParser(prog="gauntlet"); p.add_argument("--config",default=None); p.add_argument("--state-dir",default=None)
 sub=p.add_subparsers(dest="cmd",required=True); sub.add_parser("init"); sub.add_parser("doctor"); sub.add_parser("probe"); r=sub.add_parser("reconcile"); r.add_argument("repo"); r.add_argument("--campaign"); sub.add_parser("status"); s=sub.add_parser("serve"); s.add_argument("--port",type=int,default=None); sub.add_parser("once"); sub.add_parser("loop"); q=sub.add_parser("quiesce"); q.add_argument("campaign"); q.add_argument("version",type=int); promote=sub.add_parser("promote"); promote.add_argument("campaign"); promote.add_argument("version",type=int); receipt=sub.add_parser("record-adapter"); receipt.add_argument("name",choices=("codex","claude","cursor","grok")); receipt.add_argument("--version",required=True); receipt.add_argument("--auth-status",choices=("READY","FAILED","UNKNOWN"),required=True); receipt.add_argument("--route-status",choices=("READY","QUOTA_BLOCKED","FAILED","UNKNOWN"),required=True); receipt.add_argument("--evidence-file",required=True); receipt.add_argument("--reason-code",choices=("ISOLATED_ROUTE_PROBE","PROVIDER_QUOTA_BLOCKED","AUTH_CHECK","PROBE_FAILED"),required=True); receipt.add_argument("--ttl-seconds",type=int,default=21600)
 a=p.parse_args(argv)
 try: cfg=load_config(a.config)
 except ValueError as exc: print(json.dumps({"ok":False,"error":str(exc)})); return 2
 if a.state_dir:
  if not Path(a.state_dir).is_absolute(): print(json.dumps({"ok":False,"error":"state-dir must be an absolute path"})); return 2
  cfg["state_dir"]=a.state_dir
 try:
  if a.cmd=="loop":
   # Do not even open the controller Store here: the loop owns its own
   # read-only Store lifecycle and never claims controller authority.
   result=ControlLoop(cfg["state_dir"],Limits(**cfg["limits"]), cfg["loop"]["interval_seconds"]).run()
   print(json.dumps({"ok":True,"state":result["state"],"execution_enabled":False,"merge_enabled":False}))
   return 0
  st=Store(cfg["state_dir"]); limits=Limits(**cfg["limits"]); adapters=defaults(cfg["adapters"])
  if a.cmd=="init":
   st.claim_controller()
   existing=st.snapshot()["campaigns"]
   if len(existing)>1: raise GuardError("multiple campaigns exist; init will not choose or create another")
   campaign=existing[0] if existing else {"id":st.create_campaign(),"state":"RECONCILING","version":1}
   print(json.dumps({"ok":True,"campaign_id":campaign["id"],"state":campaign["state"],"version":campaign["version"],"observer_only":True})); st.release_controller()
  elif a.cmd=="doctor":
   st.verify_integrity(); Guard(limits).check(st); print(json.dumps({"ok":True,"wal":True,"event_chain":True,"observer_only":True}))
  elif a.cmd=="probe": print(json.dumps([adapter.probe() for adapter in adapters]))
  elif a.cmd=="reconcile":
   evidence=readonly_reconcile(a.repo); st.claim_controller(); campaign=_campaign(st.snapshot(),a.campaign)
   if campaign["state"]!="RECONCILING": raise GuardError("reconciliation requires a RECONCILING campaign")
   st.record_reconciliation(campaign["id"],evidence)
   print(json.dumps({"ok":True,"campaign_id":campaign["id"],"state":campaign["state"],"evidence":evidence})); st.release_controller()
  elif a.cmd=="status": print(json.dumps(st.snapshot(),default=str))
  elif a.cmd=="once":
   st.claim_controller(); st.verify_integrity(); Guard(limits).check(st); print(json.dumps({"ok":True,"action":"no harness execution in observer/bootstrap controller"})); st.release_controller()
  elif a.cmd=="quiesce":
   st.claim_controller(); version=st.campaign_state(a.campaign,"QUIESCING",a.version); print(json.dumps({"ok":True,"campaign_id":a.campaign,"state":"QUIESCING","version":version})); st.release_controller()
  elif a.cmd=="promote":
   st.claim_controller(); version=st.campaign_state(a.campaign,"READY",a.version); print(json.dumps({"ok":True,"campaign_id":a.campaign,"state":"READY","version":version})); st.release_controller()
  elif a.cmd=="record-adapter":
   evidence_path=Path(a.evidence_file)
   if not evidence_path.is_absolute(): raise GuardError("evidence file must be absolute")
   adapter=next(item for item in adapters if item.name==a.name); probe=adapter.probe()
   if not probe.get("version_probe_ok") or probe.get("version")!=a.version: raise GuardError("adapter version does not match live fixed-argv probe")
   executable=adapter._resolved()
   if executable is None: raise GuardError("adapter executable is unavailable")
   evidence_sha256=sha256_regular_nofollow(evidence_path,16*1024**2)
   executable_sha256=sha256_regular_nofollow(executable,1024**3)
   st.claim_controller(); st.record_adapter_receipt(a.name,a.version,a.auth_status,a.route_status,evidence_sha256,executable_sha256,a.reason_code,a.ttl_seconds); print(json.dumps({"ok":True,"adapter":a.name,"auth_status":a.auth_status,"route_status":a.route_status,"method":"operator-attested-isolated-probe-v1","expires_in_seconds":a.ttl_seconds})); st.release_controller()
  elif a.cmd=="serve":
   st.claim_controller(); st.verify_integrity(); Guard(limits).check(st); refresh_identity=lambda:validate_identities(adapters,st.snapshot()["adapter_receipts"]); identity=refresh_identity(); port=a.port or cfg["observer"]["port"]; srv=serve(st,adapters,host=cfg["observer"]["host"],port=port,guard=Guard(limits),adapter_identities=identity,adapter_identity_refresh=refresh_identity); print(json.dumps({"host":"127.0.0.1","port":port,"observer_only":True,"controller_epoch":st.claimed_epoch}));
   try: srv.serve_forever()
   finally: srv.server_close(); st.release_controller()
  return 0
 except (GuardError, ConflictError, FencedError, SafeIOError, LoopAlreadyRunning, OSError, ValueError, TypeError, AttributeError) as exc:
  try: st.release_controller()
  except Exception: pass
  print(json.dumps({"ok":False,"error":str(exc)})); return 2
 finally:
  if 'st' in locals() and a.cmd != "serve": st.close()
if __name__=="__main__": raise SystemExit(main())
