import type { ReflexHost } from "../src/systemone";
import { fixture, response } from "../demo/fixtures";
export { fixture, response };
export function scripted(result: unknown = response()): ReflexHost {
  return { async isCurrent() { return true; }, async evaluateAuthorized() { return result as ReturnType<typeof response>; } };
}
export function many(count: number) {
  const { snapshot, change } = fixture();
  return { snapshot: { ...snapshot,
    nodes: Array.from({ length: count }, (_, index) => ({ ...snapshot.nodes[0]!, id: `fact:${index}` })), dependencies: [] },
    change: { ...change, target_ids: Array.from({ length: count }, (_, index) => `fact:${index}`) } };
}
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
