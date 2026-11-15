// Every OpenAI outcome a user can meet, as an i18n key (hard rule: all
// user-visible text goes through i18n). Kept out of the pages so the mapping is
// unit-tested, and shared by the options page (#10) and the result popup (#13).

import type { OpenAiError, OpenAiErrorCode } from "./types";

const KEYS: Record<OpenAiErrorCode, string> = {
  no_key: "error_openai_no_key",
  invalid_key: "error_openai_invalid_key",
  cancelled: "error_openai_cancelled",
  check_expired: "error_openai_check_expired",
  hash_mismatch: "error_openai_hash_mismatch",
  unsupported_type: "error_openai_unsupported_type",
  fetch_failed: "error_openai_fetch_failed",
  timeout: "error_openai_timeout",
  http_400: "error_openai_http_400",
  http_401: "error_openai_http_401",
  http_404: "error_openai_http_404",
  http_4xx: "error_openai_http_4xx",
  http_5xx: "error_openai_http_5xx",
  rate_limited: "error_openai_rate_limited",
  network: "error_openai_network",
  bad_response: "error_openai_bad_response",
};

export interface OpenAiMessage {
  key: string;
  substitutions?: string[];
}

// Only rate_limited says more than its code: the retry time is shown when the
// response carried one (PLAN §5). A real 429 carries no Retry-After header at
// all, so the plain message is the common case.
export function openAiErrorMessage(error: OpenAiError): OpenAiMessage {
  if (error.code === "rate_limited" && error.retryAfterSec !== undefined && error.retryAfterSec > 0) {
    return { key: "error_openai_rate_limited_after", substitutions: [String(error.retryAfterSec)] };
  }
  return { key: KEYS[error.code] };
}
