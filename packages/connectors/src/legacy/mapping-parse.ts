import { isPlainObject } from "@kizuki/core";
import { KizukiError } from "../errors";

/**
 * The refusals both mapping parsers make, bound once to a connector id. A
 * mapping file is the owner's only lever over what a migration decides, so a
 * refusal names the JSON path and the rule it broke, and an unknown key is a
 * refusal too: a typo must not quietly change the outcome.
 */
export interface MappingRules {
  fail: (path: string, rule: string) => never;
  objectAt: (
    raw: unknown,
    path: string,
    allowed: readonly string[],
  ) => Record<string, unknown>;
  enumValue: <T extends string>(
    raw: unknown,
    path: string,
    values: readonly T[],
  ) => T;
}

export function mappingRules(connectorId: string): MappingRules {
  // The annotation is what lets TypeScript treat a call as unreachable-after,
  // so a refusal narrows the value the caller was checking.
  const fail: MappingRules["fail"] = (path, rule) => {
    throw new KizukiError("misconfigured", `${connectorId}: ${path}: ${rule}`);
  };

  return {
    fail,
    objectAt(raw, path, allowed) {
      if (!isPlainObject(raw)) fail(path, "must be an object");
      for (const key of Object.keys(raw)) {
        if (!allowed.includes(key)) fail(path, `unknown key ${key}`);
      }
      return raw;
    },
    enumValue<T extends string>(
      raw: unknown,
      path: string,
      values: readonly T[],
    ): T {
      if (
        typeof raw !== "string" ||
        !(values as readonly string[]).includes(raw)
      ) {
        fail(path, `must be one of ${values.join(" | ")}`);
      }
      return raw as T;
    },
  };
}
