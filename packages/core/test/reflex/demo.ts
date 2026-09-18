import { renderReflexHtml } from "../../src/reflex/render";
import { syntheticReflexReport } from "./demo-fixture";

// Run explicitly. No vault, credentials, external assets, or model requests.
syntheticReflexReport().then(report => {
  process.stdout.write(renderReflexHtml(report, { demo: true }));
}).catch(() => {
  process.stderr.write("Reflex synthetic demo failed.\n");
  process.exitCode = 1;
});
