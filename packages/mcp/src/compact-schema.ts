const MAPS = ["properties", "patternProperties", "definitions", "$defs"];
const SINGLE = ["items", "additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else"];
const ARRAYS = ["anyOf", "oneOf", "allOf"];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Remove redundant generated JSON Schema spelling without changing its constraints. */
export function compactToolSchema(schema: Record<string, unknown>, options: { omitDefaults?: boolean } = {}): Record<string, unknown> {
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
    // Tool-level prose carries the explanation. Repeating generated field
    // titles and descriptions in every listing spends the bounded MCP
    // discovery budget without affecting validation or defaults.
    delete node["title"];
    delete node["description"];
    if (options.omitDefaults) delete node["default"];
    // Output schema identifiers share a long namespace. A factored, anchored
    // pattern names exactly the same finite set without repeating that prefix.
    // Input enums remain enumerated for tool discovery.
    if (options.omitDefaults && (node.type === undefined || node.type === "string") && node.pattern === undefined && Array.isArray(node.enum) && node.enum.length >= 8 && node.enum.every(value => typeof value === "string" && /^[A-Za-z0-9_.\/-]+$/.test(value))) {
      const values = node.enum as string[];
      let prefix = values[0]!;
      for (const value of values) while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
      if (prefix.length >= 5) {
        const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const candidate = { ...node, type: "string", pattern: `^${escaped(prefix)}(?:${values.map(value => escaped(value.slice(prefix.length))).join("|")})(?![\\s\\S])` };
        delete (candidate as Record<string, unknown>).enum;
        if (JSON.stringify(candidate).length < JSON.stringify(node).length) { Object.assign(node, candidate); delete node.enum; }
      }
    }
    const choices = Object.hasOwn(node, "const") ? [node["const"]] : node["enum"];
    const type = node["type"];
    if ((type === "string" || type === "number" || type === "boolean") && Array.isArray(choices) && choices.length > 0 && choices.every((item) => typeof item === type)) delete node["type"];
    for (const key of ["items", "additionalProperties"]) {
      if (node[key] === true || object(node[key]) && Object.keys(node[key]).length === 0) delete node[key];
    }
    const names = node["propertyNames"];
    if (object(names) && Object.keys(names).length === 1 && names["type"] === "string") delete node["propertyNames"];
    if (Array.isArray(node["required"]) && node["required"].length === 0) delete node["required"];
    return node;
  }
  return shareRepeatedSchemas(compact(schema, true) as Record<string, unknown>);
}

/** Factor identical schema subtrees, never captured defaults/examples. Local
 * references retain the same document scope; definitions themselves stay put. */
function shareRepeatedSchemas(schema: Record<string, unknown>): Record<string, unknown> {
  const counts = new Map<string, { count: number; value: Record<string, unknown> }>();
  function visit(node: unknown, transform: (value: Record<string, unknown>, root: boolean) => unknown, root = false): unknown {
    if (!object(node)) return node;
    const value = { ...node };
    for (const key of MAPS) {
      if (object(value[key])) value[key] = Object.fromEntries(Object.entries(value[key]).map(([name, child]) => [name, visit(child, transform)]));
    }
    for (const key of SINGLE) if (Object.hasOwn(value, key)) value[key] = Array.isArray(value[key]) ? value[key].map(child => visit(child, transform)) : visit(value[key], transform);
    for (const key of ARRAYS) if (Array.isArray(value[key])) value[key] = value[key].map(child => visit(child, transform));
    return transform(value, root);
  }
  // Moving a subtree containing a definition or a new reference scope could
  // invalidate an existing pointer. Those containers are never candidates.
  const eligible = (value: Record<string, unknown>) => !/"(?:\$[^"\n]*|definitions)":/.test(JSON.stringify(value));
  visit(schema, (value, root) => {
    const key = JSON.stringify(value);
    if (!root && key.length >= 70 && eligible(value)) counts.set(key, { count: (counts.get(key)?.count ?? 0) + 1, value });
    return value;
  }, true);
  const chosen = [...counts].filter(([key, row]) => row.count > 1 && (key.length - 29) * row.count > key.length + 12);
  const existing = object(schema.definitions) ? schema.definitions : {};
  const definitions: Record<string, unknown> = { ...existing };
  const names = new Map<string, string>();
  for (const [key] of chosen) {
    let name = `S${names.size}`;
    while (Object.hasOwn(definitions, name)) name += "_";
    names.set(key, name); definitions[name] = {};
  }
  // Match parent bytes before rewriting children, then recurse only when no
  // shared definition owns that parent. This avoids unused duplicate bodies.
  function rewrite(node: unknown, root = false, skip?: string): unknown {
    if (!object(node)) return node;
    const key = JSON.stringify(node), name = names.get(key);
    if (!root && name !== undefined && key !== skip) return { $ref: `#/definitions/${name}` };
    const value = { ...node };
    for (const map of MAPS) if (object(value[map])) value[map] = Object.fromEntries(Object.entries(value[map]).map(([field, child]) => [field, rewrite(child)]));
    for (const single of SINGLE) if (Object.hasOwn(value, single)) value[single] = Array.isArray(value[single]) ? value[single].map(child => rewrite(child)) : rewrite(value[single]);
    for (const array of ARRAYS) if (Array.isArray(value[array])) value[array] = value[array].map(child => rewrite(child));
    return value;
  }
  for (const [key, row] of chosen) definitions[names.get(key)!] = rewrite(row.value, false, key);
  const result = rewrite(schema, true) as Record<string, unknown>;
  if (chosen.length > 0) result.definitions = { ...(object(result.definitions) ? result.definitions : {}), ...Object.fromEntries([...names.values()].map(name => [name, definitions[name]])) };
  // Factoring a parent can leave a child used only once. Inline those generated
  // definitions again; their indirection would increase the discovery payload.
  if (object(result.definitions)) for (const name of [...names.values()].reverse()) {
    const pointer = `#/definitions/${name}`;
    let uses = 0;
    visit(result, value => { if (value.$ref === pointer) uses++; return value; }, true);
    if (uses > 1) continue;
    const replacement = result.definitions[name];
    delete result.definitions[name];
    if (uses === 1) {
      const expanded = visit(result, value => value.$ref === pointer && Object.keys(value).length === 1 ? replacement : value, true) as Record<string, unknown>;
      Object.assign(result, expanded);
    }
  }
  if (object(result.definitions) && Object.keys(result.definitions).length === 0) delete result.definitions;
  return JSON.stringify(result).length < JSON.stringify(schema).length ? result : schema;
}
