import type { WorldOpData } from "@kizuki/core/world";

/** How `kizuki world` takes and prints one registered operation. */
export interface WorldCliOp<Data extends WorldOpData = WorldOpData> {
  /** Text after `--operation NAME` in the generated usage line, before `[--json]`. */
  readonly usage: string;
  /** Options beyond `--operation` this operation takes. */
  readonly options: readonly string[];
  /** Bounds for the help schema. */
  readonly bounds: Readonly<Record<string, string>>;
  /** The complete world_view input for the options given, or null when they are not a valid call. */
  buildInput(options: ReadonlyMap<string, string>): Record<string, unknown> | null;
  render(data: Data): readonly string[];
  /** A hint for stderr that follows the output, when the answer warrants one. */
  notice?(data: Data): string | null;
}

/** Every registered operation appears once: with its command-line form, or with the reason it has none. */
export type WorldCliEntry =
  | { readonly name: string; readonly cli: WorldCliOp }
  | { readonly name: string; readonly cli: null; readonly reason: string };
