import { afterEach, expect, test } from "bun:test";
import { ScreenpipeConnector, parseCursor } from "../src";
import {
  cleanupFixtureDatabases,
  createFixtureDatabase,
  fixtureDeps,
} from "./helpers";

// Lower case and separator-safe, so slug() leaves it intact: an upper-case
// marker would clear the surface checks below through case folding alone,
// whatever the connector did with the value.
const MARKER = "planted-capture-marker";

afterEach(cleanupFixtureDatabases);

test("captured values stay out of manifests, health, cursors and errors", async () => {
  const fixture = createFixtureDatabase();
  fixture.writer
    .query(
      `UPDATE frames
          SET full_text = ?, window_name = ?, browser_url = ?,
              document_path = ?, app_name = ?
        WHERE id = 1`,
    )
    .run(
      `text ${MARKER}`,
      `window ${MARKER}`,
      `https://mail.acme.example/${MARKER}?value=${MARKER}`,
      `/home/ada/${MARKER}.md`,
      `app ${MARKER}`,
    );
  fixture.writer
    .query(
      `UPDATE audio_transcriptions
          SET transcription = ?, device = ?
        WHERE id = 1`,
    )
    .run(`transcript ${MARKER}`, `device ${MARKER}`);
  fixture.writer
    .query("UPDATE speakers SET name = ? WHERE id = 1")
    .run(`speaker ${MARKER}`);

  const connector = new ScreenpipeConnector(
    { path: fixture.path, settle_seconds: 0 },
    fixtureDeps("2026-01-09T00:00:00.000Z"),
  );
  const manifest = connector.manifest();
  const before = await connector.health();
  const batch = await connector.backfill(null);
  const after = await connector.health();
  if (batch.cursor === null) throw new Error("expected a screenpipe cursor");

  expect(JSON.stringify(manifest)).not.toContain(MARKER);
  expect(before.detail).not.toContain(MARKER);
  expect(after.detail).not.toContain(MARKER);
  expect(batch.cursor).not.toContain(MARKER);
  expect(parseCursor(batch.cursor).last_frame_id).toBe(8);

  // A subject id is the slug of a captured name by design: the app, the site
  // host and the audio device are what the owner's world is made of, and the
  // staging floor mints one entity candidate per distinct id.
  expect(
    batch.events.flatMap(({ subjects }) =>
      subjects.map(({ subject_id }) => subject_id),
    ),
  ).toContain(`screenpipe:app:app-${MARKER}`);

  // Every event field that is not text, a display name or a documented
  // metadata key is connector-authored, so none of it may carry captured text.
  const safeEventSurface = batch.events.map((event) => ({
    schema: event.schema,
    connector_id: event.connector_id,
    source_record_id: event.source_record_id,
    kind: event.kind,
    occurred_at: event.occurred_at,
    observed_at: event.observed_at,
    roles: event.subjects.map(({ role }) => role),
    sensitivity_hint: event.sensitivity_hint,
    deleted: event.deleted,
    attachments: event.attachments,
  }));
  expect(JSON.stringify(safeEventSurface)).not.toContain(MARKER);

  const capturedSurfaces = batch.events.flatMap((event) => [
    event.text,
    ...event.subjects.map(({ display_name }) => display_name ?? ""),
    JSON.stringify(event.metadata),
  ]);
  expect(capturedSurfaces.some((value) => value.includes(MARKER))).toBe(true);

  const messages: string[] = [];
  try {
    await connector.sync("{malformed");
  } catch (error) {
    messages.push(error instanceof Error ? error.message : String(error));
  }
  fixture.writer.exec("ALTER TABLE frames DROP COLUMN full_text");
  try {
    await connector.sync(batch.cursor);
  } catch (error) {
    messages.push(error instanceof Error ? error.message : String(error));
  }
  expect(messages).toHaveLength(2);
  expect(messages.join("\n")).not.toContain(MARKER);
  // The four surfaces the spec keeps captured text out of, restated together
  // so a leak into any one of them fails here.
  expect(
    [
      JSON.stringify(manifest),
      before.detail ?? "",
      after.detail ?? "",
      batch.cursor,
      ...messages,
    ].some((surface) => surface.includes(MARKER)),
  ).toBe(false);
  await connector.revoke();
});
