import { expect, test } from "bun:test";
import { GMAIL_CONNECTOR_ID, GMAIL_SCOPES, createGmailConnector, inspectGmailState } from "@kizuki/connector-gmail";
import { GmailFixture } from "@kizuki/connector-gmail/testing";
import { GOOGLE_CALENDAR_CONNECTOR_ID, GOOGLE_CALENDAR_SCOPES, createGoogleCalendarConnector, inspectGoogleCalendarState } from "@kizuki/connector-google-calendar";
import { CalendarFixture } from "../../connector-google-calendar/src/testing";
import { getConnector } from "../src";

/** Swap the granted scope string inside an otherwise valid opaque state. */
function withScope(state: Uint8Array, scope: string): Uint8Array {
  const raw = JSON.parse(new TextDecoder().decode(state));
  raw.oauth.tokens.scope = scope;
  return new TextEncoder().encode(JSON.stringify(raw));
}

test("Gmail and Calendar request disjoint provider scopes and declare disjoint egress", () => {
  const api = (scopes: readonly string[]) => scopes.filter((scope) => scope.includes("/auth/"));
  expect(api(GMAIL_SCOPES)).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
  expect(api(GOOGLE_CALENDAR_SCOPES)).toEqual(["https://www.googleapis.com/auth/calendar.events.readonly"]);
  const gmail = getConnector(GMAIL_CONNECTOR_ID, {}).manifest();
  const calendar = getConnector(GOOGLE_CALENDAR_CONNECTOR_ID, {}).manifest();
  expect(gmail.allowed_egress).toContain("gmail.googleapis.com");
  expect(gmail.allowed_egress).not.toContain("www.googleapis.com");
  expect(calendar.allowed_egress).toContain("www.googleapis.com");
  expect(calendar.allowed_egress).not.toContain("gmail.googleapis.com");
});

test("one provider's opaque state never inspects, loads or reads through the other connector", async () => {
  const gmail = new GmailFixture(1), calendar = new CalendarFixture();
  expect(inspectGmailState(gmail.state).account_id).toBe("fixture-account");
  expect(inspectGoogleCalendarState(calendar.state).account_id).toBe("fixture-account");
  expect(() => inspectGmailState(calendar.state)).toThrow();
  expect(() => inspectGoogleCalendarState(gmail.state)).toThrow();
  // A Gmail enrollment whose grant only carries Calendar consent (and vice
  // versa) refuses before any provider read; consent does not cross over.
  const crossed = {
    gmail: withScope(gmail.state, GOOGLE_CALENDAR_SCOPES.join(" ")),
    calendar: withScope(calendar.state, GMAIL_SCOPES.join(" ")),
  };
  const gmailConnector = createGmailConnector({ client: { id: "synthetic-desktop-client" }, secret_ref: "file:synthetic", fields: ["labels"] }, { fetch: gmail.fetch, persist: gmail.persist, now: gmail.now });
  await expect(gmailConnector.connect(async () => new TextDecoder().decode(crossed.gmail))).rejects.toThrow();
  const calendarConnector = createGoogleCalendarConnector({ client: { id: "synthetic-client" }, secret_ref: "file:synthetic", calendar_id: calendar.calendar, fields: [] }, { fetch: calendar.fetch, persist: calendar.persist, now: calendar.now });
  await expect(calendarConnector.connect(async () => new TextDecoder().decode(crossed.calendar))).rejects.toThrow();
  expect(gmail.requests).toEqual([]);
  expect(calendar.calls).toEqual([]);
});
