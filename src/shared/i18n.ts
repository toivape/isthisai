// All user-visible strings go through chrome.i18n.getMessage.
// Key naming convention: <surface>_<element>[_<qualifier>], snake_case.
//   surface: options | confirm | popup | badge | toast | menu | error | ext
//   element: the UI element or message, for example headline, save_button
//   qualifier: optional, for example popup_headline_ai_signal
// The badge text TÄ is a literal in both locales, not an i18n key.

export function message(key: string, substitutions?: string[]): string {
  return chrome.i18n.getMessage(key, substitutions);
}

// Sets textContent of every [data-i18n] element from its data-i18n key.
// __MSG_...__ substitution does not work inside extension HTML pages, so
// pages start with data-i18n attributes and fill their text at runtime.
export function applyI18n(root: Document | ShadowRoot): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = message(el.dataset.i18n ?? "");
  }
}
