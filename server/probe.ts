import { execCommand } from "@getpaseo/plugin/server";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { z } from "zod";
import type { CredentialStore } from "../shared/input.js";
import { WINDOWS_CREDENTIAL_SCRIPT } from "./windows-credential.js";
import { UsageError } from "./errors.js";

const KEYRING_PREFIX = "go-keyring-base64:";

export class ProbeError extends UsageError {}

export interface StoredCredential {
  accessToken: string | null;
  expiresAtMs: number | null;
  email: string | null;
}

export interface AntigravityProbe {
  store: CredentialStore;
  /** Non-secret OS-user/store locator used when account metadata is absent. */
  locator: string;
  locateBinary(): Promise<string | null>;
  readVersion(signal: AbortSignal): Promise<string>;
  refreshLogin(signal: AbortSignal): Promise<void>;
  runCliUsage(signal: AbortSignal): Promise<string>;
  readCredential(signal: AbortSignal): Promise<StoredCredential | null>;
}

export interface CommandResult {
  stdout: string;
  exitCode: number;
  hasDiagnostic?: boolean;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs?: number,
) => Promise<CommandResult>;

function exitCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "number" ? error.code : null;
}

const runCommand: CommandRunner = async (file, args, signal, timeoutMs = 3_500) => {
  const isCli = args.includes("/usage");
  try {
    const { stdout } = await execCommand(file, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 128 * 1024,
      shell: false,
      signal,
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    if (signal?.aborted) {
      if (isCli) {
        throw new UsageError("Antigravity CLI execution timed out.");
      }
      throw new ProbeError("Antigravity credential lookup timed out.");
    }
    const code = exitCode(error);
    if (code !== null) {
      const hasDiagnostic = typeof error === "object" && error !== null && "stderr" in error
        && typeof error.stderr === "string" && error.stderr.trim() !== "";
      return { stdout: "", exitCode: code, hasDiagnostic };
    }
    if (isCli) {
      throw new UsageError("Cannot run Antigravity CLI. Check system permissions.");
    }
    // 子进程错误可能携带含有凭据的 stdout，禁止原样抛出。
    throw new ProbeError("Cannot run the system credential reader. Check OS keyring availability.");
  }
};

const tokenSchema = z.object({
  access_token: z.string().optional(),
  accessToken: z.string().optional(),
  refresh_token: z.string().optional(),
  refreshToken: z.string().optional(),
  expiry: z.union([z.string(), z.number()]).optional(),
  expires_at: z.union([z.string(), z.number()]).optional(),
  expiresAt: z.union([z.string(), z.number()]).optional(),
  expiry_date: z.union([z.string(), z.number()]).optional(),
  email: z.string().optional(),
  id_token: z.unknown().optional(),
  idToken: z.unknown().optional(),
});

const storedSchema = tokenSchema.extend({ token: tokenSchema.optional() });

/** Accept RFC3339, Unix seconds and Unix milliseconds, but never invent an expiry. */
export function timestampMs(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const numeric = Number(value);
  const ms = Number.isFinite(numeric)
    ? numeric < 100_000_000_000 ? numeric * 1000 : numeric
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : null;
}

/** Read locally stored identity metadata for the account label, not authentication. */
function emailFromIdToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parts = value.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return z.object({ email: z.email() }).safeParse(claims).data?.email ?? null;
  } catch {
    return null;
  }
}

/** go-keyring stores a JSON token envelope, sometimes wrapped in base64. */
export function parseStoredCredential(raw: string): StoredCredential {
  let payload = raw.trim();
  if (payload.startsWith(KEYRING_PREFIX)) {
    payload = Buffer.from(payload.slice(KEYRING_PREFIX.length), "base64").toString("utf8");
  }
  let document: unknown;
  try {
    document = JSON.parse(payload);
  } catch {
    throw new ProbeError("The Antigravity keyring item is not valid JSON.");
  }
  const parsed = storedSchema.safeParse(document);
  if (!parsed.success) throw new ProbeError("The Antigravity keyring item has an unsupported token shape.");
  const root = parsed.data;
  const token = root.token ?? root;
  const accessToken = token.access_token || token.accessToken || null;
  if (!accessToken && !token.refresh_token && !token.refreshToken) {
    throw new ProbeError("The Antigravity keyring item contains no OAuth login.");
  }
  // Refresh tokens are deliberately not retained or redeemed. Paseo's native usage
  // contract delegates refresh to the CLI so its credential store remains authoritative.
  return {
    accessToken,
    expiresAtMs: timestampMs(token.expiry ?? token.expires_at ?? token.expiresAt ?? token.expiry_date),
    email: root.email || token.email || emailFromIdToken(root.id_token ?? root.idToken ?? token.id_token ?? token.idToken),
  };
}

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  run?: CommandRunner;
  isExecutable?: (path: string) => Promise<boolean>;
}

export function createNodeProbe(options: ProbeOptions = {}): AntigravityProbe {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const run = options.run ?? runCommand;
  const isExecutable = options.isExecutable ?? (async (file: string) => {
    try {
      if (!(await stat(file)).isFile()) return false;
      await access(file, windows ? constants.F_OK : constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const store: CredentialStore = windows ? "windows-credential-manager"
    : platform === "darwin" ? "macos-keychain" : "secret-service";

  return {
    store,
    locator: `${platform}:${home}:gemini:antigravity`,
    async locateBinary() {
      const explicit = env.ANTIGRAVITY_CLI_PATH ?? env.AGY_PATH;
      if (explicit && (await isExecutable(explicit))) return explicit;

      const candidates: string[] = [];
      if (windows && env.LOCALAPPDATA) {
        candidates.push(path.join(env.LOCALAPPDATA, "agy", "bin", "agy.exe"));
      }
      // Resolve PATH ourselves: never execute an untrusted candidate merely to probe it.
      const searchPath = env.PATH ?? env.Path ?? "";
      for (const rawDirectory of searchPath.split(path.delimiter)) {
        const directory = rawDirectory.replace(/^"|"$/g, "");
        if (!path.isAbsolute(directory)) continue;
        candidates.push(path.join(directory, windows ? "agy.exe" : "agy"));
      }
      if (!windows) {
        // Desktop daemons can have a narrower PATH than an interactive shell.
        candidates.push(
          path.join(home, ".local", "bin", "agy"),
          path.join(home, ".antigravity", "bin", "agy"),
          "/usr/local/bin/agy",
          "/usr/bin/agy",
        );
        if (platform === "darwin") candidates.push("/opt/homebrew/bin/agy");
      }
      for (const candidate of new Set(candidates)) {
        if (await isExecutable(candidate)) return candidate;
      }
      return null;
    },
    async runCliUsage(signal) {
      if (signal.aborted) {
        throw new UsageError("Antigravity CLI execution timed out.");
      }
      const binary = await this.locateBinary();
      if (!binary) {
        throw new ProbeError("Antigravity binary not found. Install agy to view usage.");
      }
      const args = ["-p", "/usage", "--output-format", "json", "--print-timeout", "10s"] as const;
      const result = await run(binary, args, signal, 12_000);
      if (result.exitCode !== 0) {
        throw new UsageError(`Antigravity CLI failed (exit code ${result.exitCode}).`);
      }
      return result.stdout;
    },
    async readVersion(signal) {
      const binary = await this.locateBinary();
      if (!binary) throw new ProbeError("Cannot find agy. Install Antigravity CLI to read its quota.");
      const result = await run(binary, ["--version"], signal);
      const version = result.stdout.trim();
      if (result.exitCode !== 0 || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(version)) {
        throw new ProbeError("Cannot read the Antigravity CLI version.");
      }
      return version;
    },
    async refreshLogin(signal) {
      try {
        const binary = await this.locateBinary();
        if (!binary) throw new ProbeError("Cannot find agy.");
        // 让 CLI 自己续期和保存凭据，不直接兑换 refresh token，也不启动聊天。
        const result = await run(binary, ["models"], signal, 8_000);
        if (result.exitCode !== 0) throw new ProbeError("agy models failed.");
      } catch {
        throw new ProbeError("Antigravity login renewal failed. Sign in with agy, then refresh usage.");
      }
    },
    async readCredential(signal) {
      if (signal?.aborted) {
        throw new ProbeError("Antigravity credential lookup timed out.");
      }
      let result: CommandResult;
      if (windows) {
        // 定位 Windows 自带的读取器，不依赖 pwsh 或 PATH。
        const powershell = path.join(
          env.SystemRoot ?? env.WINDIR ?? "C:\\Windows",
          "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
        );
        result = await run(powershell, [
          "-NoProfile", "-NonInteractive", "-EncodedCommand",
          Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64"),
        ], signal);
      } else if (platform === "darwin") {
        result = await run("/usr/bin/security", [
          "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w",
        ], signal);
        if (result.exitCode === 44) return null; // errSecItemNotFound
      } else if (platform === "linux") {
        // Requires libsecret's secret-tool and an unlocked Secret Service session.
        result = await run("secret-tool", ["lookup", "service", "gemini", "username", "antigravity"], signal);
        if (result.exitCode === 1 && !result.hasDiagnostic) return null;
      } else {
        throw new ProbeError("Antigravity usage supports Windows, macOS and Linux keyrings only.");
      }
      if (result.exitCode !== 0) {
        throw new ProbeError("Cannot read the Antigravity keyring item. Check permissions and unlock the OS keyring.");
      }
      const raw = result.stdout.trim();
      return raw === "" ? null : parseStoredCredential(raw);
    },
  };
}
