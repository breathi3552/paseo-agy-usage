import { execCommand } from "@getpaseo/plugin/server";
import { constants } from "node:fs";
import { access, readFile as defaultReadFile, stat } from "node:fs/promises";
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
  env?: NodeJS.ProcessEnv,
) => Promise<CommandResult>;

function exitCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  return typeof error.code === "number" ? error.code : null;
}

const runCommand: CommandRunner = async (file, args, signal, timeoutMs = 3_500, env) => {
  try {
    const { stdout } = await execCommand(file, [...args], {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 128 * 1024,
      shell: false,
      signal,
      ...(env ? { env } : {}),
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    if (signal.aborted) throw new ProbeError("Antigravity credential lookup timed out.");
    const code = exitCode(error);
    if (code !== null) {
      const hasDiagnostic = typeof error === "object" && error !== null && "stderr" in error
        && typeof error.stderr === "string" && error.stderr.trim() !== "";
      return { stdout: "", exitCode: code, hasDiagnostic };
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
  id_token_email: z.string().optional(),
  id_token: z.unknown().optional(),
  idToken: z.unknown().optional(),
});

const storedSchema = tokenSchema.extend({
  token: tokenSchema.optional(),
  auth_method: z.string().optional(),
});

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
    email: root.email || root.id_token_email || token.email || token.id_token_email || emailFromIdToken(root.id_token ?? root.idToken ?? token.id_token ?? token.idToken),
  };
}

function expandPath(
  raw: string | null | undefined,
  home: string,
  path: typeof posix | typeof win32,
): string | null {
  if (!raw) return null;
  const unquoted = raw.trim().replace(/^"|"$/g, "").trim();
  if (!unquoted) return null;
  const windows = path === win32;
  const expanded = unquoted === "~"
    ? home
    : unquoted.startsWith("~/") || (windows && unquoted.startsWith("~\\"))
      ? path.join(home, unquoted.slice(2))
      : unquoted;
  if (!path.isAbsolute(expanded)) return null;
  const normalized = path.normalize(expanded);
  return normalized.length > (windows ? 3 : 1) ? normalized.replace(/[/\\]+$/, "") : normalized;
}

export function candidateTokenPaths(
  home: string,
  env: NodeJS.ProcessEnv,
  path: typeof posix | typeof win32,
): string[] {
  const dirs: string[] = [];

  for (const raw of [env.ANTIGRAVITY_APP_DATA_DIR, env.AGY_APP_DATA_DIR]) {
    const dir = expandPath(raw, home, path);
    if (dir) dirs.push(dir);
  }

  dirs.push(path.join(home, ".gemini", "antigravity-cli"));
  dirs.push(path.join(home, ".antigravity"));

  if (path === win32) {
    const localAppData = expandPath(env.LOCALAPPDATA, home, path) ?? path.join(home, "AppData", "Local");
    dirs.push(path.join(localAppData, "antigravity"));
    dirs.push(path.join(localAppData, "agy"));
    dirs.push(path.join(localAppData, "Google", "Antigravity"));
    const appData = expandPath(env.APPDATA, home, path);
    if (appData) {
      dirs.push(path.join(appData, "antigravity"));
      dirs.push(path.join(appData, "agy"));
    }
  }

  const filenames = ["antigravity-oauth-token", "jetski-standalone-oauth-token"];
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const file of filenames) {
      const candidate = path.join(dir, file);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        paths.push(candidate);
      }
    }
  }
  return paths;
}

/**
 * systemd 服务、容器与 ssh 无会话环境下启动的宿主进程拿不到 D-Bus 会话总线，
 * secret-tool 会直接以「Cannot autolaunch D-Bus without X11 $DISPLAY」失败。
 * 登录常驻（linger）时总线就在 XDG_RUNTIME_DIR 下，可以直接推导出来。
 * 返回 null 表示无需注入（已有可用地址，或推不出运行时目录）。
 */
export function sessionBusAddress(env: NodeJS.ProcessEnv, uid: number | undefined): string | null {
  if (env.DBUS_SESSION_BUS_ADDRESS?.trim()) return null;
  const configured = env.XDG_RUNTIME_DIR?.trim();
  const runtime = configured?.startsWith("/")
    ? configured
    : uid === undefined ? null : `/run/user/${uid}`;
  if (!runtime) return null;
  return `unix:path=${posix.join(runtime, "bus")}`;
}

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  uid?: number;
  now?: () => number;
  run?: CommandRunner;
  isExecutable?: (path: string) => Promise<boolean>;
  hasSessionBusSocket?: (path: string) => Promise<boolean>;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
}

export function createNodeProbe(options: ProbeOptions = {}): AntigravityProbe {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const now = options.now ?? Date.now;
  const run = options.run ?? runCommand;
  const readFile = options.readFile ?? defaultReadFile;
  const hasSessionBusSocket = options.hasSessionBusSocket ?? (async (file: string) => {
    try {
      return (await stat(file)).isSocket();
    } catch {
      return false;
    }
  });
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

  /**
   * 为需要访问 keyring 的子进程（secret-tool、`agy models` 续期）补全环境变量。
   * 无需注入时返回 undefined，保持原有的环境继承行为。
   */
  async function sessionBusChildEnv(): Promise<NodeJS.ProcessEnv | undefined> {
    if (platform !== "linux") return undefined;
    const address = sessionBusAddress(env, uid);
    if (!address) return undefined;
    const socket = address.slice("unix:path=".length);
    if (!(await hasSessionBusSocket(socket))) return undefined;
    const extra: NodeJS.ProcessEnv = { DBUS_SESSION_BUS_ADDRESS: address };
    if (!env.XDG_RUNTIME_DIR?.trim()) extra.XDG_RUNTIME_DIR = posix.dirname(socket);
    // env 是覆盖式传参，必须带上完整环境，同时保留 options.env 注入的覆盖项。
    return { ...process.env, ...env, ...extra };
  }

  return {
    store,
    locator: `${platform}:${home}:gemini:antigravity`,
    async locateBinary() {
      const expandBinaryCandidates = (target: string): string[] => {
        if (windows) {
          const direct = path.extname(target) !== "" ? [target] : [`${target}.exe`, `${target}.cmd`, target];
          return [...direct, path.join(target, "agy.exe"), path.join(target, "agy.cmd")];
        }
        return [target, path.join(target, "agy")];
      };

      const testTarget = async (target: string): Promise<string | null> => {
        for (const candidate of expandBinaryCandidates(target)) {
          if (await isExecutable(candidate)) return candidate;
        }
        return null;
      };

      // 优先级 1（显式环境变量）
      for (const raw of [env.ANTIGRAVITY_CLI_PATH, env.AGY_PATH]) {
        const target = expandPath(raw, home, path);
        if (target) {
          const found = await testTarget(target);
          if (found) return found;
        }
      }

      // 优先级 2（Paseo 宿主配置，可选）
      try {
        const paseoHome = expandPath(env.PASEO_HOME, home, path) ?? path.join(home, ".paseo");
        const configPath = path.join(paseoHome, "config.json");
        const config = JSON.parse(await readFile(configPath, "utf8"));
        const command = config?.agents?.providers?.antigravity?.command?.[0];
        if (typeof command === "string") {
          const target = expandPath(command, home, path);
          if (target) {
            const found = await testTarget(target);
            if (found) return found;
          }
        }
      } catch {
        // config 不存在、无法读取或非合法 JSON 时忽略
      }

      // 优先级 3（系统安装器默认路径 + PATH 遍历）
      const searchPath = env.PATH ?? env.Path ?? "";
      const pathDirs = searchPath
        .split(path.delimiter)
        .map((entry) => expandPath(entry, home, path))
        .filter((d): d is string => d !== null);

      const candidateDirs: string[] = windows
        ? [
            ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, "agy", "bin")] : []),
            path.join(home, "AppData", "Local", "agy", "bin"),
            path.join(home, ".antigravity", "bin"),
            path.join(home, ".local", "bin"),
            ...pathDirs,
          ]
        : [
            ...pathDirs,
            path.join(home, ".local", "bin"),
            path.join(home, ".antigravity", "bin"),
            ...(platform === "darwin" ? ["/opt/homebrew/bin"] : []),
            "/usr/local/bin",
            "/usr/bin",
          ];

      const tested = new Set<string>();
      for (const dir of candidateDirs) {
        const binaryCandidates = windows
          ? [path.join(dir, "agy.exe"), path.join(dir, "agy.cmd")]
          : [path.join(dir, "agy")];
        for (const candidate of binaryCandidates) {
          if (tested.has(candidate)) continue;
          tested.add(candidate);
          if (await isExecutable(candidate)) return candidate;
        }
      }

      return null;
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
        // 续期要读写 keyring，子进程同样需要会话总线，否则新 token 存不回去。
        const result = await run(binary, ["models"], signal, 8_000, await sessionBusChildEnv());
        if (result.exitCode !== 0) throw new ProbeError("agy models failed.");
      } catch {
        throw new ProbeError("Antigravity login renewal failed. Sign in with agy, then refresh usage.");
      }
    },
    async readCredential(signal) {
      if (!windows && platform !== "darwin" && platform !== "linux") {
        throw new ProbeError("Antigravity usage supports Windows, macOS and Linux keyrings only.");
      }

      const readTokenFromFile = async (): Promise<StoredCredential | null> => {
        for (const candidate of candidateTokenPaths(home, env, path)) {
          if (signal.aborted) throw new ProbeError("Antigravity credential lookup timed out.");
          let raw: string;
          try {
            raw = await readFile(candidate, "utf8");
          } catch {
            // File not found or unreadable, continue to next candidate
            continue;
          }
          if (raw.trim() !== "") {
            return parseStoredCredential(raw);
          }
        }
        return null;
      };

      let result: CommandResult | null = null;
      let keyringError: unknown = null;
      try {
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
          if (result.exitCode === 44) result = { stdout: "", exitCode: 0 }; // errSecItemNotFound
        } else {
          // Requires libsecret's secret-tool and an unlocked Secret Service session.
          // 宿主进程没有会话总线时（systemd 服务、容器）先补上推导出的标准地址。
          result = await run(
            "secret-tool",
            ["lookup", "service", "gemini", "username", "antigravity"],
            signal,
            undefined,
            await sessionBusChildEnv(),
          );
          if (result.exitCode === 1 && !result.hasDiagnostic) result = { stdout: "", exitCode: 0 };
        }
      } catch (err) {
        keyringError = err;
      }

      let keyringCredential: StoredCredential | null = null;
      if (result && result.exitCode === 0 && result.stdout.trim() !== "") {
        keyringCredential = parseStoredCredential(result.stdout.trim());
        if (keyringCredential.expiresAtMs === null || keyringCredential.expiresAtMs > now()) {
          return keyringCredential;
        }
      }

      if (keyringCredential) {
        try {
          const fileCredential = await readTokenFromFile();
          if (
            fileCredential?.accessToken
            && (fileCredential.expiresAtMs === null || fileCredential.expiresAtMs > keyringCredential.expiresAtMs!)
          ) {
            return fileCredential;
          }
        } catch (err) {
          if (signal.aborted && err instanceof ProbeError) throw err;
        }
        return keyringCredential;
      }

      // 降级回退：读取 CLI 落盘的文件型凭据（用于无 D-Bus 会话、容器、后台守护进程或 Keyring 超时降级场景）
      const fileCredential = await readTokenFromFile();
      if (fileCredential) {
        return fileCredential;
      }

      if (keyringError) {
        if (keyringError instanceof ProbeError) throw keyringError;
        throw new ProbeError("Cannot read the Antigravity keyring item. Check permissions and unlock the OS keyring.");
      }

      if (result && result.exitCode !== 0) {
        throw new ProbeError("Cannot read the Antigravity keyring item. Check permissions and unlock the OS keyring.");
      }

      return null;
    },
  };
}
