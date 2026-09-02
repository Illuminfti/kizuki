import { expect, test } from "bun:test";
import { appCredentials } from "../src/app-credentials";
import { createRealApi } from "../src/client";

/**
 * The only test that reaches the real provider. It is skipped by default and
 * never runs in CI; see the package README for how to run it by hand.
 */
test.skipIf(process.env.KIZUKI_TELEGRAM_SMOKE !== "1")(
  "the real client signs in and lists one dialog",
  async () => {
    const credentials = appCredentials();
    expect(credentials).not.toBeNull();
    const api = createRealApi("", credentials as NonNullable<typeof credentials>);
    await api.connect();
    try {
      const phone = process.env.KIZUKI_TELEGRAM_SMOKE_PHONE;
      expect(typeof phone).toBe("string");
      await api.start({
        phone: phone as string,
        code: async () => prompt("code: ") ?? "",
        password: async () => prompt("password: ") ?? "",
        onError: async (name) => {
          console.error(`sign-in error: ${name}`);
          return true;
        },
      });
      const me = await api.me();
      expect(me.id.length).toBeGreaterThan(0);
      let listed = 0;
      for await (const _dialog of api.dialogs(1)) listed += 1;
      expect(listed).toBe(1);
    } finally {
      await api.disconnect();
    }
  },
);
