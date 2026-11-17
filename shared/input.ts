import { z } from "zod";

// Inputs are persisted by Paseo. Only store locators belong here, never tokens.
export const credentialStoreSchema = z.enum([
  "windows-credential-manager",
  "macos-keychain",
  "secret-service",
]);

export const inputSchema = z.object({ store: credentialStoreSchema }).strict();

export type CredentialStore = z.infer<typeof credentialStoreSchema>;
export type AntigravityUsageInput = z.infer<typeof inputSchema>;
