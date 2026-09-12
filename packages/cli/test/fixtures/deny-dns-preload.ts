import { appendFileSync } from "node:fs";

const log = process.env.KIZUKI_DNS_LOG;

Bun.dns.lookup = ((hostname: string) => {
  if (typeof log === "string" && log.length > 0) {
    appendFileSync(log, `${hostname}\n`);
  }
  return Promise.reject(new Error("runtime dns forbidden"));
}) as typeof Bun.dns.lookup;
