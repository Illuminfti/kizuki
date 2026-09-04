import { describe, expect, test } from "bun:test";
import { renderLaunchdPlist, renderSystemdUnit } from "../../src/serve/units";
import { DEFAULT_SERVE_CONFIG } from "../../src/serve/types";

const spec = {
  vaultId: "01jbvault0000000000000001",
  vaultPath: '/tmp/ada notes/$work% "one"',
  execStart: ["/opt/Kizuki App/kizuki", "serve", "--vault", '/tmp/ada notes/$work% "one"'],
  config: DEFAULT_SERVE_CONFIG,
};

describe("service argument vectors", () => {
  test("systemd preserves spaces, quotes, literal dollars and specifiers", () => {
    const unit = renderSystemdUnit(spec);
    expect(unit).toContain('ExecStart="/opt/Kizuki App/kizuki" serve --vault "/tmp/ada notes/$$work%% \\"one\\""');
    expect(unit).toContain('WorkingDirectory="/tmp/ada notes/$work%% \\"one\\""');
    expect(unit).toContain('ReadWritePaths="/tmp/ada notes/$work%% \\"one\\""');
  });

  test("launchd keeps a path with spaces as one exact XML argument", () => {
    const plist = renderLaunchdPlist(spec);
    const argumentsXml = plist.split("<array>")[1]?.split("</array>")[0] ?? "";
    expect(argumentsXml.match(/<string>/g)).toHaveLength(4);
    expect(argumentsXml).toContain("<string>/opt/Kizuki App/kizuki</string>");
    expect(argumentsXml).toContain("<string>/tmp/ada notes/$work% &quot;one&quot;</string>");
    expect(argumentsXml).not.toContain("main.ts");
  });

  test("both supervisors refuse injected directives and empty executables", () => {
    for (const render of [renderSystemdUnit, renderLaunchdPlist]) {
      expect(() => render({ ...spec, vaultPath: "/tmp/vault\nExecStart=/bin/false" })).toThrow("control characters");
      expect(() => render({ ...spec, execStart: ["/bin/kizuki", "\u0000"] })).toThrow("control characters");
      expect(() => render({ ...spec, execStart: [] })).toThrow("executable");
      expect(() => render({ ...spec, vaultId: "bad\nidentity" })).toThrow("vault identity");
    }
  });
});
