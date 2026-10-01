import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyBackup, verifySnapshot } from "../../packages/core/src";
import { prepare } from "./fixture";

export const OPERATIONS = ["capture", "extraction", "canon", "correction", "undo", "purge", "typed-canon", "typed-correction", "typed-undo", "typed-purge", "export", "backup", "restore", "restore-snapshot", "rebuild", "retrieval-rebuild"] as const;
export type Operation = typeof OPERATIONS[number];
export type Cut = "random" | "projection-started" | "acknowledged" | "extraction-journaled" | "purge-admitted";
export interface CampaignOptions {
  seed: number;
  trials: number;
  operations?: readonly Operation[];
  maxDelayMs?: number;
  /** Retain failures under this private output directory. Successful vaults are removed. */
  artifacts?: string;
  cut?: Cut;
  onTrial?: (trial: Trial) => void;
}
export interface Trial {
  operation: Operation;
  trial: number;
  seed: number;
  delay_ms: number;
  killed: boolean;
  completed_before_kill: boolean;
  failure: string | null;
  partial_artifacts: number;
  acknowledgments: number;
}

/** Stable unsigned xorshift32; seed zero has its own nonzero initial state. */
export function random(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x1_0000_0000; };
}

const CHILD = join(import.meta.dir, "child.ts");
const CHILD_TIMEOUT_MS = 20_000;

async function killOperation(root: string, delay: number, cut: Cut): Promise<{ killed: boolean; completed: boolean; failure: string | null }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let completed = false, started = false, timedOut = false;
  const child = Bun.spawn([process.execPath, CHILD, "operate", root, cut], {
    stdout: "pipe", stderr: "pipe",
    ipc(message, subprocess) {
      const value = message as { event?: string };
      if (value.event === "ready") subprocess.send("start");
      if (value.event === "started") {
        started = true;
        if (cut === "random") timer = setTimeout(() => subprocess.kill("SIGKILL"), delay);
      }
      if (value.event === "checkpoint" && cut !== "random") subprocess.kill("SIGKILL");
      if (value.event === "completed") { completed = true; if (timer !== undefined) clearTimeout(timer); }
    },
  });
  const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, CHILD_TIMEOUT_MS);
  // A synchronous purge hook cannot yield to IPC while it retains the writer.
  const checkpoint = cut === "purge-admitted" ? setInterval(() => {
    if (existsSync(join(root, "checkpoint"))) child.kill("SIGKILL");
  }, 5) : undefined;
  // Drain both pipes concurrently: an error must never block waiting for its own stderr reader.
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (stdout || stderr) writeFileSync(join(root, "operation-diagnostics.txt"), stdout + stderr, { mode: 0o600 });
    completed ||= existsSync(join(root, "operation-completed"));
    const killed = started && !completed && child.signalCode === "SIGKILL" && !timedOut;
    return { killed, completed, failure: timedOut ? "operation_timeout" : !killed && !completed && status !== 0 ? "operation_failed" : !started ? "operation_not_started" : null };
  } finally {
    clearTimeout(deadline); if (timer !== undefined) clearTimeout(timer);
    if (checkpoint !== undefined) clearInterval(checkpoint);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

async function restart(root: string, cut: Cut): Promise<string | null> {
  const child = Bun.spawn([process.execPath, CHILD, "recover", root, cut], { stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const deadline = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, CHILD_TIMEOUT_MS);
  try {
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (timedOut) return "recovery_timeout";
    if (stderr) writeFileSync(join(root, "recovery-stderr.txt"), stderr, { mode: 0o600 });
    const result = JSON.parse(stdout) as { ok: boolean; reason?: string };
    return status === 0 && result.ok ? null : result.reason ?? "recovery_failed";
  } catch { return "recovery_process_failed"; }
  finally { clearTimeout(deadline); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
}

export async function runCampaign(options: CampaignOptions): Promise<{ schema: "kizuki.chaos/v1"; seed: number; trials: Trial[]; ok: boolean }> {
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff) throw new Error("seed_must_be_uint32");
  if (!Number.isSafeInteger(options.trials) || options.trials < 1 || options.trials > 10_000) throw new Error("trials_must_be_1_to_10000");
  const maxDelay = options.maxDelayMs ?? 20;
  if (!Number.isSafeInteger(maxDelay) || maxDelay < 0 || maxDelay > 1000) throw new Error("delay_must_be_0_to_1000");
  const operations = options.operations ?? OPERATIONS;
  if (operations.length === 0 || operations.some(value => !OPERATIONS.includes(value))) throw new Error("unknown_operation");
  if (options.cut !== undefined && !["random", "projection-started", "acknowledged", "extraction-journaled", "purge-admitted"].includes(options.cut)) throw new Error("unknown_cut");
  if (options.cut === "projection-started" && (operations.length !== 1 || operations[0] !== "canon")) throw new Error("projection_cut_requires_canon");
  if (options.cut === "extraction-journaled" && (operations.length !== 1 || operations[0] !== "extraction")) throw new Error("journal_cut_requires_extraction");
  if (options.cut === "purge-admitted" && operations.some(value => value !== "purge" && value !== "typed-purge")) throw new Error("purge_cut_requires_purge");
  const acknowledgedOperations: readonly Operation[] = ["capture", "canon", "correction", "undo", "typed-canon", "typed-correction", "typed-undo", "export", "backup", "restore", "restore-snapshot"];
  if (options.cut === "acknowledged" && operations.some(value => !acknowledgedOperations.includes(value))) throw new Error("acknowledged_cut_requires_repeated_writes");
  const next = random(options.seed);
  const trials: Trial[] = [];
  if (options.artifacts !== undefined) mkdirSync(options.artifacts, { recursive: true, mode: 0o700 });
  for (const operation of operations) {
    for (let trial = 0; trial < options.trials; trial++) {
      const delay = Math.floor(next() * (maxDelay + 1));
      const root = mkdtempSync(join(options.artifacts ?? tmpdir(), "kizuki-chaos-"));
      let result: Trial = { operation, trial, seed: options.seed, delay_ms: delay, killed: false, completed_before_kill: false, failure: null, partial_artifacts: 0, acknowledgments: 0 };
      try {
        await prepare(root, operation);
        const killed = await killOperation(root, delay, options.cut ?? "random");
        result = { ...result, killed: killed.killed, completed_before_kill: killed.completed, failure: killed.failure };
        if (result.failure === null) result.failure = await restart(root, options.cut ?? "random");
        const output = join(root, "output");
        if (result.failure === null && existsSync(output)) {
          if (operation === "backup") verifySnapshot(output);
          else if (operation === "export") verifyBackup(output);
        }
        result.partial_artifacts = readdirSync(root).filter(name => name.endsWith(".partial")).length;
        const acknowledged = join(root, "acknowledged.jsonl");
        if (existsSync(acknowledged)) result.acknowledgments = readFileSync(acknowledged, "utf8").split("\n").slice(0, -1).length;
      } catch (error) {
        writeFileSync(join(root, "harness-diagnostics.txt"), error instanceof Error ? error.stack ?? error.message : "unknown failure", { mode: 0o600 });
        result.failure = "fixture_or_artifact_failed";
      } finally {
        trials.push(result);
        if (result.failure !== null) writeFileSync(join(root, "trial.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
        else rmSync(root, { recursive: true, force: true });
        options.onTrial?.(result);
      }
    }
  }
  // A campaign that never interrupted an operation provides no crash evidence for it.
  const ok = trials.every(trial => trial.failure === null) && operations.every(operation => trials.some(trial => trial.operation === operation && trial.killed));
  return { schema: "kizuki.chaos/v1", seed: options.seed, trials, ok };
}
