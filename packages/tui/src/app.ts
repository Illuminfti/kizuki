import type { Database } from "bun:sqlite";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Dirent } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseFrontmatter } from "@kizuki/core";
import {
  PromoteError,
  SENSITIVITY_LEVELS,
  fileProposal,
  listProposals,
  ownerPromote,
  pageRelPath,
  setProposalStatus,
} from "@kizuki/core/staging";
import type { Sensitivity, StagedProposal } from "@kizuki/core/staging";
import { colorsEnabled, paint, sanitize, truncate } from "./ansi";
import type { Key } from "./keys";
import {
  applyItems,
  initialState,
  reduce,
  resumeAfterEdit,
  withNotice,
} from "./model";
import type { Effect, ReviewItem, ReviewState } from "./model";
import { createTerminal } from "./terminal";
import type { Terminal } from "./terminal";
import { render, viewportFor } from "./view";

export interface ReviewOptions {
  db: Database;
  vaultPath: string;
  /** Enables the `a` batch-promote key (the flag half of the two-key rule). */
  batch?: boolean;
  editor?: string | null;
  terminal?: Terminal;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

export interface ReviewSummary {
  promoted: number;
  rejected: number;
}

const QUEUE_LIMIT = 5000;

interface CanonIndex {
  byId: Map<
    string,
    { relPath: string; body: string; label: Sensitivity | null }
  >;
  byPath: Map<string, { body: string; label: Sensitivity | null }>;
}

function isSensitivity(value: unknown): value is Sensitivity {
  return (
    typeof value === "string" &&
    (SENSITIVITY_LEVELS as readonly string[]).includes(value)
  );
}

function indexCanon(vaultPath: string): CanonIndex {
  const index: CanonIndex = { byId: new Map(), byPath: new Map() };
  const walk = (dir: string, rel: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".kizuki") continue;
      const relPath = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), relPath);
        continue;
      }
      if (
        !entry.isFile() ||
        !entry.name.endsWith(".md") ||
        entry.name === "CANON.md" ||
        entry.name === "SCHEMA.md"
      )
        continue;
      try {
        const page = parseFrontmatter(
          readFileSync(join(dir, entry.name), "utf8"),
        );
        const label = isSensitivity(page.data["sensitivity"])
          ? page.data["sensitivity"]
          : null;
        index.byPath.set(relPath, { body: page.body, label });
        const id = page.data["id"];
        if (typeof id === "string")
          index.byId.set(id, { relPath, body: page.body, label });
      } catch {
        // Unparseable pages are doctor's business; review only needs readable targets.
      }
    }
  };
  walk(vaultPath, "");
  return index;
}

/**
 * A capture's frontmatter title names the connector and time; what the owner
 * scans for is the first line the source actually said, so quoted text wins
 * when it exists.
 */
function titleOf(proposal: StagedProposal): string {
  const lines = sanitize(proposal.body).split("\n");
  if (proposal.kind === "claim") {
    const quoted = lines.find((l) => /^>\s*\S/.test(l));
    if (quoted !== undefined) return truncate(quoted.replace(/^>\s*/, "").trim(), 80);
  }
  const title = proposal.frontmatter["title"];
  if (typeof title === "string" && title.trim().length > 0)
    return sanitize(title.trim());
  const firstLine = lines.find((l) => l.trim().length > 0) ?? "(empty)";
  return truncate(firstLine.trim(), 80);
}

function toItem(proposal: StagedProposal, canon: CanonIndex): ReviewItem {
  let targetPath: string | null = null;
  let current: { body: string; label: Sensitivity | null } | null = null;
  if (proposal.target !== null) {
    const byId = canon.byId.get(proposal.target);
    if (byId !== undefined) {
      targetPath = byId.relPath;
      current = byId;
    } else {
      try {
        const relPath = pageRelPath(proposal);
        const byPath = canon.byPath.get(relPath);
        if (byPath !== undefined) {
          targetPath = relPath;
          current = byPath;
        }
      } catch {
        // An unusable target is refused at promote time; here it is just "no page".
      }
    }
  }
  return {
    proposal,
    title: titleOf(proposal),
    subject: proposal.subjects[0] ?? null,
    targetPath,
    currentBody: current?.body ?? null,
    currentLabel: current?.label ?? null,
  };
}

export function loadItems(db: Database, vaultPath: string): ReviewItem[] {
  const canon = indexCanon(vaultPath);
  return listProposals(db, { status: "pending", limit: QUEUE_LIMIT }).map((p) =>
    toItem(p, canon),
  );
}

export function pickEditor(
  env: Record<string, string | undefined>,
): string | null {
  for (const name of ["VISUAL", "EDITOR"]) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  for (const candidate of ["vim", "nano", "vi"]) {
    if (Bun.which(candidate) !== null) return candidate;
  }
  return null;
}

/** Opens the body in the owner's editor and returns what they saved. */
export function editInEditor(editor: string, body: string, id: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-review-"));
  const file = join(dir, `${id}.md`);
  try {
    writeFileSync(file, body, "utf8");
    const argv = [...editor.split(/\s+/).filter((t) => t.length > 0), file];
    const result = Bun.spawnSync(argv, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0)
      throw new Error(
        `${basename(argv[0] ?? editor)} exited with ${result.exitCode}`,
      );
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runReview(opts: ReviewOptions): Promise<ReviewSummary> {
  const terminal = opts.terminal ?? createTerminal();
  if (!terminal.isTTY) {
    throw new Error(
      "kizuki review needs an interactive terminal; use `kizuki review --list`",
    );
  }
  const env = opts.env ?? process.env;
  const now = opts.now ?? (() => new Date());
  const p = paint(colorsEnabled(env, true));
  const vaultName = basename(opts.vaultPath);

  let state: ReviewState = initialState({
    vaultName,
    today: now().toISOString().slice(0, 10),
    items: loadItems(opts.db, opts.vaultPath),
    batchEnabled: opts.batch === true,
  });

  const draw = (): void => {
    const { cols, rows } = terminal.size();
    terminal.draw(render(state, { cols, rows, paint: p }));
  };

  const reload = (): void => {
    state = applyItems(state, loadItems(opts.db, opts.vaultPath));
  };

  const runEffect = (effect: Effect): boolean => {
    switch (effect.type) {
      case "quit":
        return true;
      case "promote": {
        try {
          const receipt = ownerPromote(opts.db, opts.vaultPath, effect.id, {
            sensitivity: effect.sensitivity,
            ...(effect.editBody === null ? {} : { editBody: effect.editBody }),
          });
          state = withNotice(state, {
            text: `promoted → ${receipt.page_path} (${effect.sensitivity})`,
            tone: "ok",
          });
          state = {
            ...state,
            session: { ...state.session, promoted: state.session.promoted + 1 },
          };
        } catch (error) {
          state = withNotice(state, {
            text: `promote refused: ${errorText(error)}`,
            tone: "error",
          });
        }
        reload();
        return false;
      }
      case "reject": {
        try {
          setProposalStatus(opts.db, effect.id, "rejected", effect.reason);
          state = withNotice(state, {
            text: `rejected (${effect.reason})`,
            tone: "ok",
          });
          state = {
            ...state,
            session: { ...state.session, rejected: state.session.rejected + 1 },
          };
        } catch (error) {
          state = withNotice(state, {
            text: `reject failed: ${errorText(error)}`,
            tone: "error",
          });
        }
        reload();
        return false;
      }
      case "edit": {
        const item = state.items.find(
          (i) => i.proposal.proposal_id === effect.id,
        );
        const editor =
          opts.editor === undefined ? pickEditor(env) : opts.editor;
        if (item === undefined) return false;
        if (editor === null) {
          state = withNotice(state, {
            text: "no editor found: set $EDITOR",
            tone: "error",
          });
          return false;
        }
        try {
          const edited = terminal.suspend(() =>
            editInEditor(editor, item.proposal.body, item.proposal.proposal_id),
          );
          state = resumeAfterEdit(state, effect.id, edited);
        } catch (error) {
          state = withNotice(state, {
            text: `edit aborted: ${errorText(error)}`,
            tone: "error",
          });
        }
        return false;
      }
      case "merge": {
        const item = state.items.find(
          (i) => i.proposal.proposal_id === effect.id,
        );
        if (item === undefined) return false;
        const original = item.proposal;
        try {
          const filed = fileProposal(opts.db, {
            kind: "merge",
            target: original.target,
            body: original.body,
            frontmatter: original.frontmatter,
            provenance: original.provenance,
            subjects: original.subjects,
            producer: original.producer,
            confidence: original.confidence,
          });
          if (filed.outcome === "suppressed")
            throw new PromoteError(
              `content was rejected before: ${filed.reason}`,
            );
          const receipt = ownerPromote(
            opts.db,
            opts.vaultPath,
            filed.proposal.proposal_id,
            { sensitivity: effect.sensitivity },
          );
          setProposalStatus(opts.db, original.proposal_id, "withdrawn");
          state = withNotice(state, {
            text: `merged into ${receipt.page_path} (${effect.sensitivity})`,
            tone: "ok",
          });
          state = {
            ...state,
            session: { ...state.session, promoted: state.session.promoted + 1 },
          };
        } catch (error) {
          state = withNotice(state, {
            text: `merge refused: ${errorText(error)}`,
            tone: "error",
          });
        }
        reload();
        return false;
      }
      case "batch": {
        let done = 0;
        let firstFailure: string | null = null;
        for (const id of effect.ids) {
          try {
            ownerPromote(opts.db, opts.vaultPath, id, {
              sensitivity: effect.sensitivity,
            });
            done += 1;
          } catch (error) {
            firstFailure ??= errorText(error);
          }
        }
        const failed = effect.ids.length - done;
        state = withNotice(state, {
          text:
            failed === 0
              ? `batch: ${done} promoted as ${effect.sensitivity}`
              : `batch: ${done} promoted, ${failed} refused (first: ${firstFailure ?? "unknown"})`,
          tone: failed === 0 ? "ok" : "warn",
        });
        state = {
          ...state,
          session: {
            ...state.session,
            promoted: state.session.promoted + done,
          },
        };
        reload();
        return false;
      }
    }
  };

  const handleKey = (key: Key): boolean => {
    const { cols, rows } = terminal.size();
    const step = reduce(state, key, viewportFor(cols, rows));
    state = step.state;
    for (const effect of step.effects) {
      if (runEffect(effect)) return true;
    }
    return false;
  };

  terminal.enter();
  draw();
  return new Promise<ReviewSummary>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      stopKeys();
      stopResize();
      terminal.leave();
      resolve({ ...state.session });
    };
    const stopResize = terminal.onResize(() => {
      if (!finished) draw();
    });
    const stopKeys = terminal.onKeys((keys) => {
      if (finished) return;
      for (const key of keys) {
        if (handleKey(key)) {
          finish();
          return;
        }
      }
      draw();
    });
  });
}
