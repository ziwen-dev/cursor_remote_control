import { Cursor } from "@cursor/sdk";

const result = await Cursor.auth.login({
  apiKeyName: "Cursor Remote Bridge",
});

console.log(JSON.stringify({
  authenticated: true,
  email: result.email ?? null,
  apiKeyExpiresAt: new Date(result.apiKeyExpiresAtMs).toISOString(),
  credentialFile: "~/.cursor/sdk/auth.json",
}, null, 2));
