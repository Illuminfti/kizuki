export class UsageError extends Error {
  override name = "UsageError";
}

export interface ArgSpec {
  options?: readonly string[];
  flags?: readonly string[];
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
    const separator = token.indexOf("=");
    const name = separator < 0 ? token : token.slice(0, separator);
    const inlineValue = separator < 0 ? undefined : token.slice(separator + 1);
    if (flagNames.has(name)) {
      if (inlineValue !== undefined) throw new UsageError(`flag ${name} does not take a value`);
      if (flags.has(name)) throw new UsageError(`repeated flag ${name}`);
      flags.add(name);
      continue;
    }
    if (optionNames.has(name)) {
      if (options.has(name)) throw new UsageError(`repeated option ${name}`);
      const value = inlineValue ?? tokens[index + 1];
      if (value === undefined || (inlineValue === undefined && value.startsWith("--"))) {
        throw new UsageError(`missing value for ${name}`);
      }
      options.set(name, value);
      if (inlineValue === undefined) index += 1;
      continue;
    }
    throw new UsageError(`unknown option ${name}`);
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
    if (token === "--vault" || token.startsWith("--vault=")) {
      if (vault !== null) throw new UsageError("repeated option --vault");
      const inlineValue = token === "--vault" ? undefined : token.slice("--vault=".length);
      const value = inlineValue ?? tokens[index + 1];
      if (value === undefined || value.length === 0 || (inlineValue === undefined && value.startsWith("--"))) {
        throw new UsageError("missing value for --vault");
      }
      vault = value;
      if (inlineValue === undefined) index += 1;
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
