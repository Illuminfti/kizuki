import "./deny-dns-preload.ts";

void Bun.dns.lookup("example.invalid").catch(() => undefined);
