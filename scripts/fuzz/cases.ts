import corpus from "./corpus.json";

export interface FuzzCase { id: string; bytes: Uint8Array; text: string }
const encoder = new TextEncoder();

/** Fixed integer PRNG; no clocks, host paths, accounts or network inputs. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function mime(depth: number): string {
  let text = "Content-Type: text/plain\r\n\r\nneutral";
  for (let at = 0; at < depth; at += 1) text = `Content-Type: multipart/mixed; boundary=b${at}\r\n\r\n--b${at}\r\n${text}\r\n--b${at}--\r\n`;
  return text;
}

export const CORPUS_SIZE = corpus.length;

export function* cases(seed: number, count: number): Generator<FuzzCase> {
  for (const entry of corpus) {
    let text = "";
    if ("mimeDepth" in entry) text = mime(entry.mimeDepth!);
    else if ("mimeParts" in entry) text = "Content-Type: multipart/mixed; boundary=b\r\n\r\n" +
      "--b\r\nContent-Type: text/plain\r\n\r\nneutral\r\n".repeat(entry.mimeParts!) + "--b--\r\n";
    else if ("text" in entry) text = entry.text!;
    else if ("repeat" in entry) text = entry.repeat!.repeat(entry.count!);
    else if ("depth" in entry) text = "[".repeat(entry.depth!) + "0" + "]".repeat(entry.depth!);
    const bytes = "hex" in entry ? Buffer.from(entry.hex!, "hex") : encoder.encode(text);
    yield { id: entry.id, text: new TextDecoder().decode(bytes), bytes };
  }
  const next = random(seed);
  const alphabet = ['{', '}', '[', ']', '"', '\\', '\n', '\r', '\0', ':', ';', ',', ' ', 'x', 'é', '\u202e', '\u2066', '\u{e0061}'];
  for (let index = 0; index < count; index += 1) {
    const length = Math.floor(next() * 2048);
    let text = "";
    for (let at = 0; at < length; at += 1) text += alphabet[Math.floor(next() * alphabet.length)]!;
    // Duplicate runs, truncation and nesting vary separately from byte mutation.
    if (index % 4 === 0) text = JSON.stringify({ text, nested: Array.from({ length: Math.floor(next() * 128) }, () => text.slice(0, 4)) });
    if (index % 4 === 1) text = "[".repeat(index % 80) + text + "]".repeat(index % 80);
    const bytes = encoder.encode(text);
    if (index % 7 === 0 && bytes.length > 0) bytes[Math.floor(next() * bytes.length)] = 0xff;
    yield { id: `generated-${index}`, text: new TextDecoder().decode(bytes), bytes };
  }
}
