/**
 * ULID: 48-bit big-endian millisecond timestamp + 80 bits of randomness, both
 * in Crockford base32. Lexicographic string order matches creation order,
 * which is what lets the ledger page by event_id without a secondary index.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
const TIME_LEN = 10;
const RANDOM_LEN = 16;
const MAX_TIME = 281474976710655; // 2^48 - 1

let lastTime = -1;
const lastRandom: number[] = new Array<number>(RANDOM_LEN).fill(0);

function encodeTime(time: number): string {
  let out = "";
  let rest = time;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING.charAt(rest % 32) + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

function fillRandom(target: number[]): void {
  const bytes = new Uint8Array(RANDOM_LEN);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < RANDOM_LEN; i++) {
    // 256 is a whole multiple of 32, so the mask stays uniform over the alphabet.
    target[i] = (bytes[i] ?? 0) & 31;
  }
}

function incrementRandom(target: number[]): void {
  for (let i = RANDOM_LEN - 1; i >= 0; i--) {
    const digit = target[i] ?? 0;
    if (digit < 31) {
      target[i] = digit + 1;
      return;
    }
    target[i] = 0;
  }
  throw new Error("ulid: randomness exhausted within a single millisecond");
}

export function ulid(): string {
  const now = Date.now();
  if (now > MAX_TIME) {
    throw new RangeError("ulid: timestamp exceeds the 48-bit ULID range");
  }

  if (now > lastTime) {
    lastTime = now;
    fillRandom(lastRandom);
  } else {
    // Same millisecond, or a clock that stepped backwards: keep the previous
    // timestamp and step the random field so ordering never regresses.
    incrementRandom(lastRandom);
  }

  let out = encodeTime(lastTime);
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING.charAt(lastRandom[i] ?? 0);
  }
  return out;
}
