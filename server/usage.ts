import {
  hashAccountKey,
  unavailable,
  type UsageAccount,
  type UsageReport,
  type UsageScope,
} from "@getpaseo/plugin/server/usage";
import { inputSchema } from "../shared/input.js";
import { createNodeProbe, ProbeError, type AntigravityProbe, type StoredCredential } from "./probe.js";
import { mapQuotaSummary, readTierLabel } from "./quota.js";
import { UsageError } from "./errors.js";

const BASE_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:";
const TOKEN_MARGIN_MS = 60_000;

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

async function request(
  method: "retrieveUserQuotaSummary" | "loadCodeAssist",
  token: string,
  userAgent: string,
  fetchApi: typeof fetch,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchApi(BASE_URL + method, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": userAgent,
      },
      body: method === "loadCodeAssist" ? JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }) : "{}",
      signal,
      redirect: "error", // Never forward bearer credentials to a redirected host.
    });
  } catch {
    throw new UsageError(`Antigravity ${method} request failed. Check network connectivity.`);
  }
  if (!response.ok) throw new QuotaHttpError(response.status);
  try {
    const document: unknown = await response.json();
    return document;
  } catch {
    // Response bodies may contain secrets or untrusted server messages.
    throw new UsageError(`Antigravity ${method} returned invalid JSON.`);
  }
}

export interface UsageDependencies {
  probe: AntigravityProbe;
  fetchApi: typeof fetch;
  now: () => number;
}

export function createUsageHandlers(dependencies: UsageDependencies) {
  const { probe, fetchApi, now } = dependencies;
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
        // 续期和重试共用截止时间，留在宿主的 20 秒额度请求期限内。
        return await withTimeout(18_000, "usage refresh", async (signal) => {
          const readCredential = async () => {
            const credential = await probe.readCredential(signal);
            if (!credential) {
              throw new ProbeError("The Antigravity login disappeared. Sign in with agy and rediscover usage accounts.");
            }
            return credential;
          };
          const credential = await readCredential();
          // 服务按 CLI 身份区分 Gemini 额度池，版本取自本机 agy。
          const version = await probe.readVersion(signal);
          const userAgent = `antigravity/cli/${version}`;
          const getReport = async (login: StoredCredential): Promise<UsageReport> => {
            if (login.expiresAtMs !== null && login.expiresAtMs <= now() + TOKEN_MARGIN_MS) {
              return unavailable({ kind: "expired", expiresAt: new Date(login.expiresAtMs).toISOString(), refreshedBy: "agy" });
            }
            const token = login.accessToken;
            if (!token) return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
            // 套餐查询失败不掩盖有效额度，也不触发无关的登录续期。
            const [document, planLabel] = await Promise.all([
              request("retrieveUserQuotaSummary", token, userAgent, fetchApi, signal),
              withTimeout(2_500, "plan lookup", async (planSignal) => readTierLabel(
                await request("loadCodeAssist", token, userAgent, fetchApi, AbortSignal.any([signal, planSignal])),
              )).catch(() => null),
            ]);
            return mapQuotaSummary(document, planLabel);
          };
          let report: UsageReport;
          try {
            report = await getReport(credential);
          } catch (error) {
            if (!(error instanceof QuotaHttpError) || (error.status !== 401 && error.status !== 403)) throw error;
            report = unavailable({ kind: "rejected", status: error.status, refreshedBy: "agy" });
          }
          if (report.status !== "unavailable" || report.problem.kind === "no_quota") return report;
          await probe.refreshLogin(signal);
          // CLI 可能轮换了 token，必须重新读取，且每次取数最多续期一次。
          return getReport(await readCredential());
        });
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
