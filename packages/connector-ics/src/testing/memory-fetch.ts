import { KizukiError } from "@kizuki/core";
import type { IcsFetchResult, IcsFetcher } from "../fetch";
import { FIXTURE_ICS } from "../fixture";

export type Route = IcsFetchResult | (() => IcsFetchResult);

/** In-memory routing table standing in for the network in tests. */
export function memoryFetcher(routes: Record<string, Route>): IcsFetcher {
  return async (url) => {
    const route = routes[url];
    if (route === undefined) {
      throw new KizukiError(
        "unreachable",
        "kizuki.ics: calendar is unreachable",
      );
    }
    return typeof route === "function" ? route() : route;
  };
}

export function fixtureIcsText(): string {
  return FIXTURE_ICS;
}

export function okResult(
  text: string,
  etag: string | null = null,
): IcsFetchResult {
  return { status: 200, etag, last_modified: null, text };
}
