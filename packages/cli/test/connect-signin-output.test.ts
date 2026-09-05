import { expect, test } from "bun:test";
import { DeadlineError } from "@kizuki/core";
import type { CliIo } from "../src/commands";
import { imapSignInNotice, isSafeImapSignInError, sanitizedSignInIo } from "../src/commands/connect";

test("IMAP provider notices are terminal-safe", () => {
  const notices: string[] = [];
  const io: CliIo = {
    env: {},
    vaultOverride: null,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stderrIsTTY: true,
    out() {},
    err: (line) => notices.push(line),
    async prompt() { return ""; },
  };
  sanitizedSignInIo(io).notify("Folders on the server: INBOX\u001b[2J\r\nArchive\u0000");
  expect(notices).toHaveLength(1);
  expect(notices[0]).not.toContain("\u001b");
  expect(notices[0]).not.toContain("\r");
  expect(notices[0]).not.toContain("\n");
  expect(notices[0]).toContain("Folders on the server: INBOX");
});

test("IMAP sign-in notice names the resolved vault without claiming encryption", () => {
  const notice = imapSignInNotice("/tmp/kizuki vault");
  expect(notice).toContain("/tmp/kizuki vault");
  expect(notice).toContain("read-only");
  expect(notice).toContain("Ctrl-C");
  expect(notice).not.toContain("encrypted");
});

test("IMAP sign-in deadline remains actionable", () => {
  expect(isSafeImapSignInError(new DeadlineError("sign-in timed out"))).toBe(true);
});
