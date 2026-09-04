export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; errors: string[] };

export type ExactJson =
  | null
  | boolean
  | number
  | string
  | ExactJson[]
  | { [key: string]: ExactJson };

export interface ExactJsonLimits {
  maxDepth: number;
  maxKeysPerObject: number;
  maxArrayLength: number;
  maxStringBytes: number;
  maxKeyBytes: number;
  maxTotalBytes: number;
}

type JsonBudget = { used: number; overflowed: boolean };

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Plain data object only: rejects arrays, null, and class instances, so a
 * validated `metadata` bag round-trips through JSON unchanged.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * Snapshot attacker-controlled data into frozen exact JSON: no cycles,
 * accessors, non-finite numbers, or prototype-polluting keys. The clone is
 * what later hashing and persistence must observe.
 */
export function cloneExactJson(
  value: unknown,
  path: string,
  limits: ExactJsonLimits,
  errors: string[],
): ExactJson | undefined {
  const before = errors.length;
  const budget = { used: 0, overflowed: false };
  const cloned = walkExactJson(
    value,
    path,
    1,
    limits,
    errors,
    budget,
    new WeakSet<object>(),
  );
  return errors.length > before ? undefined : cloned;
}

function walkExactJson(
  value: unknown,
  path: string,
  depth: number,
  limits: ExactJsonLimits,
  errors: string[],
  budget: JsonBudget,
  stack: WeakSet<object>,
): ExactJson | undefined {
  if (value === null) {
    charge(budget, 4, path, limits, errors);
    return null;
  }

  switch (typeof value) {
    case "boolean":
      charge(budget, value ? 4 : 5, path, limits, errors);
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        errors.push(`${path}: must be a finite JSON number`);
        return undefined;
      }
      charge(budget, utf8ByteLength(JSON.stringify(value)), path, limits, errors);
      return value;
    case "string": {
      const bytes = utf8ByteLength(value);
      if (bytes > limits.maxStringBytes) {
        errors.push(`${path}: exceeds ${limits.maxStringBytes} UTF-8 bytes`);
        return undefined;
      }
      charge(budget, utf8ByteLength(JSON.stringify(value)), path, limits, errors);
      return value;
    }
    case "object":
      break;
    default:
      errors.push(`${path}: must be exact JSON`);
      return undefined;
  }

  if (depth > limits.maxDepth) {
    errors.push(`${path}: exceeds max nesting depth ${limits.maxDepth}`);
    return undefined;
  }
  if (stack.has(value)) {
    errors.push(`${path}: cycle`);
    return undefined;
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    errors.push(`${path}: symbol keys are not JSON`);
    return undefined;
  }

  if (Array.isArray(value)) {
    return cloneArray(value, path, depth, limits, errors, budget, stack);
  }
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be a plain object`);
    return undefined;
  }
  return cloneObject(value, path, depth, limits, errors, budget, stack);
}

function cloneArray(
  value: unknown[],
  path: string,
  depth: number,
  limits: ExactJsonLimits,
  errors: string[],
  budget: JsonBudget,
  stack: WeakSet<object>,
): ExactJson[] | undefined {
  if (value.length > limits.maxArrayLength) {
    errors.push(`${path}: exceeds max array length ${limits.maxArrayLength}`);
    return undefined;
  }
  const named = Object.keys(value).filter((key) => {
    const index = Number(key);
    return !Number.isInteger(index) || index < 0 || String(index) !== key;
  });
  if (named.length > 0) {
    errors.push(`${path}: extra enumerable properties are not JSON`);
    return undefined;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) {
      errors.push(`${path}[${index}]: sparse arrays are not JSON`);
      return undefined;
    }
  }

  stack.add(value);
  charge(budget, 2, path, limits, errors);
  const items: ExactJson[] = [];
  let failed = false;
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) charge(budget, 1, path, limits, errors);
    const item = walkExactJson(
      value[index],
      `${path}[${index}]`,
      depth + 1,
      limits,
      errors,
      budget,
      stack,
    );
    if (item === undefined) failed = true;
    else items.push(item);
  }
  stack.delete(value);
  return failed ? undefined : Object.freeze(items) as ExactJson[];
}

function cloneObject(
  value: Record<string, unknown>,
  path: string,
  depth: number,
  limits: ExactJsonLimits,
  errors: string[],
  budget: JsonBudget,
  stack: WeakSet<object>,
): { [key: string]: ExactJson } | undefined {
  const keys = Object.keys(value);
  if (keys.length > limits.maxKeysPerObject) {
    errors.push(`${path}: exceeds max key count ${limits.maxKeysPerObject}`);
    return undefined;
  }
  if (Object.getOwnPropertyNames(value).length !== keys.length) {
    errors.push(`${path}: hidden properties are not JSON`);
    return undefined;
  }

  stack.add(value);
  charge(budget, 2, path, limits, errors);
  const out = Object.create(null) as { [key: string]: ExactJson };
  let failed = false;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    if (FORBIDDEN_KEYS.has(key)) {
      errors.push(`${path}: key ${quoteToken(key)} is not allowed`);
      failed = true;
      continue;
    }
    if (utf8ByteLength(key) > limits.maxKeyBytes) {
      errors.push(`${path}: key exceeds ${limits.maxKeyBytes} UTF-8 bytes`);
      failed = true;
      continue;
    }
    if (index > 0) charge(budget, 1, path, limits, errors);
    charge(budget, utf8ByteLength(JSON.stringify(key)) + 1, path, limits, errors);
    const cloned = walkExactJson(
      value[key],
      `${path}.${clipPathKey(key)}`,
      depth + 1,
      limits,
      errors,
      budget,
      stack,
    );
    if (cloned === undefined) {
      failed = true;
      continue;
    }
    Object.defineProperty(out, key, {
      value: cloned,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  stack.delete(value);
  return failed ? undefined : Object.freeze(out);
}

function charge(
  budget: JsonBudget,
  bytes: number,
  path: string,
  limits: ExactJsonLimits,
  errors: string[],
): void {
  budget.used += bytes;
  if (!budget.overflowed && budget.used > limits.maxTotalBytes) {
    budget.overflowed = true;
    errors.push(`${path}: exceeds ${limits.maxTotalBytes} UTF-8 bytes`);
  }
}

function clipPathKey(key: string): string {
  return key.length > 32 ? `${key.slice(0, 32)}...` : key;
}

function quoteToken(value: string): string {
  const clipped = value.length > 64 ? `${value.slice(0, 64)}...` : value;
  return JSON.stringify(clipped);
}
