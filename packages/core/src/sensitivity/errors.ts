export const SENSITIVITY_ERROR_CODES = [
  "floor_below_manifest",
  "floor_below_current",
  "default_below_floor",
] as const;
export type SensitivityErrorCode = (typeof SENSITIVITY_ERROR_CODES)[number];

export class SensitivityError extends Error {
  override readonly name = "SensitivityError";

  constructor(
    readonly code: SensitivityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`SensitivityError: ${code}: ${message}`, options);
  }
}
