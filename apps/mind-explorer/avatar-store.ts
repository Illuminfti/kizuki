// Local profile photos from messaging ingests, matched to people without guessing.
// Sources come from KIZUKI_AVATAR_SOURCES="telegram:/abs/index.json,whatsapp:/abs/index.json".
// Each index.json is written by the owner's own ingest service; photos sit next to it.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";

export type AvatarSourceKind = "telegram" | "whatsapp";

export interface AvatarSource {
  kind: AvatarSourceKind;
  indexPath: string;
}

export interface AvatarPerson {
  key: string;
  names: Iterable<string>;
  telegramUserId?: string;
  telegramHandle?: string;
  channels?: Iterable<string>;
}

interface AvatarEntry {
  kind: AvatarSourceKind;
  file: string;
}

interface LoadedSource {
  kind: AvatarSourceKind;
  dir: string;
  mtimeMs: number;
  byName: Map<string, AvatarEntry | null>;
  byPrefix: Map<string, AvatarEntry | null>;
  byUserId: Map<string, AvatarEntry>;
  byHandle: Map<string, AvatarEntry>;
}

export function parseAvatarSources(raw: string | undefined): AvatarSource[] {
  if (!raw) return [];
  const out: AvatarSource[] = [];
  for (const part of raw.split(",")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const kind = part.slice(0, idx).trim();
    const indexPath = part.slice(idx + 1).trim();
    if ((kind === "telegram" || kind === "whatsapp") && indexPath.startsWith("/")) {
      out.push({ kind, indexPath });
    }
  }
  return out;
}

export function normalizeAvatarName(raw: string): string {
  return String(raw || "")
    .normalize("NFKC")
    .replace(/[\p{Extended_Pictographic}‍️]/gu, "")
    .replace(/[^\p{L}\p{N}\s'.-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Single-token names ("chris") are too ambiguous to attach a face to.
function isSpecificName(n: string): boolean {
  return n.split(" ").filter((t) => t.length >= 2).length >= 2;
}

function put(map: Map<string, AvatarEntry | null>, key: string, entry: AvatarEntry): void {
  if (!key) return;
  const prev = map.get(key);
  if (prev === undefined) map.set(key, entry);
  else if (prev && prev.file !== entry.file) map.set(key, null);
}

// Contacts are often saved with notes after the name ("Jane Roe met at expo"): index the leading full name too.
function addName(src: LoadedSource, raw: unknown, entry: AvatarEntry): void {
  if (typeof raw !== "string") return;
  const n = normalizeAvatarName(raw);
  if (!n) return;
  put(src.byName, n, entry);
  const tokens = n.split(" ");
  for (let len = 2; len < Math.min(tokens.length, 4); len++) put(src.byPrefix, tokens.slice(0, len).join(" "), entry);
}

function loadSource(src: AvatarSource): LoadedSource | null {
  if (!existsSync(src.indexPath)) return null;
  const mtimeMs = statSync(src.indexPath).mtimeMs;
  let rows: unknown;
  try {
    rows = JSON.parse(readFileSync(src.indexPath, "utf8"));
  } catch {
    return null;
  }
  const loaded: LoadedSource = {
    kind: src.kind,
    dir: dirname(src.indexPath),
    mtimeMs,
    byName: new Map(),
    byPrefix: new Map(),
    byUserId: new Map(),
    byHandle: new Map(),
  };
  if (!Array.isArray(rows)) return loaded;
  for (const row of rows as Array<Record<string, unknown>>) {
    if (!row || row.has_photo !== true || typeof row.file !== "string") continue;
    if (!/^[A-Za-z0-9_.-]+\.jpg$/.test(row.file)) continue;
    const entry: AvatarEntry = { kind: src.kind, file: row.file };
    if (src.kind === "telegram") {
      if (row.user_id != null) loaded.byUserId.set(String(row.user_id), entry);
      if (typeof row.username === "string" && row.username) loaded.byHandle.set(row.username.toLowerCase(), entry);
      addName(loaded, row.display_name, entry);
      addName(loaded, [row.first_name, row.last_name].filter(Boolean).join(" "), entry);
    } else {
      addName(loaded, row.name, entry);
      addName(loaded, row.push_name, entry);
      addName(loaded, row.verified_name, entry);
    }
  }
  return loaded;
}

export class AvatarStore {
  private readonly sources: AvatarSource[];
  private loaded = new Map<string, LoadedSource>();
  private lastCheck = 0;

  constructor(sources: AvatarSource[], private readonly recheckMs = 60_000) {
    this.sources = sources;
  }

  get enabled(): boolean {
    return this.sources.length > 0;
  }

  private refresh(): void {
    const now = performance.now();
    if (this.loaded.size && now - this.lastCheck < this.recheckMs) return;
    this.lastCheck = now;
    for (const src of this.sources) {
      const prev = this.loaded.get(src.indexPath);
      let mtime = -1;
      try {
        mtime = statSync(src.indexPath).mtimeMs;
      } catch {
        this.loaded.delete(src.indexPath);
        continue;
      }
      if (prev && prev.mtimeMs === mtime) continue;
      const next = loadSource(src);
      if (next) this.loaded.set(src.indexPath, next);
    }
  }

  private find(person: AvatarPerson): { src: LoadedSource; entry: AvatarEntry } | null {
    this.refresh();
    const channels = new Set(person.channels || []);
    const ordered = [...this.loaded.values()].sort((a, b) => {
      const ah = channels.has(a.kind) ? 0 : 1;
      const bh = channels.has(b.kind) ? 0 : 1;
      return ah - bh;
    });
    for (const src of ordered) {
      if (src.kind === "telegram") {
        const id = person.telegramUserId ? String(person.telegramUserId).trim() : "";
        if (id && src.byUserId.has(id)) return { src, entry: src.byUserId.get(id)! };
        const handle = (person.telegramHandle || "").replace(/^@+/, "").toLowerCase();
        if (handle && src.byHandle.has(handle)) return { src, entry: src.byHandle.get(handle)! };
      }
    }
    const names = [...person.names].map(normalizeAvatarName).filter(Boolean);
    for (const map of ["byName", "byPrefix"] as const) {
      for (const src of ordered) {
        for (const n of names) {
          if (!isSpecificName(n)) continue;
          const hit = src[map].get(n);
          if (hit) return { src, entry: hit };
        }
      }
    }
    // A one-word name attaches only when it is the person's own name, they use that channel,
    // and exactly one photo carries that name across every source.
    const primary = names[0];
    if (primary && !isSpecificName(primary)) {
      const hits = [...this.loaded.values()]
        .map((src) => ({ src, entry: src.byName.get(primary) }))
        .filter((h) => h.entry !== undefined);
      if (hits.length === 1 && hits[0].entry && channels.has(hits[0].src.kind)) {
        return { src: hits[0].src, entry: hits[0].entry };
      }
    }
    return null;
  }

  has(person: AvatarPerson): boolean {
    return this.enabled && this.find(person) !== null;
  }

  /** Absolute path of the matched photo, guaranteed to be inside its source directory. */
  filePath(person: AvatarPerson): string | null {
    if (!this.enabled) return null;
    const hit = this.find(person);
    if (!hit) return null;
    const base = resolve(hit.src.dir);
    const abs = resolve(base, hit.entry.file);
    if (!abs.startsWith(base + sep) || !existsSync(abs)) return null;
    return abs;
  }
}
