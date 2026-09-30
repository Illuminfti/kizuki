import { KizukiError, validateEventInput } from "../../packages/core/src/index";
import { parseFrontmatter } from "../../packages/core/src/vault/frontmatter";
import { parseLegacyFrontmatter } from "../../packages/connectors/src/import-legacy-wiki/frontmatter";
import { parseChatGptExport } from "../../packages/connectors/src/import-chatgpt";
import { parseClaudeExport } from "../../packages/connectors/src/import-claude";
import { parsePocketCsv } from "../../packages/connectors/src/import-pocket/rows";
import { splitWhatsAppMessages } from "../../packages/connectors/src/import-whatsapp/grammar";
import { parseOmnivoreMetadata } from "../../packages/connectors/src/import-omnivore/metadata";
import { parseBeaconExport } from "../../packages/connectors/src/import-beacon";
import { parseAlgalRunReceipt, ALGAL_RECEIPT_CONSENT } from "../../packages/connectors/src/import-algal-receipt";
import { parseSlopcameraRenderOutput, SLOPCAMERA_OUTPUT_CONSENT } from "../../packages/connectors/src/import-slopcamera-output";
import { parseIcs } from "../../packages/connector-ics/src/parse";
import { parseRrule } from "../../packages/connector-ics/src/rrule";
import { makeFetcher } from "../../packages/connector-ics/src/fetch";
import { calendarEvents } from "../../packages/connector-ics/src/events";
import { messageEvent } from "../../packages/connector-imap/src/events";
import { parseResponse } from "../../packages/connector-imap/src/imap/tokenizer";
import { mapMessage } from "../../packages/connector-telegram/src/map";
import { parseYtd } from "../../packages/connector-x/src/ytd";
import { parsePage } from "../../packages/connector-x/src/api/parse";
import { messageEvent as gmailEvent } from "../../packages/connector-gmail/src/events";
import { object as calendarObject } from "../../packages/connector-google-calendar/src/state";
import { event as googleEvent } from "../../packages/connector-google-calendar/src/events";
import { SessionReader } from "../../packages/connector-agent-sessions/src/session";
import { mapFrame, mapTranscription } from "../../packages/connector-screenpipe/src/map";
import { recordEvent } from "../../packages/connector-whoop/src/events";
import { RESOURCES } from "../../packages/connector-whoop/src/state";
import { createBeeperConnector } from "../../packages/connector-beeper/src/connector";
import type { FuzzCase } from "./cases";

export const NOW = "2026-01-15T12:00:00.000Z";
export const PARSERS = ["canon-frontmatter", "wiki-frontmatter", "chatgpt", "claude", "pocket", "whatsapp", "omnivore", "beacon", "receipt", "render-output", "ics", "ics-rrule", "ics-feed", "imap-mime", "imap-response", "telegram", "x-ytd", "x-api", "gmail", "google-calendar", "session-claude", "session-codex", "screenpipe-frame", "screenpipe-audio", "whoop", "beeper"] as const;
export type Parser = typeof PARSERS[number];

function json(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new KizukiError("parse_error", "synthetic malformed JSON"); }
}

export function checkEvents(events: readonly unknown[]): void {
  for (const event of events) {
    if (!validateEventInput(event).ok) throw new Error("invalid-ingress");
  }
}

/** Raw grammar mutation plus a valid envelope carrying the mutated text. */
export function parseCase(target: Parser, input: FuzzCase, wrapped: boolean): unknown {
  const text = input.text;
  switch (target) {
    case "canon-frontmatter": return parseFrontmatter(wrapped ? `---\nid: fact:synthetic\ntitle: Synthetic\ntype: fact\nstatus: active\nsensitivity: private\ntaint: quoted\n---\n${text}` : text);
    case "wiki-frontmatter": return parseLegacyFrontmatter(wrapped ? `---\ntitle: ${JSON.stringify(text.slice(0, 256))}\n---\n${text}` : text);
    case "chatgpt": {
      const source = wrapped ? JSON.stringify([{ id: "synthetic", mapping: { turn: { message: { author: { role: "user" }, content: { parts: [text] }, create_time: 1768478400 } } } }]) : text;
      const result = parseChatGptExport(source, NOW); checkEvents(result.events); return result;
    }
    case "claude": {
      const source = wrapped ? JSON.stringify([{ uuid: "synthetic", created_at: NOW, chat_messages: [{ uuid: "turn", sender: "human", created_at: NOW, text }] }]) : text;
      const result = parseClaudeExport(source, NOW); checkEvents(result.events); return result;
    }
    case "pocket": return parsePocketCsv(wrapped ? `url,time_added,title\nhttps://example.invalid,1768478400,${'"' + text.replace(/"/g, '""') + '"'}\n` : text, "synthetic.csv");
    case "whatsapp": return splitWhatsAppMessages(wrapped ? `15/01/2026, 12:00 - Example: ${text}` : text, "dmy");
    case "omnivore": return parseOmnivoreMetadata(wrapped ? JSON.stringify([{ id: "synthetic", slug: "synthetic", title: text, savedAt: NOW }]) : text, "synthetic.json");
    case "beacon": {
      const source = wrapped ? JSON.stringify({ vendor: "beacon", product: "endpoint-agent", schema_version: "1.0", timestamp: NOW,
        severity: "info", endpoint: { os: "linux" }, harness: { name: "codex" },
        event: { id: "synthetic", kind: "agent_runtime", category: "prompt", action: "prompt.submitted" }, prompt: { text } }) : text;
      const result = parseBeaconExport(source, NOW); checkEvents(result.events); return result;
    }
    case "receipt": {
      const source = wrapped ? JSON.stringify({ contract: "algal.run.v1", runtime: { name: "algal", version: "0" },
        manifestDigest: `sha256:${"a".repeat(64)}`, manifestKey: "synthetic", args: { task: { instruction: text } },
        outcome: "complete", cells: {}, effects: [], events: [], work: { steps: 0, agentCalls: 0, units: 0 }, digest: `sha256:${"b".repeat(64)}` }) : text;
      const result = parseAlgalRunReceipt(source, { observedAt: NOW, consent: ALGAL_RECEIPT_CONSENT });
      if (result.status !== "refused") checkEvents([result.event]);
      return result;
    }
    case "render-output": {
      const digest = "a".repeat(64);
      const source = wrapped ? JSON.stringify({ bytes: 1, kind: "slopcamera.project-render-output-reference",
        path: "renders/candidates/synthetic.mp4", planArtifactSha256: digest, projectId: "project_synthetic1",
        revisionSha256: digest, schemaVersion: 1, sha256: digest }) : text;
      const result = parseSlopcameraRenderOutput(source, { observedAt: NOW, consent: SLOPCAMERA_OUTPUT_CONSENT,
        ...(wrapped ? { note: { author: "agent" as const, rationale: text, outputSha256: digest } } : {}) });
      if (result.status !== "refused") checkEvents([result.event]);
      return result;
    }
    case "ics": {
      const source = wrapped ? `BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:synthetic\nDTSTART:20260115T120000Z\nSUMMARY:${text.replace(/\n/g, "\n ")}\nEND:VEVENT\nEND:VCALENDAR\n` : text;
      const result = calendarEvents(parseIcs(source), { observedAt: NOW, now: new Date(NOW), slugSource: "synthetic" });
      checkEvents(result.events); return result;
    }
    case "ics-rrule": return parseRrule(text);
    case "ics-feed": {
      const raw = wrapped ? Buffer.concat([Buffer.from("BEGIN:VCALENDAR\nX-SYNTHETIC:"), input.bytes, Buffer.from("\nEND:VCALENDAR\n")]) : input.bytes;
      const fetcher = makeFetcher(async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          const split = Math.floor(raw.length / 2);
          controller.enqueue(raw.subarray(0, split));
          for (let at = 0; at < 100; at += 1) controller.enqueue(new Uint8Array(0));
          controller.enqueue(raw.subarray(split)); controller.close();
        },
      })));
      return fetcher("https://example.invalid/synthetic.ics", {}).then(result => parseIcs(result.text));
    }
    case "imap-mime": {
      const raw = wrapped ? Buffer.concat([Buffer.from("Content-Type: text/plain; charset=utf-8\r\n\r\n"), input.bytes]) : input.bytes;
      const result = messageEvent({ folderWire: "INBOX", folderDisplay: "INBOX", uidvalidity: 1, uid: 1, internaldate: "15-Jan-2026 12:00:00 +0000", size: raw.length, raw, section: "", observedAt: NOW });
      checkEvents([result]); return result;
    }
    case "imap-response": return parseResponse(wrapped ? `* OK ${text}` : text, []);
    case "telegram": {
      // This is the typed provider projection; ingress validates the mapped event.
      const result = mapMessage({ peer_id: "2", id: 1, date: 1768478400, text, out: false, service: false },
        { peer_id: "2", peer_type: "user", title: "Example", top_message_id: 1 }, { id: "1", bot: false }, NOW);
      if (result !== null && result.sensitivity_hint !== "private") throw new Error("sensitivity-lowered");
      return { event: result, admitted: validateEventInput(result).ok };
    }
    case "x-ytd": return parseYtd(wrapped ? `window.YTD.tweets.part0 = ${JSON.stringify([{ tweet: { id_str: "1", full_text: text } }])};` : text, "tweets", 0);
    case "x-api": return parsePage(wrapped ? { data: [{ id: "1", author_id: "1", text, created_at: NOW }], meta: { result_count: 1 } } : json(text), "1", { fields: [], history_start: NOW, wire_profile: "tweet-v2" }, NOW);
    case "gmail": {
      const result = gmailEvent("synthetic", wrapped ? { id: "1", threadId: "2", historyId: "1", internalDate: "1768478400000", payload: { mimeType: "text/plain", body: { data: Buffer.from(text).toString("base64url") } } } : json(text), NOW, ["text"]);
      checkEvents([result]); return result;
    }
    case "google-calendar": return googleEvent("synthetic", "synthetic", wrapped ? { id: "1", status: "confirmed", updated: NOW, start: { dateTime: NOW }, end: { dateTime: "2026-01-15T13:00:00.000Z" }, summary: text } : calendarObject(json(text)), NOW, ["summary"], NOW);
    case "screenpipe-frame": {
      const result = mapFrame({ id: 1, timestamp: wrapped ? NOW : text, full_text: text,
        app_name: "Synthetic", window_name: null, browser_url: null, device_name: "Synthetic",
        focused: true, text_source: null, capture_trigger: null, snapshot_path: null,
        document_path: null, video_chunk_id: null, offset_index: 0 }, NOW);
      checkEvents([result]); return result;
    }
    case "screenpipe-audio": {
      const result = mapTranscription({ id: 1, audio_chunk_id: 1, offset_index: 0,
        timestamp: wrapped ? NOW : text, transcription: text, device: "Synthetic",
        is_input_device: true, speaker_id: null, speaker_name: null,
        transcription_engine: "synthetic", start_time: null, end_time: null }, NOW);
      checkEvents([result]); return result;
    }
    case "whoop": {
      const id = "00000000-0000-0000-0000-000000000001";
      const result = RESOURCES.map(resource => recordEvent(resource, wrapped ? {
        user_id: 1, id: resource === "cycle" ? 1 : id, cycle_id: 1, sleep_id: id,
        created_at: NOW, updated_at: NOW, score_state: "SCORED", start: NOW,
        end: NOW, timezone_offset: "Z", nap: false, sport_name: "Synthetic",
        // Mutate selected metric bags, not just an ignored provider field.
        score: json(text),
      } : json(text), "1", ["metrics", "activity"], NOW));
      checkEvents(result); return result;
    }
    case "beeper": {
      const body = wrapped ? Buffer.from(JSON.stringify({ items: [{ id: "1", accountID: "1", chatID: "1", sortKey: "1", timestamp: NOW, text }], hasMore: false })) : input.bytes;
      const connector = createBeeperConnector({ token_secret_ref: "env:SYNTHETIC_BEEPER_TOKEN" }, {
        now: () => new Date(NOW), fetch: async () => new Response(new Uint8Array(body)),
      });
      return connector.connect(async () => "synthetic-token").then(() => connector.backfill(null))
        .then(batch => { checkEvents(batch.events); return batch; }).finally(() => connector.revoke());
    }
    case "session-claude": case "session-codex": {
      const flavor = target === "session-claude" ? "claude-code" : "codex";
      const reader = new SessionReader({ flavor, connectorId: flavor === "codex" ? "kizuki.codex-sessions" : "kizuki.claude-code-sessions", relpath: "synthetic.jsonl", includeSubagents: false, excludeCwd: [], observedAt: NOW });
      const source = !wrapped ? text : flavor === "claude-code" ? JSON.stringify({ type: "user", sessionId: "synthetic", uuid: "turn", timestamp: NOW, message: { content: text } })
        : JSON.stringify({ type: "response_item", timestamp: NOW, payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
      const result = reader.read(1, source, true);
      if (result && "event" in result) checkEvents([result.event]);
      return result;
    }
  }
}
