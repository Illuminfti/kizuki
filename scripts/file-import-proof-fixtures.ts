/** Serialized synthetic owner exports. No connector or Core fixture adapter is called. */
export const FILE_FORMATS = ["ics", "markdown-folder", "chatgpt", "claude", "x-archive", "whatsapp", "pocket", "omnivore"] as const;
export type FileFormat = typeof FILE_FORMATS[number];
export const FILE_IMPORT_POLICY = {
  purposes: ["capture", "recall", "session", "derive", "export"], allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private",
} as const;
export interface FileCase {
  format: FileFormat; connector: string; sentinel: string; source: string; events: number;
  valid: Record<string, string | Uint8Array>; invalid: Record<string, string | Uint8Array>;
  invalid_mode: "blocked" | "partial"; invalid_events: number; invalid_error: string;
}
export function fileImportFixtures(referenceDay: string): FileCase[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDay) || !Number.isFinite(Date.parse(referenceDay))) throw new Error("invalid fixture reference day");
  const tomorrow = new Date(Date.parse(referenceDay) + 86_400_000).toISOString().slice(0, 10).replaceAll("-", "");
  const sentence = (word: string) => `Synthetic ${word} evidence remains on the owner's disk.`;
  const chatgpt = (id: string, text: string) => ({ id, title: "Synthetic file proof", create_time: 1700000000,
    mapping: { n: { message: { author: { role: "user" }, content: { parts: [text] }, create_time: 1700000001 }, parent: null, children: [] } } });
  const claude = (id: string, text: string) => ({ uuid: id, name: "Synthetic file proof", created_at: "2026-01-01T09:00:00Z",
    chat_messages: [{ uuid: "n", sender: "human", text, created_at: "2026-01-01T09:00:01Z" }] });
  const account = 'window.YTD.account.part0 = [{"account":{"accountId":"123456789012345678","username":"synthetic_owner"}}];';
  const tweet = { tweet: { id_str: "1742012345678901234", created_at: "Tue Jan 02 03:04:05 +0000 2024",
    full_text: sentence("xylophoneriver"), lang: "en", entities: { urls: [], user_mentions: [] } } };
  return [
    { format: "ics", connector: "kizuki.ics", sentinel: "calendarlark", source: "calendar.ics", events: 1,
      valid: { "calendar.ics": ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Kizuki//Synthetic fixture//EN", "BEGIN:VEVENT", "UID:synthetic-calendar@example.test", `DTSTART:${tomorrow}T090000Z`, `DTEND:${tomorrow}T100000Z`, `SUMMARY:${sentence("calendarlark")}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n") },
      invalid: { "calendar.ics": "BEGIN:VEVENT\r\nSUMMARY:Synthetic invalid calendar\r\nEND:VEVENT\r\n" }, invalid_mode: "blocked", invalid_events: 0, invalid_error: "VCALENDAR" },
    { format: "markdown-folder", connector: "kizuki.markdown-folder", sentinel: "markdownotter", source: "notes", events: 1,
      valid: { "notes/welcome.md": `# Synthetic note\n\n${sentence("markdownotter")}\n` }, invalid: { "notes/broken.md": new Uint8Array([255, 254, 253]) },
      invalid_mode: "partial", invalid_events: 0, invalid_error: "not_utf8" },
    { format: "chatgpt", connector: "kizuki.import-chatgpt", sentinel: "chatgptbadger", source: "conversations.json", events: 1,
      valid: { "conversations.json": JSON.stringify([chatgpt("synthetic-chatgpt", sentence("chatgptbadger"))]) },
      invalid: { "conversations.json": JSON.stringify([chatgpt("synthetic-partial-chatgpt", sentence("chatgptbadger")), "synthetic malformed record"]) }, invalid_mode: "partial", invalid_events: 1, invalid_error: "not_object" },
    { format: "claude", connector: "kizuki.import-claude", sentinel: "claudekingfisher", source: "conversations.json", events: 1,
      valid: { "conversations.json": JSON.stringify([claude("synthetic-claude", sentence("claudekingfisher"))]) },
      invalid: { "conversations.json": JSON.stringify([claude("synthetic-partial-claude", sentence("claudekingfisher")), "synthetic malformed record"]) }, invalid_mode: "partial", invalid_events: 1, invalid_error: "not_object" },
    { format: "x-archive", connector: "kizuki.import-x-archive", sentinel: "xylophoneriver", source: "archive", events: 1,
      valid: { "archive/data/account.js": account, "archive/data/tweets.js": `window.YTD.tweets.part0 = ${JSON.stringify([tweet])};` },
      invalid: { "archive/data/account.js": account, "archive/data/tweets.js": "window.YTD.tweets.part0 = [malformed];" }, invalid_mode: "blocked", invalid_events: 0, invalid_error: "JSON" },
    { format: "whatsapp", connector: "kizuki.import-whatsapp", sentinel: "whatsappwren", source: "chat.txt", events: 1,
      valid: { "chat.txt": `1/13/26, 9:15 AM - Ada: ${sentence("whatsappwren")}\n` }, invalid: { "chat.txt": "Synthetic text without a timestamp or sender.\n" }, invalid_mode: "blocked", invalid_events: 0, invalid_error: "timestamp" },
    { format: "pocket", connector: "kizuki.import-pocket", sentinel: "pocketpuffin", source: "part_000000.csv", events: 1,
      valid: { "part_000000.csv": `title,url,time_added,tags,status\n${sentence("pocketpuffin")},https://example.test/synthetic-pocket,1767225600,synthetic,unread\n` },
      invalid: { "part_000000.csv": 'title,url,time_added\n"unterminated,https://example.test/synthetic,1767225600\n' }, invalid_mode: "blocked", invalid_events: 0, invalid_error: "quote" },
    { format: "omnivore", connector: "kizuki.import-omnivore", sentinel: "omnivoretern", source: "export", events: 1,
      valid: { "export/metadata_0_to_9.json": JSON.stringify([{ id: "a1b2c3d4-0000-4000-8000-000000000001", slug: "synthetic-omnivore", title: sentence("omnivoretern"), description: "Synthetic saved article", url: "https://example.test/synthetic-omnivore", state: "Active", labels: ["synthetic"], savedAt: "2026-01-01T09:00:00Z" }]),
        "export/highlights/synthetic-omnivore.md": "## Highlights\n\n> A synthetic highlighted sentence.\n" },
      invalid: { "export/metadata_0_to_9.json": '{"invalid":"not an item array"}' }, invalid_mode: "blocked", invalid_events: 0, invalid_error: "array" },
  ];
}
