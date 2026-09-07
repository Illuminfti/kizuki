/** A separate synthetic endpoint keeps serving while the observer runs synchronous native CLI commands. */
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function syntheticModelReply(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("request_shape");
  const body = raw as { model?: unknown; messages?: { content?: unknown }[]; tools?: unknown };
  if (body.model !== "native-lifecycle-synthetic" || body.tools !== undefined || !Array.isArray(body.messages) || body.messages.length !== 2 ||
      typeof body.messages[1]?.content !== "string") throw Error("request_shape");
  const prompt = body.messages[1].content;
  const event = /record ([A-Za-z0-9:_.-]+) from/.exec(prompt)?.[1], subjectJson = /"subject":"((?:\\.|[^"\\])*)"/.exec(prompt)?.[1];
  if (!event || !subjectJson) throw Error("request_binding");
  const subject = JSON.parse(`"${subjectJson}"`);
  return { id: "native-synthetic", object: "chat.completion", created: 1, model: body.model,
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ claims: [{ kind: "claim", subject,
      predicate: "employment.role", object: "Orchard library coordinator", polarity: "positive", body: "Ada coordinates Orchard library operations.",
      valid_from: null, valid_to: null, confidence: 0.7, sensitivity: "public", event_ids: [event] }] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10 } };
}

if (import.meta.main) {
  const workspace = resolve(Bun.argv[2] ?? ""), mode = Bun.argv[3];
  if (Bun.argv.length !== 4 || !["ok","unavailable"].includes(mode ?? "")) throw Error("endpoint_arguments");
  const keyPath = join(workspace, "fixture.key"), keyStat = lstatSync(keyPath);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || (keyStat.mode & 0o777) !== 0o600 || keyStat.size !== 48) throw Error("endpoint_key");
  const key = readFileSync(keyPath, "utf8"), observationPath = join(workspace, "observation.json");
  const observation = { requests: 0, unexpected: 0 };
  const save = () => { const temp = `${observationPath}.tmp`; writeFileSync(temp, JSON.stringify(observation), { mode: 0o600 }); renameSync(temp, observationPath); };
  save();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: 65_536,
    async fetch(request) {
      if (observation.requests + observation.unexpected >= 32) return new Response("request_limit", { status: 429 });
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions" || request.headers.get("authorization") !== `Bearer ${key}`) {
        observation.unexpected++; save(); return new Response("refused", { status: 403 });
      }
      observation.requests++; save();
      if (mode === "unavailable") return new Response("synthetic_unavailable", { status: 503 });
      try { return Response.json(syntheticModelReply(await request.json())); }
      catch { observation.unexpected++; save(); return new Response("synthetic_request_invalid", { status: 400 }); }
    },
  });
  writeFileSync(join(workspace, "ready.json"), JSON.stringify({ pid: process.pid, port: server.port }), { mode: 0o600, flag: "wx" });
  process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
}
