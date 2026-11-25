import { Tiktoken } from "js-tiktoken/lite";
import ranks from "js-tiktoken/ranks/cl100k_base";

/** This packet's encoding, not a promise about the downstream model's tokenizer. */
export const PACKET_TOKENIZER_ID = "js-tiktoken@1.0.21/cl100k_base";

const PAT_REGEX = new RegExp(ranks.pat_str, "ug");
const PIECE_CACHE_MAX = 32_768;
const SEGMENT_CACHE_MAX = 4_096;
const EXACT_CACHE_MAX = 256;
const EXACT_CACHE_MAX_CHARS = 16_384;

let encoding: Tiktoken | undefined;
let binRanks: Map<string, number> | undefined;

const pieceCountCache = new Map<string, number>();
const segmentCountCache = new Map<string, number>();
const exactCountCache = new Map<string, number>();

function vocabulary(): Tiktoken {
  // Most hosts never need token decoding. Build Tiktoken only on prefix truncation.
  encoding ??= new Tiktoken(ranks);
  return encoding;
}

function rankTable(): Map<string, number> {
  if (binRanks !== undefined) return binRanks;
  const table = new Map<string, number>();
  const lines = ranks.bpe_ranks.split("\n");
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    if (!line) continue;
    const parts = line.split(" ");
    const offset = Number.parseInt(parts[1]!, 10);
    for (let i = 2; i < parts.length; i += 1) {
      table.set(Buffer.from(parts[i]!, "base64").toString("latin1"), offset + (i - 2));
    }
  }
  binRanks = table;
  return table;
}

function toBinaryBytes(piece: string): string {
  for (let i = 0; i < piece.length; i += 1) {
    if (piece.charCodeAt(i) >= 128) {
      return Buffer.from(piece, "utf8").toString("latin1");
    }
  }
  return piece;
}

function bpeMergeStarts(bin: string, table: Map<string, number>): { starts: Int32Array; len: number } {
  const n = bin.length;
  const starts = new Int32Array(n + 1);
  for (let i = 0; i <= n; i += 1) starts[i] = i;
  let len = n;
  while (len > 1) {
    let minRank = Infinity;
    let minIdx = -1;
    for (let i = 0; i < len - 1; i += 1) {
      const rank = table.get(bin.slice(starts[i]!, starts[i + 2]!));
      if (rank !== undefined && rank < minRank) {
        minRank = rank;
        minIdx = i;
      }
    }
    if (minIdx === -1) break;
    for (let i = minIdx + 1; i < len; i += 1) starts[i] = starts[i + 1]!;
    len -= 1;
  }
  return { starts, len };
}

function bpePieceCount(piece: string, table: Map<string, number>): number {
  const cached = pieceCountCache.get(piece);
  if (cached !== undefined) return cached;
  const bin = toBinaryBytes(piece);
  let count: number;
  if (bin.length <= 1) {
    count = bin.length;
  } else if (table.has(bin)) {
    count = 1;
  } else {
    count = bpeMergeStarts(bin, table).len;
  }
  if (piece.length <= 256) {
    if (pieceCountCache.size >= PIECE_CACHE_MAX) pieceCountCache.clear();
    pieceCountCache.set(piece, count);
  }
  return count;
}

function bpePieceEncode(piece: string, table: Map<string, number>): number[] {
  const bin = toBinaryBytes(piece);
  if (bin.length === 0) return [];
  const single = table.get(bin);
  if (single !== undefined) return [single];
  if (bin.length === 1) return [];
  const { starts, len } = bpeMergeStarts(bin, table);
  const tokens: number[] = [];
  for (let i = 0; i < len; i += 1) {
    const rank = table.get(bin.slice(starts[i]!, starts[i + 1]!));
    if (rank !== undefined) tokens.push(rank);
  }
  return tokens;
}

function countSegment(segment: string, table: Map<string, number>): number {
  const cached = segmentCountCache.get(segment);
  if (cached !== undefined) return cached;
  PAT_REGEX.lastIndex = 0;
  let total = 0;
  let match: RegExpExecArray | null;
  while ((match = PAT_REGEX.exec(segment)) !== null) {
    total += bpePieceCount(match[0], table);
  }
  if (segment.length <= 4_096) {
    if (segmentCountCache.size >= SEGMENT_CACHE_MAX) segmentCountCache.clear();
    segmentCountCache.set(segment, total);
  }
  return total;
}

/**
 * Bundled ranks; special-token-looking source text is encoded as ordinary text.
 *
 * Under cl100k_base's pat_str, no regex branch can cross a `\n` followed by a
 * printable non-space ASCII character (33..126), so splitting at those
 * boundaries is exact and lets incremental packet packing reuse per-line counts.
 */
export function packetTokens(value: string): number {
  if (value.length === 0) return 0;
  if (value.length <= EXACT_CACHE_MAX_CHARS) {
    const exact = exactCountCache.get(value);
    if (exact !== undefined) return exact;
  }
  const table = rankTable();
  let total = 0;
  let start = 0;
  let nl = value.indexOf("\n");
  while (nl !== -1 && nl + 1 < value.length) {
    const nextCode = value.charCodeAt(nl + 1);
    if (nextCode >= 33 && nextCode <= 126) {
      total += countSegment(value.slice(start, nl + 1), table);
      start = nl + 1;
    }
    nl = value.indexOf("\n", nl + 1);
  }
  if (start === 0) {
    total = countSegment(value, table);
  } else {
    total += countSegment(value.slice(start), table);
  }
  if (value.length <= EXACT_CACHE_MAX_CHARS) {
    if (exactCountCache.size >= EXACT_CACHE_MAX) exactCountCache.clear();
    exactCountCache.set(value, total);
  }
  return total;
}

/** Longest prefix of `value` that fits `budget` tokens. Stops encoding at `budget`. */
export function packetPrefix(value: string, budget: number): string {
  if (budget <= 0 || value.length === 0) return "";
  if (packetTokens(value) <= budget) return value;
  const table = rankTable();
  const tokens: number[] = [];
  PAT_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PAT_REGEX.exec(value)) !== null) {
    const pieceTokens = bpePieceEncode(match[0], table);
    for (let i = 0; i < pieceTokens.length; i += 1) {
      tokens.push(pieceTokens[i]!);
      if (tokens.length === budget) return vocabulary().decode(tokens);
    }
  }
  return value;
}
