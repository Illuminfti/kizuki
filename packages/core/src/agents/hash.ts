export function sha256(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
