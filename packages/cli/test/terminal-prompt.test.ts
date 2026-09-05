import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SecretPromptInput } from "../src/main";
import { readSecretPrompt } from "../src/main";

class CapturedTerminal implements SecretPromptInput {
  isTTY = true;
  readonly rawModes: boolean[] = [];
  readonly listeners = new Set<(chunk: Uint8Array) => void>();

  setRawMode(enabled: boolean): void {
    this.rawModes.push(enabled);
  }

  resume(): void {}

  on(_event: "data", listener: (chunk: Uint8Array) => void): void {
    this.listeners.add(listener);
  }

  off(_event: "data", listener: (chunk: Uint8Array) => void): void {
    this.listeners.delete(listener);
  }

  send(text: string): void {
    const chunk = new TextEncoder().encode(text);
    for (const listener of this.listeners) listener(chunk);
  }
}

describe("secret terminal prompt", () => {
  test("captures only mask characters on the terminal stream", async () => {
    const terminal = new CapturedTerminal();
    const output: string[] = [];
    const pending = readSecretPrompt(terminal, { write: (text) => output.push(text) }, "App password: ");
    terminal.send("correct-horse\n");
    expect(await pending).toBe("correct-horse");
    const transcript = output.join("");
    expect(transcript).toContain("App password: *************\n");
    expect(transcript).not.toContain("correct-horse");
    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.listeners.size).toBe(0);
  });

  test("cancellation restores terminal mode without revealing typed bytes", async () => {
    const terminal = new CapturedTerminal();
    const output: string[] = [];
    const pending = readSecretPrompt(terminal, { write: (text) => output.push(text) }, "App password: ");
    terminal.send("nope\x03");
    await expect(pending).rejects.toThrow("interactive sign-in cancelled");
    expect(output.join("")).not.toContain("nope");
    expect(terminal.rawModes).toEqual([true, false]);
    expect(terminal.listeners.size).toBe(0);
  });

  test("backspace removes a complete Unicode character and arrows are ignored", async () => {
    const terminal = new CapturedTerminal();
    const output: string[] = [];
    const pending = readSecretPrompt(terminal, { write: (text) => output.push(text) }, "App password: ");
    terminal.send("a😀");
    terminal.send("\x7f\x1b[D");
    terminal.send("b\n");
    expect(await pending).toBe("ab");
    expect(output.join("")).not.toContain("[D");
  });

  test("accepts a Unicode character split across terminal chunks", async () => {
    const terminal = new CapturedTerminal();
    const output: string[] = [];
    const pending = readSecretPrompt(terminal, { write: (text) => output.push(text) }, "App password: ");
    const bytes = new TextEncoder().encode("😀");
    for (const byte of bytes) for (const listener of terminal.listeners) listener(Uint8Array.of(byte));
    terminal.send("\n");
    expect(await pending).toBe("😀");
  });

  test("refuses incomplete UTF-8 on submit or backspace", async () => {
    for (const control of ["\n", "\x7f"]) {
      const terminal = new CapturedTerminal();
      const pending = readSecretPrompt(terminal, { write() {} }, "App password: ");
      for (const listener of terminal.listeners) listener(Uint8Array.of(0xf0, 0x9f));
      terminal.send(control);
      await expect(pending).rejects.toThrow("invalid terminal input");
      expect(terminal.rawModes).toEqual([true, false]);
    }
  });

  test("a parent Ctrl-C byte cancels a visible prompt in a real pseudo-terminal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-prompt-"));
    const program = join(directory, "prompt.ts");
    writeFileSync(program, [
      `import { readVisiblePrompt } from ${JSON.stringify(resolve(import.meta.dir, "../src/main.ts"))};`,
      "try { await readVisiblePrompt('IMAP server host: '); }",
      "catch (error) { process.stdout.write(error instanceof Error ? error.message : String(error)); }",
    ].join("\n"));
    try {
      const child = Bun.spawn([
        "script", "-qfec", `${process.execPath} ${program}`, "/dev/null",
      ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const reader = child.stdout.getReader();
      let transcript = "";
      let sent = false;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        transcript += new TextDecoder().decode(next.value);
        if (!sent && transcript.includes("IMAP server host: ")) {
          child.stdin.write("\x03");
          child.stdin.end();
          sent = true;
        }
      }
      transcript += await new Response(child.stderr).text();
      expect(sent).toBe(true);
      expect(await child.exited).toBe(0);
      expect(transcript).toContain("interactive sign-in cancelled");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
