import { mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KizukiError } from "../../packages/core/src/index";
import { createChatGptImportConnector } from "../../packages/connectors/src/import-chatgpt";
import { createClaudeImportConnector } from "../../packages/connectors/src/import-claude";
import { createBeaconImportConnector, MAX_BEACON_EXPORT_BYTES } from "../../packages/connectors/src/import-beacon";
import { createPocketImportConnector } from "../../packages/connectors/src/import-pocket";
import { createOmnivoreImportConnector } from "../../packages/connectors/src/import-omnivore";
import { createWhatsAppImportConnector } from "../../packages/connectors/src/import-whatsapp";
import { MAX_EXPORT_BYTES } from "../../packages/connectors/src/util";
import { checkEvents, NOW } from "./parsers";
import type { FuzzCase } from "./cases";

export const EXPORT_TARGETS = ["chatgpt-files", "claude-files", "beacon-files", "pocket-files", "omnivore-files", "whatsapp-files"] as const;
export type ExportTarget = typeof EXPORT_TARGETS[number];

function wrappedExport(target: ExportTarget, text: string): string {
  switch (target) {
    case "chatgpt-files": return JSON.stringify([{ id: "synthetic", mapping: { turn: { message: { author: { role: "user" }, content: { parts: [text] }, create_time: 1768478400 } } } }]);
    case "claude-files": return JSON.stringify([{ uuid: "synthetic", created_at: NOW, chat_messages: [{ uuid: "turn", sender: "human", created_at: NOW, text }] }]);
    case "beacon-files": return JSON.stringify({ vendor: "beacon", product: "endpoint-agent", schema_version: "1.0", timestamp: NOW, severity: "info", endpoint: { os: "linux" }, harness: { name: "codex" }, event: { id: "synthetic", kind: "agent_runtime", category: "prompt", action: "prompt.submitted" }, prompt: { text } });
    case "pocket-files": return `url,time_added,title\nhttps://example.invalid,1768478400,"${text.replace(/"/g, '""')}"\n`;
    case "omnivore-files": return JSON.stringify([{ id: "synthetic", slug: "synthetic", title: "Synthetic", savedAt: NOW }]);
    case "whatsapp-files": return `15/01/2026, 12:00 - Example: ${text}\n15/01/2026, 12:01 - Example: synthetic.jpg (file attached)\n`;
  }
}

/** Exercise file admission and assembled events, including optional evidence/media. */
export async function exportCase(target: ExportTarget, input: FuzzCase, scratch: string): Promise<void> {
  for (const wrapped of [false, true]) {
    const tree = join(scratch, "export");
    rmSync(tree, { recursive: true, force: true });
    mkdirSync(tree, { mode: 0o700 });
    const name = target === "pocket-files" ? "part_0.csv" : target === "whatsapp-files" ? "chat.txt"
      : target === "omnivore-files" ? "metadata_0.json" : "synthetic.json";
    const file = join(tree, name);
    const content = wrapped ? Buffer.from(wrappedExport(target, input.text)) : input.bytes;
    writeFileSync(file, content);
    if (target === "omnivore-files") {
      mkdirSync(join(tree, "highlights")); mkdirSync(join(tree, "content"));
      writeFileSync(join(tree, "highlights/synthetic.md"), input.bytes);
      writeFileSync(join(tree, "content/synthetic.html"), input.bytes);
    }
    if (target === "whatsapp-files") writeFileSync(join(tree, "synthetic.jpg"), input.bytes);
    if (input.id === "optional-symlink") {
      const other = join(scratch, "outside-evidence");
      writeFileSync(other, "outside-evidence-canary");
      const optional = target === "omnivore-files" ? join(tree, "highlights/synthetic.md")
        : target === "whatsapp-files" ? join(tree, "synthetic.jpg") : null;
      if (optional !== null) { rmSync(optional); symlinkSync(other, optional); }
    }
    if (input.id === "traversal") {
      const other = join(scratch, "linked-export");
      writeFileSync(other, content);
      rmSync(file); symlinkSync(other, file);
      if (target === "omnivore-files") {
        rmSync(join(tree, "highlights/synthetic.md"));
        symlinkSync(other, join(tree, "highlights/synthetic.md"));
      }
      if (target === "whatsapp-files") {
        rmSync(join(tree, "synthetic.jpg")); symlinkSync(other, join(tree, "synthetic.jpg"));
      }
    }
    if (input.id === "huge-line") truncateSync(file, (target === "beacon-files" ? MAX_BEACON_EXPORT_BYTES : MAX_EXPORT_BYTES) + 1);
    const path = target === "omnivore-files" ? tree : file;
    const connector = target === "chatgpt-files" ? createChatGptImportConnector({ path })
      : target === "claude-files" ? createClaudeImportConnector({ path })
      : target === "beacon-files" ? createBeaconImportConnector({ path })
      : target === "pocket-files" ? createPocketImportConnector({ path })
      : target === "omnivore-files" ? createOmnivoreImportConnector({ path })
      : createWhatsAppImportConnector({ path, date_order: "dmy", timezone: "+00:00" });
    try {
      const batch = await connector.backfill(null);
      if (input.id === "traversal") throw new Error("symlink-admitted");
      if (input.id === "huge-line") throw new Error("oversized-file-admitted");
      checkEvents(batch.events);
      if (input.id === "optional-symlink" && batch.events.some(event => event.text.includes("outside-evidence-canary") || event.attachments.length > (target === "omnivore-files" ? 1 : 0))) throw new Error("symlink-admitted");
      if (wrapped && input.id === "object" && batch.events.length === 0) throw new Error("projection-unreached");
      if (JSON.stringify(batch).length > 16 * 1024 * 1024) throw new Error("output-unbounded");
    } catch (error) {
      if (!(error instanceof KizukiError)) throw error;
      if (wrapped && input.id === "object") throw new Error("projection-unreached");
    }
  }
}
