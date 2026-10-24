import {
  hashAccountKey,
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
} from "@getpaseo/plugin/server/usage";
import { inputSchema } from "../shared/input.js";
import { createNodeProbe, ProbeError, type AntigravityProbe } from "./probe.js";
export { mapQuotaSummary, readTierLabel } from "./quota.js";
import { mapCliUsageOutput } from "./quota.js";
import { UsageError } from "./errors.js";

// Production account initialization endpoint. loadCodeAssist stays strictly on cloudcode-pa.
export const PLAN_BASE_URL = "https://cloudcode-pa.googleapis.com/v1internal:";

// Primary daily endpoint aligned with AGY CLI 1.4.6, followed by cloudcode-pa fallback per OmniRoute #8965 and CLIProxyAPI #3876.
export const QUOTA_BASE_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:",
  "https://cloudcode-pa.googleapis.com/v1internal:",
] as const;

export class QuotaHttpError extends UsageError {
  constructor(readonly status: number) {
    super(`Antigravity quota request failed (HTTP ${status}).`);
  }
}

/** Enforce a wall-clock bound even if an injected transport ignores abort. */
export async function withTimeout<T>(
  timeoutMs: number,
  phase: string,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new UsageError(`Antigravity ${phase} timed out.`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function request(
  method: "retrieveUserQuotaSummary" | "loadCodeAssist",
  token: string,
  fetchApi: typeof fetch,
  signal: AbortSignal,
): Promise<unknown> {
  // loadCodeAssist is strictly for tier lookup and never switches to staging/daily
  if (method === "loadCodeAssist") {
    let response: Response;
    try {
      response = await fetchApi(PLAN_BASE_URL + method, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": "antigravity",
        },
        body: JSON.stringify({ metadata: { pluginType: "GEMINI" } }),
        signal,
        redirect: "error",
      });
    } catch {
      throw new UsageError(`Antigravity ${method} request failed. Check network connectivity.`);
    }
    if (!response.ok) throw new QuotaHttpError(response.status);
    try {
      return await response.json();
    } catch {
      throw new UsageError(`Antigravity ${method} returned invalid JSON.`);
    }
  }

  // retrieveUserQuotaSummary uses AGY-aligned daily endpoint first, falling back to production.
  // Responses are atomic from a single endpoint — never stitched across endpoints.
  let lastError: unknown = null;
  for (let i = 0; i < QUOTA_BASE_URLS.length; i++) {
    if (signal.aborted) {
      throw new UsageError(`Antigravity ${method} request failed. Check network connectivity.`);
    }
    const baseUrl = QUOTA_BASE_URLS[i]!;
    let response: Response;
    try {
      response = await fetchApi(baseUrl + method, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": "antigravity",
        },
        body: "{}",
        signal,
        redirect: "error", // Never forward bearer credentials to a redirected host.
      });
    } catch (err) {
      lastError = err;
      if (signal.aborted || i === QUOTA_BASE_URLS.length - 1) {
        throw new UsageError(`Antigravity ${method} request failed. Check network connectivity.`);
      }
      continue;
    }

    if (!response.ok) {
      const httpError = new QuotaHttpError(response.status);
      // All HTTP 4xx errors fail fast without fallback.
      // Only network failures and HTTP 5xx server errors trigger fallback to alternative endpoints.
      const isClientError = response.status >= 400 && response.status < 500;
      if (isClientError || i === QUOTA_BASE_URLS.length - 1) {
        throw httpError;
      }
      lastError = httpError;
      continue;
    }

    try {
      const document: unknown = await response.json();
      return document;
    } catch {
      throw new UsageError(`Antigravity ${method} returned invalid JSON.`);
    }
  }

  if (lastError instanceof UsageError) throw lastError;
  throw new UsageError(`Antigravity ${method} request failed. Check network connectivity.`);
}

export interface UsageDependencies {
  probe: AntigravityProbe;
  fetchApi?: typeof fetch;
  now?: () => number;
}

export function createUsageHandlers(dependencies: UsageDependencies) {
  const { probe } = dependencies;
  return {
    async discover(scope: UsageScope): Promise<UsageAccount[]> {
      // OS keyring login ownership cannot be inferred from an agent environment.
      // Do not silently attach the daemon user's default login to a session.
      if (scope.kind !== "global") return [];
      if (!(await probe.locateBinary())) return [];
      const credential = await withTimeout(4_000, "credential lookup", (signal) => probe.readCredential(signal));
      if (!credential) return [];
      return [{
        key: hashAccountKey(credential.email ? `antigravity:${credential.email}` : probe.locator),
        label: credential.email ?? "Antigravity",
        harness: "agy",
        input: { store: probe.store },
      }];
    },
    async fetch(input: unknown): Promise<UsageReport> {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return { status: "error", error: "Invalid Antigravity credential store input." };
      if (parsed.data.store !== probe.store) {
        return { status: "error", error: "This Antigravity credential store belongs to another operating system." };
      }
      try {
        // Re-read for every fetch. No access-token cache can outlive an agy login switch.
        const credential = await withTimeout(4_000, "credential lookup", (signal) => probe.readCredential(signal));
        if (!credential) {
          throw new ProbeError("The Antigravity login disappeared. Sign in with agy and rediscover usage accounts.");
        }
        // Fetch authoritative quota snapshot from native AGY CLI.
        // The CLI handles its own authentication and token refresh independently of credential.accessToken or credential.expiresAtMs.
        const rawOutput = await withTimeout(12_000, "CLI execution", (signal) => probe.runCliUsage(signal));
        return mapCliUsageOutput(rawOutput);
      } catch (error) {
        if (error instanceof QuotaHttpError && (error.status === 401 || error.status === 403)) {
          return unavailable({ kind: "rejected", status: error.status, refreshedBy: "agy" });
        }
        return {
          status: "error",
          error: error instanceof UsageError ? error.message : "Unable to read Antigravity usage.",
        };
      }
    },
  };
}

const handlers = createUsageHandlers({ probe: createNodeProbe(), fetchApi: fetch, now: Date.now });
export const discover = handlers.discover;

export function fetchUsage(input: unknown, fetchApi: typeof fetch = fetch): Promise<UsageReport> {
  return createUsageHandlers({ probe: createNodeProbe(), fetchApi, now: Date.now }).fetch(input);
}
