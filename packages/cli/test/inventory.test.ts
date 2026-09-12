import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { listConnectorDescriptors } from "@kizuki/connectors";

const ROOT = join(import.meta.dir, "../../..");
const PACKAGES = join(ROOT, "packages");

interface PackageJson {
  name?: unknown;
  exports?: unknown;
  bin?: unknown;
  module?: unknown;
}

function readJson(path: string): PackageJson {
  return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
}

function workspacePackages(): { dir: string; name: string; manifest: PackageJson }[] {
  const rows: { dir: string; name: string; manifest: PackageJson }[] = [];
  for (const entry of readdirSync(PACKAGES).sort()) {
    const dir = join(PACKAGES, entry);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = readJson(manifestPath);
    expect(typeof manifest.name).toBe("string");
    rows.push({ dir, name: manifest.name as string, manifest });
  }
  return rows;
}

function exportTargets(exports: unknown): string[] {
  if (typeof exports === "string") return [exports];
  if (exports === undefined || exports === null || Array.isArray(exports)) return [];
  if (typeof exports !== "object") return [];
  const paths: string[] = [];
  for (const value of Object.values(exports as Record<string, unknown>)) {
    if (typeof value === "string") paths.push(value);
    else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        if (typeof nested === "string") paths.push(nested);
      }
    }
  }
  return paths;
}

test("every workspace package.json name and export path exists", () => {
  const packages = workspacePackages();
  expect(packages.length).toBeGreaterThan(0);
  const names = packages.map((item) => item.name);
  expect(new Set(names).size).toBe(names.length);

  for (const item of packages) {
    expect(item.name.startsWith("@kizuki/")).toBe(true);
    for (const target of exportTargets(item.manifest.exports)) {
      expect(existsSync(join(item.dir, target))).toBe(true);
    }
    if (typeof item.manifest.module === "string") {
      expect(existsSync(join(item.dir, item.manifest.module))).toBe(true);
    }
    if (item.manifest.bin !== undefined && typeof item.manifest.bin === "object" && item.manifest.bin !== null) {
      for (const target of Object.values(item.manifest.bin as Record<string, unknown>)) {
        if (typeof target === "string") expect(existsSync(join(item.dir, target))).toBe(true);
      }
    }
  }
});

test("connector registry optional_package names resolve to workspace exports", () => {
  const packages = new Map(workspacePackages().map((item) => [item.name, item]));
  const descriptors = listConnectorDescriptors();
  expect(descriptors.length).toBeGreaterThan(0);

  for (const port of descriptors) {
    const spec = port.optional_package;
    expect(typeof spec).toBe("string");
    if (typeof spec !== "string" || spec.length === 0) continue;
    const match = packages.get(spec);
    if (match !== undefined) {
      expect(exportTargets(match.manifest.exports).length + (typeof match.manifest.module === "string" ? 1 : 0)).toBeGreaterThan(0);
      continue;
    }
    const slash = spec.indexOf("/", spec.startsWith("@") ? spec.indexOf("/") + 1 : 0);
    expect(slash).toBeGreaterThan(0);
    const name = spec.slice(0, slash);
    const subpath = `.${spec.slice(slash)}`;
    const pkg = packages.get(name);
    expect(pkg).toBeDefined();
    if (pkg === undefined) continue;
    const exports = pkg.manifest.exports;
    expect(exports !== null && typeof exports === "object" && !Array.isArray(exports)).toBe(true);
    expect((exports as Record<string, unknown>)[subpath]).toBeDefined();
  }
});

function connectorInventoryErrors(markdown: string): string[] {
  const section = markdown.split(/^## CLI-enrollable sources\r?$/m)[1]?.split(/^## /m)[0] ?? "";
  const documented = [...section.matchAll(/^\|[ \t]*`([^`]+)`[ \t]*\|/gm)].map((match) => match[1]!);
  const registered = new Set(listConnectorDescriptors().map(({ id }) => id.replace(/^kizuki\.connector\./, "kizuki.")));
  const errors: string[] = [];
  for (const id of documented) {
    if (!registered.has(id)) errors.push(`unregistered documented connector ${id}`);
  }
  for (const id of registered) {
    if (!documented.includes(id)) errors.push(`undocumented registered connector ${id}`);
  }
  if (new Set(documented).size !== documented.length) errors.push("duplicate documented connector IDs");
  return errors.sort();
}

test("README and connect inventory match the live workspace and registry", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const connect = readFileSync(join(ROOT, "docs/connect.md"), "utf8");
  expect(readme.toLowerCase()).not.toContain("four packages");
  expect(readme.toLowerCase()).not.toContain("three registered connectors");
  expect(readme).toContain("Screenpipe");
  expect(connect).toContain("## Screenpipe");
  expect(workspacePackages().length).toBeGreaterThan(4);
  expect(connectorInventoryErrors(connect)).toEqual([]);
});

test("a stale connector inventory row is rejected while every live row remains", () => {
  const connect = readFileSync(join(ROOT, "docs/connect.md"), "utf8");
  const stale = connect.replace("| `kizuki.markdown-folder`", "| `kizuki.retired-source` | retired | unsupported |\n| `kizuki.markdown-folder`");
  expect(connectorInventoryErrors(stale)).toEqual(["unregistered documented connector kizuki.retired-source"]);
});

test("a connector mentioned outside the inventory cannot replace a missing live row", () => {
  const connect = readFileSync(join(ROOT, "docs/connect.md"), "utf8");
  const missing = connect.replace(/^\| `kizuki\.beeper` \|.*\n/m, "");
  expect(connectorInventoryErrors(`${missing}\nHistorical mention: \`kizuki.beeper\`.\n`)).toEqual([
    "undocumented registered connector kizuki.beeper",
  ]);
});

const STATUSES = new Set(["shipped", "designed", "direction"]);

interface CapabilityStatusEntry {
  id: string;
  status: string;
  doc: string;
  heading: string;
  implementation?: string;
  test?: string;
}

test("documentation status inventory maps shipped claims to live files", () => {
  const inventoryPath = join(ROOT, "docs/capability-status.json");
  const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
    schema?: unknown;
    entries?: unknown;
  };
  expect(inventory.schema).toBe("kizuki.capability-status/v1");
  expect(Array.isArray(inventory.entries)).toBe(true);
  const entries = inventory.entries as CapabilityStatusEntry[];
  expect(entries.length).toBeGreaterThan(0);
  const ids = entries.map((entry) => entry.id);
  expect(new Set(ids).size).toBe(ids.length);

  for (const entry of entries) {
    expect(typeof entry.id).toBe("string");
    expect(entry.id.length).toBeGreaterThan(0);
    expect(STATUSES.has(entry.status)).toBe(true);
    const docPath = join(ROOT, entry.doc);
    expect(existsSync(docPath)).toBe(true);
    const doc = readFileSync(docPath, "utf8");
    expect(doc.includes(`## ${entry.heading}`)).toBe(true);
    if (entry.status === "shipped") {
      expect(typeof entry.implementation).toBe("string");
      expect(typeof entry.test).toBe("string");
      expect(existsSync(join(ROOT, entry.implementation!))).toBe(true);
      expect(existsSync(join(ROOT, entry.test!))).toBe(true);
    }
  }
});

const TAGGED_SECTIONS = [
  {
    id: "architecture.storage",
    status: "designed",
    doc: "docs/architecture.md",
    heading: "Storage",
  },
  {
    id: "architecture.invariants",
    status: "designed",
    doc: "docs/architecture.md",
    heading: "Invariants (CI-enforced where possible)",
  },
  {
    id: "architecture.security",
    status: "designed",
    doc: "docs/architecture.md",
    heading: "Security",
  },
  {
    id: "architecture.serving",
    status: "designed",
    doc: "docs/architecture.md",
    heading: "Serving — agents as first-class citizens",
  },
  {
    id: "product.proactive-intelligence",
    status: "direction",
    doc: "docs/product-context.md",
    heading: "Proactive intelligence",
  },
  {
    id: "product.progressive-ingestion",
    status: "direction",
    doc: "docs/product-context.md",
    heading: "Progressive ingestion",
  },
  {
    id: "product.autonomy-modes",
    status: "direction",
    doc: "docs/product-context.md",
    heading: "Autonomy modes",
  },
  {
    id: "architecture.layers",
    status: "designed",
    doc: "docs/architecture.md",
    heading: "Layers",
  },
  {
    id: "architecture.contracts",
    status: "designed",
    doc: "docs/architecture.md",
    heading: "Contracts",
  },
  {
    id: "product.identity",
    status: "direction",
    doc: "docs/product-context.md",
    heading: "Product identity",
  },
  {
    id: "product.taste",
    status: "direction",
    doc: "docs/product-context.md",
    heading: "Taste as source-linked working knowledge",
  },
  {
    id: "product.agent-harness",
    status: "direction",
    doc: "docs/product-context.md",
    heading: "Agent and harness experience",
  },
  {
    id: "product.deployment-direction",
    status: "direction",
    doc: "docs/product-context.md",
    heading: "Deployment direction",
  },
  {
    id: "product.explicit-non-decisions",
    status: "direction",
    doc: "docs/product-context.md",
    heading: "Explicit non-decisions",
  },
  {
    id: "product.settled-decisions",
    status: "designed",
    doc: "docs/product-context.md",
    heading: "Settled design decisions",
  },
  {
    id: "stranger-proof.sqlite-engine",
    status: "shipped",
    doc: "docs/stranger-proof.md",
    heading: "Effective SQLite engine evidence",
  },
  {
    id: "world-model",
    status: "direction",
    doc: "README.md",
    heading: "The vision",
  },
] as const;

function sectionStatus(doc: string, heading: string): string | null {
  const marker = `## ${heading}`;
  const start = doc.indexOf(`\n${marker}\n`);
  const at = start >= 0 ? start + 1 : doc.startsWith(`${marker}\n`) ? 0 : -1;
  if (at < 0) return null;
  const rest = doc.slice(at + marker.length);
  const next = rest.search(/\n## /);
  const section = next < 0 ? rest : rest.slice(0, next);
  const match = section.match(/^Status: (shipped|designed|direction)\s*$/m);
  return match?.[1] ?? null;
}

function taggedSectionErrors(
  entries: CapabilityStatusEntry[],
  files: Map<string, string>,
  required: readonly { id: string; status: string; doc: string; heading: string }[],
): string[] {
  const errors: string[] = [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  for (const want of required) {
    const entry = byId.get(want.id);
    if (entry === undefined) {
      errors.push(`missing inventory entry ${want.id}`);
      continue;
    }
    if (entry.status !== want.status || entry.doc !== want.doc || entry.heading !== want.heading) {
      errors.push(`inventory ${want.id} does not match the tagged section`);
    }
    const doc = files.get(want.doc);
    if (doc === undefined) {
      errors.push(`missing document ${want.doc}`);
      continue;
    }
    const label = sectionStatus(doc, want.heading);
    if (label === null) errors.push(`missing status tag for ${want.id}`);
    else if (label !== entry.status) errors.push(`status tag for ${want.id} is ${label}, inventory is ${entry.status}`);
    if (want.status === "shipped") {
      if (typeof entry.implementation !== "string" || typeof entry.test !== "string") {
        errors.push(`missing shipped paths for ${want.id}`);
      }
    }
  }
  return errors;
}

test("tagged architecture and product sections agree with the inventory", () => {
  const inventory = JSON.parse(readFileSync(join(ROOT, "docs/capability-status.json"), "utf8")) as {
    entries: CapabilityStatusEntry[];
  };
  const files = new Map(
    TAGGED_SECTIONS.map((section) => [section.doc, readFileSync(join(ROOT, section.doc), "utf8")]),
  );
  expect(taggedSectionErrors(inventory.entries, files, TAGGED_SECTIONS)).toEqual([]);
});

test.each([
  {
    name: "missing tag",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/architecture.md", docs.get("docs/architecture.md")!.replace("Status: designed\n\n", ""));
      return entries;
    },
  },
  {
    name: "mismatched status",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/architecture.md", docs.get("docs/architecture.md")!.replace("Status: designed", "Status: shipped"));
      return entries;
    },
  },
  {
    name: "missing inventory entry",
    mutate: (_docs: Map<string, string>, entries: CapabilityStatusEntry[]) =>
      entries.filter((entry) => entry.id !== "architecture.contracts"),
  },
  {
    name: "missing shipped paths",
    mutate: (_docs: Map<string, string>, entries: CapabilityStatusEntry[]) =>
      entries.map((entry) =>
        entry.id === "stranger-proof.sqlite-engine"
          ? { id: entry.id, status: entry.status, doc: entry.doc, heading: entry.heading }
          : entry,
      ),
  },
  {
    name: "world-model tag removed",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("README.md", docs.get("README.md")!.replace("Status: direction\n\n", ""));
      return entries;
    },
  },
  {
    name: "world-model tag shipped",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("README.md", docs.get("README.md")!.replace("Status: direction", "Status: shipped"));
      return entries;
    },
  },
  {
    name: "world-model inventory entry removed",
    mutate: (_docs: Map<string, string>, entries: CapabilityStatusEntry[]) =>
      entries.filter((entry) => entry.id !== "world-model"),
  },
  {
    name: "world-model tag in adjacent Status section",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      const readme = docs.get("README.md")!.replace("## The vision\n\nStatus: direction\n\n", "## The vision\n\n");
      docs.set("README.md", readme.replace("## Status\n\n", "## Status\n\nStatus: direction\n\n"));
      return entries;
    },
  },
  {
    name: "architecture.layers tag removed",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/architecture.md", docs.get("docs/architecture.md")!.replace("## Layers\n\nStatus: designed\n\n", "## Layers\n\n"));
      return entries;
    },
  },
  {
    name: "architecture.layers tag shipped",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/architecture.md", docs.get("docs/architecture.md")!.replace("## Layers\n\nStatus: designed", "## Layers\n\nStatus: shipped"));
      return entries;
    },
  },
  {
    name: "architecture.layers inventory entry removed",
    mutate: (_docs: Map<string, string>, entries: CapabilityStatusEntry[]) =>
      entries.filter((entry) => entry.id !== "architecture.layers"),
  },
  {
    name: "architecture.layers tag only in adjacent Contracts",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/architecture.md", docs.get("docs/architecture.md")!.replace("## Layers\n\nStatus: designed\n\n", "## Layers\n\n"));
      return entries;
    },
  },
  {
    name: "product.taste tag removed",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Taste as source-linked working knowledge\n\nStatus: direction\n\n", "## Taste as source-linked working knowledge\n\n"));
      return entries;
    },
  },
  {
    name: "product.taste tag shipped",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Taste as source-linked working knowledge\n\nStatus: direction", "## Taste as source-linked working knowledge\n\nStatus: shipped"));
      return entries;
    },
  },
  {
    name: "product.taste inventory entry removed",
    mutate: (_docs: Map<string, string>, entries: CapabilityStatusEntry[]) =>
      entries.filter((entry) => entry.id !== "product.taste"),
  },
  {
    name: "product.taste tag only in adjacent Progressive ingestion",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Taste as source-linked working knowledge\n\nStatus: direction\n\n", "## Taste as source-linked working knowledge\n\n"));
      return entries;
    },
  },
  {
    name: "product.agent-harness tag removed",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Agent and harness experience\n\nStatus: direction\n\n", "## Agent and harness experience\n\n"));
      return entries;
    },
  },
  {
    name: "product.agent-harness tag shipped",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Agent and harness experience\n\nStatus: direction", "## Agent and harness experience\n\nStatus: shipped"));
      return entries;
    },
  },
  {
    name: "product.agent-harness inventory entry removed",
    mutate: (_docs: Map<string, string>, entries: CapabilityStatusEntry[]) =>
      entries.filter((entry) => entry.id !== "product.agent-harness"),
  },
  {
    name: "product.agent-harness tag only in adjacent Taste",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Agent and harness experience\n\nStatus: direction\n\n", "## Agent and harness experience\n\n"));
      return entries;
    },
  },
  {
    name: "product.deployment-direction tag removed",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Deployment direction\n\nStatus: direction\n\n", "## Deployment direction\n\n"));
      return entries;
    },
  },
  {
    name: "product.deployment-direction tag shipped",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Deployment direction\n\nStatus: direction", "## Deployment direction\n\nStatus: shipped"));
      return entries;
    },
  },
  {
    name: "product.deployment-direction inventory entry removed",
    mutate: (_docs: Map<string, string>, entries: CapabilityStatusEntry[]) =>
      entries.filter((entry) => entry.id !== "product.deployment-direction"),
  },
  {
    name: "product.deployment-direction tag only in adjacent Explicit non-decisions",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Deployment direction\n\nStatus: direction\n\n", "## Deployment direction\n\n"));
      return entries;
    },
  },
  {
    name: "product.explicit-non-decisions tag removed",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Explicit non-decisions\n\nStatus: direction\n\n", "## Explicit non-decisions\n\n"));
      return entries;
    },
  },
  {
    name: "product.explicit-non-decisions tag shipped",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Explicit non-decisions\n\nStatus: direction", "## Explicit non-decisions\n\nStatus: shipped"));
      return entries;
    },
  },
  {
    name: "product.explicit-non-decisions inventory entry removed",
    mutate: (_docs: Map<string, string>, entries: CapabilityStatusEntry[]) =>
      entries.filter((entry) => entry.id !== "product.explicit-non-decisions"),
  },
  {
    name: "product.explicit-non-decisions tag only after Autonomy modes",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Explicit non-decisions\n\nStatus: direction\n\n", "## Explicit non-decisions\n\n"));
      return entries;
    },
  },
  {
    name: "product.settled-decisions tag removed",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Settled design decisions\n\nStatus: designed\n\n", "## Settled design decisions\n\n"));
      return entries;
    },
  },
  {
    name: "product.settled-decisions tag shipped",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Settled design decisions\n\nStatus: designed", "## Settled design decisions\n\nStatus: shipped"));
      return entries;
    },
  },
  {
    name: "product.settled-decisions tag direction",
    mutate: (docs: Map<string, string>, entries: CapabilityStatusEntry[]) => {
      docs.set("docs/product-context.md", docs.get("docs/product-context.md")!.replace("## Settled design decisions\n\nStatus: designed", "## Settled design decisions\n\nStatus: direction"));
      return entries;
    },
  },
  {
    name: "product.settled-decisions inventory entry removed",
    mutate: (_docs: Map<string, string>, entries: CapabilityStatusEntry[]) =>
      entries.filter((entry) => entry.id !== "product.settled-decisions"),
  },
])("$name fails the tagged-section check", ({ mutate }) => {
  const inventory = JSON.parse(readFileSync(join(ROOT, "docs/capability-status.json"), "utf8")) as {
    entries: CapabilityStatusEntry[];
  };
  const files = new Map(
    TAGGED_SECTIONS.map((section) => [section.doc, readFileSync(join(ROOT, section.doc), "utf8")]),
  );
  const entries = mutate(files, [...inventory.entries]);
  expect(taggedSectionErrors(entries, files, TAGGED_SECTIONS).length).toBeGreaterThan(0);
});

const TRUTH_MAINTENANCE_DOCS = ["docs/lifeos-capability-gap.md", "docs/product-context.md"] as const;
const CANON_APPROVAL_PHRASES = [
  /explicit human approval for consequential truth/i,
  /human approval for consequential truth/i,
  /owner approval for (?:canon|consequential truth)/i,
];

function canonApprovalPhrases(text: string): RegExp[] {
  const normalized = text.replace(/\s+/g, " ");
  return CANON_APPROVAL_PHRASES.filter((phrase) => phrase.test(normalized));
}

test("truth-maintenance docs do not treat human approval as the canon path", () => {
  const hits: string[] = [];
  for (const rel of TRUTH_MAINTENANCE_DOCS) {
    const text = readFileSync(join(ROOT, rel), "utf8");
    for (const phrase of canonApprovalPhrases(text)) {
      hits.push(`${rel}: ${phrase}`);
    }
  }
  expect(hits).toEqual([]);
});

test.each([
  "explicit human\napproval\tfor consequential truth",
  "human approval for\nconsequential truth",
  "owner\napproval for canon",
  "owner approval for consequential\ntruth",
])("wrapped canon approval language is rejected: %j", (text) => {
  expect(canonApprovalPhrases(text).length).toBeGreaterThan(0);
});
