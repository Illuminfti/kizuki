const MAPS = ["properties", "patternProperties", "definitions", "$defs"];
const SINGLE = ["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else"];
const ARRAYS = ["anyOf", "oneOf", "allOf"];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remove redundant generated JSON Schema spelling without changing its constraints. */
export function compactToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const draft = schema["$schema"];
  function compact(value: unknown, root = false): unknown {
    if (!object(value)) return value;
    const node = { ...value };
    // Walk schema vocabulary only: defaults and examples are data, not schemas.
    for (const key of MAPS) {
      const entries = node[key];
      if (object(entries)) node[key] = Object.fromEntries(Object.entries(entries).map(([name, child]) => [name, compact(child)]));
    }
    for (const key of SINGLE) {
      if (Object.hasOwn(node, key)) node[key] = Array.isArray(node[key]) ? node[key].map((child) => compact(child)) : compact(node[key]);
    }
    for (const key of ARRAYS) {
      if (Array.isArray(node[key])) node[key] = node[key].map((child) => compact(child));
    }
    if (!root && node["$schema"] === draft) delete node["$schema"];
    const choices = Object.hasOwn(node, "const") ? [node["const"]] : node["enum"];
    if (typeof node["type"] === "string" && Array.isArray(choices) && choices.length > 0 && choices.every((item) => typeof item === node["type"])) delete node["type"];
    for (const key of ["items", "additionalProperties"]) {
      if (object(node[key]) && Object.keys(node[key]).length === 0) delete node[key];
    }
    const names = node["propertyNames"];
    if (object(names) && Object.keys(names).length === 1 && names["type"] === "string") delete node["propertyNames"];
    if (Array.isArray(node["required"]) && node["required"].length === 0) delete node["required"];
    return node;
  }
  return compact(schema, true) as Record<string, unknown>;
}
