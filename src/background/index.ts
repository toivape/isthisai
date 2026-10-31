// Storage must be restricted to trusted contexts on every worker start,
// so content scripts can never read the stored API key.
void chrome.storage.local
  .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  .catch(console.error);
