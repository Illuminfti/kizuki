#!/usr/bin/env bun
import { UsageError, extractVault } from "./args";
import { COMMANDS } from "./commands/index";
import type { CliIo } from "./commands/index";
import { printCommandHelp, printRootHelp, usageLines } from "./help";
import { errorText } from "./output";
import {
  isRetiredOwnerGateVerb,
  retiredOwnerGateMessage,
} from "./retired";

function processEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    env[key] = value;
  }
  return env;
}

async function dispatch(argv: string[]): Promise<number> {
  const io: CliIo = {
    env: processEnv(),
    vaultOverride: null,
    stdinIsTTY: process.stdin.isTTY === true,
    stdoutIsTTY: process.stdout.isTTY === true,
    out(line) {
      process.stdout.write(`${line}\n`);
    },
    err(line) {
      process.stderr.write(`${line}\n`);
    },
  };

  const extracted = extractVault(argv);
  io.vaultOverride = extracted.vault;
  const verb = extracted.rest[0];
  const args = extracted.rest.slice(1);

  if (verb === undefined) {
    printRootHelp(io.err, COMMANDS);
    return 2;
  }
  if (verb === "help" || verb === "--help") {
    const name = args[0];
    if (name === undefined) {
      printRootHelp(io.out, COMMANDS);
      return 0;
    }
    if (isRetiredOwnerGateVerb(name)) {
      io.err(retiredOwnerGateMessage(name));
      return 2;
    }
    const command = COMMANDS.find((entry) => entry.name === name);
    if (command === undefined) {
      io.err(`unknown verb: ${name}`);
      printRootHelp(io.err, COMMANDS);
      return 2;
    }
    printCommandHelp(io.out, command);
    return 0;
  }

  if (isRetiredOwnerGateVerb(verb)) {
    io.err(retiredOwnerGateMessage(verb));
    return 2;
  }

  const command = COMMANDS.find((entry) => entry.name === verb);
  if (command === undefined) {
    io.err(`unknown verb: ${verb}`);
    printRootHelp(io.err, COMMANDS);
    return 2;
  }

  try {
    return await command.run(io, args);
  } catch (error) {
    if (error instanceof UsageError) {
      for (const line of usageLines(command, error)) io.err(line);
      return 2;
    }
    io.err(`error: ${errorText(error)}`);
    return 1;
  }
}

try {
  process.exitCode = await dispatch(Bun.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write("usage: kizuki <verb> [options]\n");
    process.exitCode = 2;
  } else {
    process.stderr.write(`error: ${errorText(error)}\n`);
    process.exitCode = 1;
  }
}
