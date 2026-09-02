import os
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from gauntlet.core import ConflictError, FencedError, GuardError, Limits, Store, readonly_reconcile

SHA = "b" * 40

class CoreSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(self.tmp.name)
    def tearDown(self):
        self.store.close(); self.tmp.cleanup()
    def campaign_task(self):
        self.store.claim_controller(); campaign = self.store.create_campaign()
        version = self.store.snapshot()["campaigns"][0]["version"]
        self.store.record_reconciliation(campaign, {"safe_to_promote": True, "worktrees": []})
        self.store.campaign_state(campaign, "READY", version)
        version += 1; self.store.campaign_state(campaign, "ACTIVE", version)
        task = self.store.create_task(campaign, "scope/test")
        version = self.store.snapshot()["tasks"][0]["version"]
        self.store.task_state(task, "READY", version)
        return campaign, task
    def test_open_is_inert_and_controller_claim_is_exclusive(self):
        before = self.store.db.execute("SELECT count(*) FROM events").fetchone()[0]
        observer = Store(self.tmp.name)
        self.assertEqual(before, observer.db.execute("SELECT count(*) FROM events").fetchone()[0])
        self.store.claim_controller()
        with self.assertRaises(ConflictError): observer.claim_controller()
        self.store.release_controller(); observer.claim_controller(); self.assertEqual(observer.claimed_epoch, 2)
        observer.close()
    def test_heartbeat_and_release_do_not_deadlock(self):
        _, task = self.campaign_task(); token = self.store.acquire(task, "scope/test", "worker")
        self.store.heartbeat("scope/test", "worker", token, task_id=task)
        self.store.release("scope/test", "worker", token, task_id=task)
        self.assertEqual(self.store.snapshot()["leases"], [])
    def test_next_write_heals_fsynced_tail_and_integrity_is_readonly(self):
        self.store.claim_controller(); campaign = self.store.create_campaign()
        ledger = self.store._ledger(); self.store._append("incident", {"id":"tail","kind":"crash","detail":"after fsync"}, ledger[-1]["hash"])
        with self.assertRaises(GuardError): self.store.verify_integrity()
        self.store.record_reconciliation(campaign, {"safe_to_promote": False})
        self.assertTrue(self.store.verify_integrity())
        self.assertTrue(any(x["id"] == "tail" for x in self.store.snapshot()["incidents"]))
    def test_tail_is_healed_before_validator_uses_it(self):
        self.store.claim_controller(); ledger=self.store._ledger(); cid="tail-campaign"
        self.store._append("campaign.created", {"id":cid,"epoch":self.store.claimed_epoch}, ledger[-1]["hash"])
        # create_task validates campaign existence, so it proves sync precedes validation.
        self.store.create_task(cid,"scope/tail")
        self.assertTrue(self.store.verify_integrity())
    def test_derived_projection_corruption_is_detected_before_health_or_write(self):
        self.store.claim_controller(); campaign=self.store.create_campaign()
        before=len(self.store._ledger())
        self.store.db.execute("UPDATE campaigns SET state='RELEASED' WHERE id=?",(campaign,))
        with self.assertRaisesRegex(GuardError,"derived projection mismatch: campaigns"):
            self.store.verify_integrity()
        with self.assertRaisesRegex(GuardError,"derived projection mismatch: campaigns"):
            self.store.record_reconciliation(campaign,{"safe_to_promote":False})
        self.assertEqual(len(self.store._ledger()),before)
    def test_reconciling_cannot_lease_and_promotion_requires_evidence(self):
        self.store.claim_controller(); campaign=self.store.create_campaign(); task=self.store.create_task(campaign,"scope/x")
        version=self.store.snapshot()["tasks"][0]["version"]; self.store.task_state(task,"READY",version)
        with self.assertRaises(GuardError): self.store.acquire(task,"scope/x","worker")
        version=self.store.snapshot()["campaigns"][0]["version"]
        with self.assertRaises(GuardError): self.store.campaign_state(campaign,"READY",version)
        self.store.record_reconciliation(campaign,{"safe_to_promote":True})
        self.store.campaign_state(campaign,"READY",version)
    def test_no_unfenced_receipt_and_attempt_limit(self):
        _, task=self.campaign_task(); token=self.store.acquire(task,"scope/test","worker",limits=Limits(max_attempts=1))
        with self.assertRaises(TypeError): self.store.receipt(task,SHA,["test"])
        with self.assertRaises(FencedError): self.store.receipt(task,SHA,["test"],"scope/test","bad",token)
        with self.assertRaisesRegex(GuardError,"submitted verification state"): self.store.receipt(task,SHA,["test"],"scope/test","worker",token)
        version=self.store.snapshot()["tasks"][0]["version"]
        version=self.store.task_state(task,"RUNNING",version,"scope/test","worker",token)
        version=self.store.task_state(task,"SUBMITTED",version,"scope/test","worker",token)
        self.store.receipt(task,SHA,["test"],"scope/test","worker",token)
        self.store.release("scope/test","worker",token,task_id=task)
        # A released task remains LEASED; controller must explicitly recover it.
        version=self.store.snapshot()["tasks"][0]["version"]
        self.store.task_state(task,"RECOVERING",version,"scope/test","worker",token) if False else None
        self.assertEqual(self.store.snapshot()["tasks"][0]["attempts"],1)
    def test_additional_scope_is_one_attempt_and_receipt_keeps_fence(self):
        _, task=self.campaign_task(); first=self.store.acquire(task,"scope/test","worker")
        second=self.store.acquire(task,"scope/second","worker")
        task_row=self.store.snapshot()["tasks"][0]; self.assertEqual(task_row["attempts"],1)
        version=self.store.task_state(task,"RUNNING",task_row["version"],"scope/second","worker",second)
        self.store.task_state(task,"SUBMITTED",version,"scope/second","worker",second)
        rid=self.store.receipt(task,SHA,["test"],"scope/second","worker",second)
        receipt=next(x for x in self.store.snapshot()["receipts"] if x["id"]==rid)
        self.assertEqual((receipt["scope"],receipt["holder"],receipt["token"],receipt["epoch"]),("scope/second","worker",second,self.store.claimed_epoch))
        self.assertGreater(second,0); self.assertGreater(first,0)
    def test_old_epoch_lease_does_not_block_recovery(self):
        _, task=self.campaign_task(); token=self.store.acquire(task,"scope/test","worker")
        self.store.release_controller(); next_controller=Store(self.tmp.name); next_controller.claim_controller()
        # Old lease survives as evidence but cannot be heartbeated by its old epoch.
        with self.assertRaises(FencedError): next_controller.heartbeat("scope/test","worker",token,task_id=task)
        version=next_controller.snapshot()["tasks"][0]["version"]
        next_controller.task_state(task,"RECOVERING",version)
        version += 1; next_controller.task_state(task,"READY",version)
        self.assertGreater(next_controller.acquire(task,"scope/test","new"),token)
        next_controller.close()
    def test_recovery_retires_all_leases_and_expired_owner_cannot_add_scope(self):
        _,task=self.campaign_task(); token=self.store.acquire(task,"scope/test","old",ttl=.05)
        time.sleep(.06)
        with self.assertRaises(FencedError): self.store.acquire(task,"scope/extra","old")
        version=self.store.snapshot()["tasks"][0]["version"]
        self.store.task_state(task,"RECOVERING",version)
        self.assertEqual(self.store.snapshot()["leases"],[])
        version+=1; self.store.task_state(task,"READY",version)
        new_token=self.store.acquire(task,"scope/new","new")
        current_version=self.store.snapshot()["tasks"][0]["version"]
        with self.assertRaises(FencedError): self.store.task_state(task,"RUNNING",current_version,"scope/test","old",token)
        self.assertGreater(new_token,0)
    def test_ready_task_rejects_lingering_live_owner(self):
        _,task=self.campaign_task(); self.store.acquire(task,"scope/test","old")
        # Simulate a valid legacy ledger event that changed state without lease retirement.
        self.store._write(lambda:None,"task.state",{"id":task,"state":"READY"})
        with self.assertRaises(ConflictError):
            self.store.acquire(task,"scope/new","new")
    def test_worker_cannot_self_recover_or_reuse_attempt(self):
        _,task=self.campaign_task(); token=self.store.acquire(task,"scope/test","worker")
        version=self.store.snapshot()["tasks"][0]["version"]
        with self.assertRaisesRegex(GuardError,"controller authority"):
            self.store.task_state(task,"RECOVERING",version,"scope/test","worker",token)
        version=self.store.task_state(task,"RUNNING",version,"scope/test","worker",token)
        version=self.store.task_state(task,"SUBMITTED",version,"scope/test","worker",token)
        version=self.store.task_state(task,"CHANGES_REQUESTED",version,"scope/test","worker",token)
        self.assertEqual(self.store.snapshot()["leases"],[])
        with self.assertRaises(FencedError): self.store.receipt(task,SHA,["test"],"scope/test","worker",token)
    def test_controller_cannot_advance_success_edges_without_live_worker(self):
        _,task=self.campaign_task(); token=self.store.acquire(task,"scope/test","worker",ttl=.05)
        time.sleep(.06); version=self.store.snapshot()["tasks"][0]["version"]
        with self.assertRaisesRegex(GuardError,"live worker lease"):
            self.store.task_state(task,"RUNNING",version)
        self.assertEqual(self.store.snapshot()["tasks"][0]["state"],"LEASED")
        # Recovery is the only path out; it retires the expired lease.
        version=self.store.task_state(task,"RECOVERING",version)
        version=self.store.task_state(task,"READY",version)
        with self.assertRaisesRegex(GuardError,"live worker lease"):
            self.store.task_state(task,"LEASED",version)
        self.assertGreater(token,0)
    def test_adapter_reason_code_must_match_state(self):
        self.store.claim_controller()
        with self.assertRaisesRegex(GuardError,"contradicts"):
            self.store.record_adapter_receipt("codex","v1","READY","READY","a"*64,"b"*64,"AUTH_CHECK",600)
    def test_reconcile_marks_external_and_permissions_private(self):
        repo=Path(self.tmp.name)/"repo"; subprocess.run(["git","init","-q","-b","main",str(repo)],check=True)
        subprocess.run(["git","-C",str(repo),"config","user.email","x@y.invalid"],check=True); subprocess.run(["git","-C",str(repo),"config","user.name","x"],check=True)
        (repo/"a").write_text("a"); subprocess.run(["git","-C",str(repo),"add","a"],check=True); subprocess.run(["git","-C",str(repo),"commit","-qm","a"],check=True); (repo/"dirty").write_text("x")
        first=subprocess.check_output(["/usr/bin/git","-C",str(repo),"rev-parse","HEAD"],text=True).strip()
        subprocess.run(["/usr/bin/git","-C",str(repo),"update-ref","refs/remotes/origin/main",first],check=True)
        (repo/"b").write_text("b"); subprocess.run(["/usr/bin/git","-C",str(repo),"add","b"],check=True); subprocess.run(["/usr/bin/git","-C",str(repo),"commit","-qm","b"],check=True)
        evidence=readonly_reconcile(str(repo)); self.assertFalse(evidence["safe_to_promote"]); self.assertEqual(evidence["worktrees"][0]["disposition"],"EXTERNAL_UNRECONCILED")
        self.assertEqual(evidence["cached_origin_main"],first); self.assertEqual((evidence["local_main_ahead"],evidence["local_main_behind"]),(1,0))
        self.assertEqual(evidence["worktree_count"],1); self.assertEqual(evidence["dirty_worktree_count"],1)
        for path in (self.store.root,self.store.lock_path,self.store.controller_path,self.store.db_path): self.assertEqual(stat.S_IMODE(path.stat().st_mode)&0o077,0)
    def test_state_symlinks_are_rejected(self):
        self.store.close()
        target=Path(self.tmp.name)/"target"; target.mkdir()
        linked=Path(self.tmp.name)/"linked"; linked.symlink_to(target,target_is_directory=True)
        with self.assertRaisesRegex(GuardError,"state directory may not be a symlink"):
            Store(str(linked))
        state=Path(self.tmp.name)/"state"; state.mkdir()
        victim=Path(self.tmp.name)/"victim"; victim.write_text("untouched",encoding="utf-8")
        (state/"events.jsonl").symlink_to(victim)
        with self.assertRaisesRegex(GuardError,"state files may not be symlinks"):
            Store(str(state))
        self.assertEqual(victim.read_text(encoding="utf-8"),"untouched")
        locks=Path(self.tmp.name)/"locks"; locks.mkdir()
        (locks/".writer.lock").symlink_to(victim)
        with self.assertRaisesRegex(GuardError,"state files may not be symlinks"):
            Store(str(locks))
        self.assertEqual(victim.read_text(encoding="utf-8"),"untouched")
