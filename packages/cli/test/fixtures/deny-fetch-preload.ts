import { appendFileSync } from "node:fs";

const log = process.env.KIZUKI_FETCH_LOG;

globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
  if (typeof log === "string" && log.length > 0) {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    appendFileSync(log, `${url}\n`);
  }
  return Promise.reject(new Error("runtime fetch forbidden"));
}) as typeof fetch;
