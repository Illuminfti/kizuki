import { setGrant } from "../../src/agents";
import { serveFixture } from "./helpers";

/** Exercise credential redaction after explicit class opt-in; default denial has its own tests. */
export async function credentialFixture() {
  const fixture = await serveFixture();
  for (const name of ["reader-public", "reader-private"]) setGrant(fixture.db, name, { deny_classes: [] });
  return fixture;
}
