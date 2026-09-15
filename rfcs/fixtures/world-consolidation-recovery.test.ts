/** Design-only recovery traces. Consistency is computed from records, not a stored pass flag. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const EXAMPLE = join(ROOT, "rfcs/fixtures/world-consolidation-recovery-design.json");

type Attempt = {
  id: string;
  boundary: string;
  saved_result: boolean;
  filed: boolean;
  acked: boolean;
  producer_calls: number;
  unknown_consumption: boolean;
  unknown_charged_as_zero: boolean;
  committed_effects: string[];
  progress: number;
};

type Job = {
  id: string;
  policy_prepared: string[];
  policy_current: string[];
  input_refs: string[];
  replay_from_prepared: boolean;
  blocked_because_other_job_narrowed: boolean;
  cross_store_atomic_transaction: boolean;
  attempts: Attempt[];
};

type Fixture = {
  id: string;
  evaluation_state: string;
  status: string;
  jobs: Job[];
};

function load(): Fixture {
  return JSON.parse(readFileSync(EXAMPLE, "utf8")) as Fixture;
}

function filedEffects(job: Job): string[] {
  const ids: string[] = [];
  for (const attempt of job.attempts) {
    if (!attempt.filed) continue;
    for (const effect of attempt.committed_effects) {
      if (!ids.includes(effect)) ids.push(effect);
    }
  }
  return ids;
}

function jobErrors(job: Job): string[] {
  const errors: string[] = [];
  if (job.input_refs.length === 0) errors.push(`${job.id}: omitted input presented as complete`);
  if (job.cross_store_atomic_transaction) errors.push(`${job.id}: invented a SQLite-plus-Markdown transaction`);
  if (job.blocked_because_other_job_narrowed) errors.push(`${job.id}: blocked solely because another job narrowed`);
  const currentDerive = job.policy_current.includes("derive");
  if (!currentDerive && job.replay_from_prepared) {
    errors.push(`${job.id}: replayed under the prepared policy after derive was removed`);
  }
  const filed = filedEffects(job);
  if (job.id === "policy_narrowing") {
    if (currentDerive) errors.push(`${job.id}: current policy still permits derive`);
    if (filed.length !== 0) errors.push(`${job.id}: narrowed policy still committed a derive effect`);
  } else if (job.id !== "crash_before_result" && job.attempts.every((attempt) => attempt.boundary !== "refused")) {
    if (filed.length !== 1) errors.push(`${job.id}: committed effects are not one logical result (${filed.join(",")})`);
  }
  if (job.id === "crash_before_result") {
    const first = job.attempts[0];
    if (!first || first.committed_effects.length !== 0 || first.filed) errors.push(`${job.id}: pre-result crash invented a commit`);
    if (first?.unknown_charged_as_zero) errors.push(`${job.id}: unknown consumption charged as zero`);
    if (filed.length !== 1) errors.push(`${job.id}: restart did not produce the one filed effect`);
  }
  if (job.id === "crash_after_save_before_file") {
    const retry = job.attempts[1];
    if (!retry || retry.producer_calls !== 0) errors.push(`${job.id}: recovery called the producer again`);
  }
  if (job.id === "crash_after_file_before_ack" || job.id === "ack_lost") {
    const first = job.attempts[0]?.committed_effects ?? [];
    const retry = job.attempts[1]?.committed_effects ?? [];
    if (retry.join() !== first.join()) errors.push(`${job.id}: re-delivery changed the committed effect identity`);
    if ((job.attempts[1]?.producer_calls ?? 1) !== 0) errors.push(`${job.id}: re-delivery called the producer again`);
  }
  for (const attempt of job.attempts) {
    if (attempt.progress > attempt.committed_effects.length && attempt.filed) {
      errors.push(`${job.id}/${attempt.id}: progress ahead of durable output`);
    }
    if (!attempt.filed && attempt.progress > 0) errors.push(`${job.id}/${attempt.id}: progress without a filed result`);
    if (attempt.unknown_consumption && attempt.unknown_charged_as_zero) {
      errors.push(`${job.id}/${attempt.id}: unknown call charged as zero`);
    }
  }
  return errors;
}

function recoveryErrors(example: Fixture): string[] {
  const errors: string[] = [];
  if (example.evaluation_state !== "not_run") errors.push("example must remain not_run");
  if (example.status !== "future_unimplemented") errors.push("example must remain unimplemented");
  if (example.id !== "crash-restart-duplicate-narrowing-recovery") errors.push("unexpected example id");
  const ids = example.jobs.map((job) => job.id);
  if (
    ids.join() !==
    "crash_before_result,crash_after_save_before_file,crash_after_file_before_ack,canon_materialization,ack_lost,policy_narrowing,unaffected_job"
  ) {
    errors.push("required jobs drifted");
  }
  for (const job of example.jobs) errors.push(...jobErrors(job));
  return errors;
}

test("crash, re-delivery and policy narrowing preserve one logical result", () => {
  expect(recoveryErrors(load())).toEqual([]);
});

test("a second effect, prepared-policy replay, unknown-as-zero or implemented status fail", () => {
  const example = load();
  expect(recoveryErrors(example)).toEqual([]);
  const filed = example.jobs.find((job) => job.id === "crash_after_file_before_ack")!;
  const narrowing = example.jobs.find((job) => job.id === "policy_narrowing")!;
  const before = example.jobs.find((job) => job.id === "crash_before_result")!;
  expect(
    recoveryErrors({
      ...example,
      jobs: example.jobs.map((job) =>
        job.id === filed.id
          ? {
              ...job,
              attempts: job.attempts.map((attempt, index) =>
                index === 1 ? { ...attempt, committed_effects: ["e_filed", "e_dup"], progress: 2 } : attempt,
              ),
            }
          : job,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    recoveryErrors({
      ...example,
      jobs: example.jobs.map((job) =>
        job.id === narrowing.id ? { ...job, replay_from_prepared: true, policy_current: ["capture", "recall"] } : job,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(
    recoveryErrors({
      ...example,
      jobs: example.jobs.map((job) =>
        job.id === before.id
          ? {
              ...job,
              attempts: job.attempts.map((attempt, index) =>
                index === 0 ? { ...attempt, unknown_charged_as_zero: true } : attempt,
              ),
            }
          : job,
      ),
    }).length,
  ).toBeGreaterThan(0);
  expect(recoveryErrors({ ...example, status: "implemented", evaluation_state: "pass" }).length).toBeGreaterThan(0);
});
