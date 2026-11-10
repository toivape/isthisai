import type { CheckError, CheckErrorCode } from "./types";

const KEYS: Record<CheckErrorCode, string> = {
  permission_denied: "error_permission_denied",
  fetch_failed: "error_fetch_failed",
  timeout: "error_timeout",
  too_large: "error_too_large",
  unsupported_type: "error_unsupported_type",
};

export const errorMessageKey = (code: CheckErrorCode): string => KEYS[code];

export const resultWindowPath = (error?: CheckError): string =>
  `src/confirm/confirm.html?view=result${error ? `&error=${error.code}` : ""}`;
