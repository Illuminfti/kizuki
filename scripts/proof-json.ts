export const PROOF_JSON_LIMITS = { bytes: 1_048_576, depth: 32 } as const;

export class ArtifactProofError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
function reject(reason: string): never { throw new ArtifactProofError(reason); }

/** Bound decoding and nesting; JSON.parse alone loses duplicate object keys. */
export function parseProofJson(bytes: string | Uint8Array): unknown {
  try {
    if ((typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength) > PROOF_JSON_LIMITS.bytes) reject("json-byte-limit");
    const raw = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const stack: (Set<string> | null)[] = [];
    for (const token of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\]]/g)) {
      const value = token[0];
      if (value === "{" || value === "[") {
        stack.push(value === "{" ? new Set() : null);
        if (stack.length > PROOF_JSON_LIMITS.depth) reject("json-depth-limit");
      } else if (value === "}" || value === "]") stack.pop();
      else {
        let after = token.index + value.length;
        while (after < raw.length && /\s/.test(raw[after]!)) after++;
        if (raw[after] === ":") {
          const keys = stack.at(-1), key = JSON.parse(value) as string;
          if (keys?.has(key)) reject("duplicate-json-key");
          keys?.add(key);
        }
      }
    }
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof ArtifactProofError) throw error;
    reject("invalid-json");
  }
}
