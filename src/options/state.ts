// The options page's decisions, kept out of the DOM wiring so they can be
// unit-tested: what the status line says, when the test button is usable, and
// whether a test reply still describes the key that is saved now.
//
// `hasKey: undefined` means the worker did not answer — which is not the same as
// "no key saved", and must not disable testing as if storage were empty.
export interface OptionsState {
  hasKey: boolean | undefined;
  /** Bumped on every save or clear, so replies from before the change are stale. */
  revision: number;
  testInFlight: boolean;
}

export function optionsStatusKey(state: OptionsState): string {
  if (state.hasKey === undefined) return "error_openai_unusable_reply";
  return state.hasKey ? "options_key_saved" : "options_key_absent";
}

// A test spends part of a strict quota, so a second click must not start a second
// upload, and an absent or unknown key gives nothing to test.
export function testEnabled(state: OptionsState): boolean {
  return state.hasKey === true && !state.testInFlight;
}

// Testing one key and then saving another must not leave the first key's verdict
// on screen, including when its reply lands after the change.
export function isStaleTestReply(state: OptionsState, startedAtRevision: number): boolean {
  return startedAtRevision !== state.revision;
}
