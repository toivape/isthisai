// M0 spike for issue #2: temporary menu item that parses the bundled
// halloween fixture with c2pa-wasm in the service worker and logs timings.
// Throwaway code — removed before merge; only the PLAN.md recipe survives.

const SPIKE = "[isthisai-spike]";
const VERIFY = '{"verify":{"remote_manifest_fetch":false,"ocsp_fetch":false}}';
const ms = (t0: number): string => `${Math.round(performance.now() - t0)} ms`;

// Storage must be restricted to trusted contexts on every worker start,
// so content scripts can never read the stored API key.
void chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(console.error);

async function runSpike(): Promise<void> {
  const t0 = performance.now();
  const { ensureWasm, parseSpikePng } = await import("./c2pa");
  try {
    await ensureWasm();
    const initMs = ms(t0);
    const tFetch = performance.now();
    const bytes = new Uint8Array(await (await fetch(chrome.runtime.getURL("spike/ai-test-halloween.png"))).arrayBuffer());
    const fetchMs = ms(tFetch);
    const tParse = performance.now();
    const summary = await parseSpikePng(bytes);
    const parseMs = ms(tParse);
    console.info(
      `${SPIKE} OK init=${initMs} fixture-fetch=${fetchMs} parse=${parseMs} total=${ms(t0)} summary=`,
      summary,
      `context=${VERIFY}`,
    );
  } catch (error) {
    console.error(
      `${SPIKE} FAILED after ${ms(t0)}:`,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
}

chrome.contextMenus.create({
  id: "isthisai-spike-c2pa",
  title: chrome.i18n.getMessage("spike_menu"),
  contexts: ["image"],
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "isthisai-spike-c2pa") void runSpike();
});

// A same-document console tap so the owner sees one line on the inspect view
// even if the spike itself is what fails.
console.info(`${SPIKE} worker up, menu registered`);
