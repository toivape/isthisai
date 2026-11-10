// Shared size limits (PLAN §3): a blob read is capped at 45 MiB so its base64
// form (60 MiB) stays under the 64 MiB extension-message ceiling.

export const MAX_BLOB_BYTES = 45 * 1024 * 1024;

// Streaming download cap for the image fetch (PLAN §4 step 3).
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

// One deadline for the whole download, headers and body; Chrome stops the
// worker at 30 s and a body trickling in past that is lost (measured, §2).
export const FETCH_DEADLINE_MS = 25_000;
