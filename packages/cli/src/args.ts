export class UsageError extends Error {
  override name = "UsageError";
}

export interface ArgSpec {
  options?: string[];
  flags?: string[];
}

export interface ParsedArguments {
  options: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

export function parseArguments(
  tokens: string[],
  spec: ArgSpec,
): ParsedArguments {
  const optionNames = new Set(spec.options ?? []);
  const flagNames = new Set(spec.flags ?? []);
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  let ended = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (ended) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      ended = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    if (flagNames.has(token)) {
      if (flags.has(token)) throw new UsageError(`repeated flag ${token}`);
      flags.add(token);
      continue;
    }
    if (optionNames.has(token)) {
      if (options.has(token)) throw new UsageError(`repeated option ${token}`);
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`missing value for ${token}`);
      }
      options.set(token, value);
      index += 1;
      continue;
    }
    throw new UsageError(`unknown option ${token}`);
  }

  return { options, flags, positionals };
}

export function extractVault(tokens: string[]): {
  vault: string | null;
  rest: string[];
} {
  const rest: string[] = [];
  let vault: string | null = null;
  let ended = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (ended) {
      rest.push(token);
      continue;
    }
    if (token === "--") {
      ended = true;
      rest.push(token);
      continue;
    }
    if (token === "--vault") {
      const value = tokens[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("missing value for --vault");
      }
      if (vault !== null) throw new UsageError("repeated option --vault");
      vault = value;
      index += 1;
      continue;
    }
    rest.push(token);
  }

  return { vault, rest };
}

export function requirePositional(
  positionals: string[],
  count: number,
): string[] {
  if (positionals.length !== count) throw new UsageError("wrong arity");
  return positionals;
}
