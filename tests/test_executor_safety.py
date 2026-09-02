import json, os, shutil, subprocess, sys, tempfile, time, unittest
from pathlib import Path
from unittest import mock
from gauntlet.executor import ExecutionError, RunSpec, RunResult, Submission, Supervisor, WorktreeManager, accept_submission, submission_from_result
from gauntlet.process_proof import ProcessProof, ProcessProofError
from gauntlet.safe_io import SafeIOError, read_regular_nofollow

class FakeProof:
    def matches(self, argv): return True

class ExecutorSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.work=self.root/"work";self.work.mkdir();self.exe=sys.executable
    def tearDown(self):self.temp.cleanup()
    def spec(self,**overrides):
        data=dict(campaign_id="camp",task_id="task",attempt=1,controller_epoch=1,lease_scope="scope",lease_token=1,base_sha="a"*40,task_hash="b"*64,worktree=str(self.work),branch="codex/task",argv=(self.exe,"-c","print('ok')"),deadline_monotonic=time.monotonic()+5,execution_enabled=False)
        data.update(overrides);return RunSpec(**data)
    def supervisor(self,*extra):return Supervisor(lambda _:True,(self.exe,*extra))
    def test_bootstrap_hard_disable_never_launches_even_when_authorized(self):
        with self.assertRaises(ExecutionError):self.supervisor().run(self.spec())
        with mock.patch("gauntlet.executor.subprocess.Popen",side_effect=AssertionError("child launch attempted")) as popen:
            with self.assertRaisesRegex(ExecutionError,"hard-disable"):
                self.supervisor().run(self.spec(execution_enabled=True))
        popen.assert_not_called()
        with self.assertRaises(ExecutionError):self.spec(network_allowed=True)
    def test_allowlist_no_shell_and_env_escape(self):
        with self.assertRaises(ExecutionError):self.spec(argv=("sh","-c","true"))
        with self.assertRaises(ExecutionError):self.spec(env={"HOME":"/tmp"})
        with self.assertRaises(ExecutionError):Supervisor(lambda _:True,("/bin/true",)).run(self.spec(execution_enabled=True))
    def test_hard_disable_precedes_a_launchable_command(self):
        yes=shutil.which("yes")
        with mock.patch("gauntlet.executor.subprocess.Popen",side_effect=AssertionError("child launch attempted")) as popen:
            with self.assertRaisesRegex(ExecutionError,"hard-disable"):
                self.supervisor(yes).run(self.spec(execution_enabled=True,argv=(yes,)))
        popen.assert_not_called()
    def test_observed_argv_mismatch(self):
        p=subprocess.Popen((self.exe,"-c","import time;time.sleep(1)"),start_new_session=True)
        try:
            with self.assertRaises(ProcessProofError):ProcessProof.capture(p.pid,(self.exe,"-c","print(1)"))
        finally:p.terminate();p.wait()
    def _repo(self):
        repo=self.root/"repo";subprocess.run(("git","init",str(repo)),check=True,stdout=subprocess.DEVNULL);subprocess.run(("git","-C",str(repo),"config","user.email","t@example.test"),check=True);subprocess.run(("git","-C",str(repo),"config","user.name","Test"),check=True)
        (repo/"base.txt").write_text("base\n");subprocess.run(("git","-C",str(repo),"add","base.txt"),check=True);subprocess.run(("git","-C",str(repo),"commit","-m","base"),check=True,stdout=subprocess.DEVNULL)
        return repo,subprocess.check_output(("git","-C",str(repo),"rev-parse","HEAD"),text=True).strip()
    def test_real_worktree_external_marker_is_clean_and_branch_slash(self):
        repo,sha=self._repo();mgr=WorktreeManager(str(self.root/"trees"),str(repo),git=shutil.which("git"))
        tree=mgr.create("camp","task",1,sha,"codex/task")
        marker=mgr.assert_owned_clean(tree)
        self.assertEqual(marker["path"],str(tree));self.assertFalse((tree/".kizuki-gauntlet-worktree.json").exists())
    def test_dirty_worktree_submission_rejected(self):
        repo,sha=self._repo();mgr=WorktreeManager(str(self.root/"trees"),str(repo),git=shutil.which("git"));tree=mgr.create("camp","task",1,sha,"codex/task")
        (tree/"new.txt").write_text("dirty\n")
        spec=self.spec(worktree=str(tree),base_sha=sha)
        result=RunResult(FakeProof(),0,False,b"",b"",False,False,0,0)
        with self.assertRaises(ExecutionError):submission_from_result(spec,result,mgr)
    def test_clean_committed_descendant_submission_is_evidenced(self):
        repo,sha=self._repo();mgr=WorktreeManager(str(self.root/"trees"),str(repo),git=shutil.which("git"));tree=mgr.create("camp","task",1,sha,"codex/task")
        (tree/"new.txt").write_text("committed\n")
        subprocess.run(("git","-C",str(tree),"add","new.txt"),check=True)
        subprocess.run(("git","-C",str(tree),"commit","-m","worker change"),check=True,stdout=subprocess.DEVNULL)
        spec=self.spec(worktree=str(tree),base_sha=sha)
        result=RunResult(FakeProof(),0,False,b"out",b"err",False,False,0,0)
        submission=submission_from_result(spec,result,mgr)
        self.assertNotEqual(submission.head_sha,sha)
        self.assertEqual(submission.changed_paths,("new.txt",))
    def test_wrong_branch_and_non_descendant_worktrees_are_rejected(self):
        repo,sha=self._repo();mgr=WorktreeManager(str(self.root/"trees"),str(repo),git=shutil.which("git"));tree=mgr.create("camp","task",1,sha,"codex/task")
        subprocess.run(("git","-C",str(tree),"checkout","-b","wrong"),check=True,stdout=subprocess.DEVNULL)
        with self.assertRaisesRegex(ExecutionError,"wrong branch"):mgr.assert_owned_clean(tree)
        subprocess.run(("git","-C",str(tree),"checkout","codex/task"),check=True,stdout=subprocess.DEVNULL)
        marker=mgr._marker("camp","task",1)
        record=json.loads(marker.read_text())
        empty_tree=subprocess.check_output(("git","-C",str(repo),"mktree"),input="",text=True).strip()
        unrelated=subprocess.check_output(("git","-C",str(repo),"commit-tree",empty_tree),input="unrelated\n",text=True).strip()
        record["base_sha"]=unrelated
        marker.write_text(json.dumps(record))
        with self.assertRaisesRegex(ExecutionError,"not a descendant"):mgr.assert_owned_clean(tree)
    def test_stale_submission_rejected_and_nofollow(self):
        submission=Submission("c","t",1,1,"s",1,"a"*40,"b"*40,"c"*64,(),"d"*64,"e"*64,"f"*64,0)
        with self.assertRaises(ExecutionError):accept_submission(submission,lambda _:False)
        target=self.root/"target";target.write_text("x");link=self.root/"link";link.symlink_to(target)
        with self.assertRaises(SafeIOError):read_regular_nofollow(link)

if __name__=="__main__":unittest.main()
