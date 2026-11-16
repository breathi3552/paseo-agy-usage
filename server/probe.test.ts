import assert from "node:assert/strict";
import { posix } from "node:path";
import { test } from "node:test";
import { candidateTokenPaths, createNodeProbe, parseStoredCredential, sessionBusAddress } from "./probe.js";

test("优先级 1: ANTIGRAVITY_CLI_PATH 命中指定文件", async () => {
  const target = "/custom/tools/agy";
  const probe = createNodeProbe({
    platform: "linux",
    env: { ANTIGRAVITY_CLI_PATH: target },
    home: "/home/test",
    isExecutable: async (p) => p === target,
  });
  assert.equal(await probe.locateBinary(), target);
});

test("优先级 1: AGY_PATH 支持包含引号与波浪号 ~ 路径展开", async () => {
  const probe = createNodeProbe({
    platform: "darwin",
    env: { AGY_PATH: '"~/custom/bin/agy"' },
    home: "/Users/test",
    isExecutable: async (p) => p === "/Users/test/custom/bin/agy",
  });
  assert.equal(await probe.locateBinary(), "/Users/test/custom/bin/agy");
});

test("优先级 1: 环境变量填目录时自动探测该目录下的二进制", async () => {
  const probe = createNodeProbe({
    platform: "win32",
    env: { AGY_PATH: "C:\\CustomDir" },
    home: "C:\\Users\\test",
    isExecutable: async (p) => p === "C:\\CustomDir\\agy.exe",
  });
  assert.equal(await probe.locateBinary(), "C:\\CustomDir\\agy.exe");
});

test("优先级 1: Windows 下填无扩展名目标依次尝试 .exe 与 .cmd", async () => {
  const probeCmd = createNodeProbe({
    platform: "win32",
    env: { AGY_PATH: "D:\\tools\\agy" },
    home: "C:\\Users\\test",
    isExecutable: async (p) => p === "D:\\tools\\agy.cmd",
  });
  assert.equal(await probeCmd.locateBinary(), "D:\\tools\\agy.cmd");
});

test("优先级 1: 拒绝相对路径并降级至后续探测", async () => {
  const fallback = "C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe";
  const probe = createNodeProbe({
    platform: "win32",
    env: {
      ANTIGRAVITY_CLI_PATH: "./relative/agy.exe",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
    },
    home: "C:\\Users\\test",
    isExecutable: async (p) => p === fallback,
  });
  assert.equal(await probe.locateBinary(), fallback);
});

test("优先级 2: 读取 Paseo config.json 中的 agents.providers.antigravity.command[0]", async () => {
  const customBin = "D:\\PaseoManaged\\bin\\agy.exe";
  const mockConfig = JSON.stringify({
    agents: {
      providers: {
        antigravity: {
          command: [customBin, "--port", "1234"],
        },
      },
    },
  });

  const probe = createNodeProbe({
    platform: "win32",
    env: { PASEO_HOME: "C:\\Users\\test\\.custom-paseo" },
    home: "C:\\Users\\test",
    readFile: async (file) => {
      if (file === "C:\\Users\\test\\.custom-paseo\\config.json") return mockConfig;
      throw new Error("File not found");
    },
    isExecutable: async (p) => p === customBin,
  });
  assert.equal(await probe.locateBinary(), customBin);
});

test("优先级 2: config.json 为裸命令名或文件损坏时安全忽略", async () => {
  const fallback = "/usr/local/bin/agy";
  const probe = createNodeProbe({
    platform: "linux",
    env: { PATH: "" },
    home: "/home/test",
    readFile: async () => JSON.stringify({
      agents: { providers: { antigravity: { command: ["agy"] } } },
    }),
    isExecutable: async (p) => p === fallback,
  });
  assert.equal(await probe.locateBinary(), fallback);
});

test("优先级 3 Windows: LOCALAPPDATA 缺失时通过 home AppData Local 兜底", async () => {
  const fallback = "C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe";
  const probe = createNodeProbe({
    platform: "win32",
    env: { PATH: "" },
    home: "C:\\Users\\test",
    isExecutable: async (p) => p === fallback,
  });
  assert.equal(await probe.locateBinary(), fallback);
});

test("优先级 3 Windows: 命中 ~/.antigravity/bin 下的 agy.cmd", async () => {
  const target = "C:\\Users\\test\\.antigravity\\bin\\agy.cmd";
  const probe = createNodeProbe({
    platform: "win32",
    env: { PATH: "" },
    home: "C:\\Users\\test",
    isExecutable: async (p) => p === target,
  });
  assert.equal(await probe.locateBinary(), target);
});

test("优先级 3 Windows: 遍历 PATH 并命中 agy.cmd", async () => {
  const probe = createNodeProbe({
    platform: "win32",
    env: { PATH: 'C:\\Windows;\"C:\\My Custom Tools\"' },
    home: "C:\\Users\\test",
    isExecutable: async (p) => p === "C:\\My Custom Tools\\agy.cmd",
  });
  assert.equal(await probe.locateBinary(), "C:\\My Custom Tools\\agy.cmd");
});

test("优先级 3 macOS: PATH 支持 ~/ 展开并优先于默认路径", async () => {
  const userBin = "/Users/test/custom-bin/agy";
  const brewBin = "/opt/homebrew/bin/agy";
  const probe = createNodeProbe({
    platform: "darwin",
    env: { PATH: "~/custom-bin:/usr/bin" },
    home: "/Users/test",
    isExecutable: async (p) => p === userBin || p === brewBin,
  });
  assert.equal(await probe.locateBinary(), userBin);
});

test("优先级 3 Linux: 不探测 macOS 特有的 /opt/homebrew/bin", async () => {
  const probe = createNodeProbe({
    platform: "linux",
    env: { PATH: "" },
    home: "/home/test",
    isExecutable: async (p) => p === "/opt/homebrew/bin/agy",
  });
  assert.equal(await probe.locateBinary(), null);
});

test("candidateTokenPaths: 覆盖标准目录及 ANTIGRAVITY_APP_DATA_DIR", () => {
  const paths = candidateTokenPaths("/home/user", { ANTIGRAVITY_APP_DATA_DIR: "/custom/data" }, posix);
  assert.ok(paths.includes("/custom/data/antigravity-oauth-token"));
  assert.ok(paths.includes("/home/user/.gemini/antigravity-cli/antigravity-oauth-token"));
  assert.ok(paths.includes("/home/user/.antigravity/antigravity-oauth-token"));
});

test("parseStoredCredential: 支持 id_token_email 与嵌套 token 结构", () => {
  const raw = JSON.stringify({
    token: {
      access_token: "test-token",
      expiry: "2026-11-15T15:41:04.541924648+08:00",
      refresh_token: "test-refresh",
    },
    auth_method: "consumer",
    id_token_email: "user@example.com",
  });
  const cred = parseStoredCredential(raw);
  assert.equal(cred.accessToken, "test-token");
  assert.equal(cred.email, "user@example.com");
  assert.ok(cred.expiresAtMs !== null);
});

test("Linux readCredential: 当 secret-tool 失败时降级回退到本地 token 文件", async () => {
  const tokenFile = "/home/test/.gemini/antigravity-cli/antigravity-oauth-token";
  const rawToken = JSON.stringify({
    token: { access_token: "file-access-token", expiry: "2030-01-01T00:00:00Z" },
    id_token_email: "fileuser@example.com",
  });
  const probe = createNodeProbe({
    platform: "linux",
    home: "/home/test",
    run: async () => {
      // 模拟无 D-Bus 会话时 secret-tool 抛错且含有 stderr 诊断
      const err = new Error("Command failed");
      (err as unknown as { code: number; stderr: string }).code = 1;
      (err as unknown as { code: number; stderr: string }).stderr = "secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY";
      throw err;
    },
    readFile: async (file) => {
      if (file === tokenFile) return rawToken;
      throw new Error("ENOENT");
    },
  });
  const cred = await probe.readCredential(new AbortController().signal);
  assert.ok(cred);
  assert.equal(cred.accessToken, "file-access-token");
  assert.equal(cred.email, "fileuser@example.com");
});

test("sessionBusAddress: 已有地址时不覆盖，否则优先 XDG_RUNTIME_DIR 再回落 /run/user/<uid>", () => {
  assert.equal(sessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus" }, 1000), null);
  assert.equal(sessionBusAddress({ DBUS_SESSION_BUS_ADDRESS: "  " }, 1000), "unix:path=/run/user/1000/bus");
  assert.equal(sessionBusAddress({ XDG_RUNTIME_DIR: "/tmp/runtime" }, 1000), "unix:path=/tmp/runtime/bus");
  assert.equal(sessionBusAddress({}, 1000), "unix:path=/run/user/1000/bus");
  assert.equal(sessionBusAddress({}, undefined), null);
});

const keyringSecret = JSON.stringify({
  token: { access_token: "keyring-access-token", expiry: "2030-01-01T00:00:00Z" },
  id_token_email: "keyring@example.com",
});

test("Linux readCredential: 宿主进程没有会话总线时注入推导出的 DBUS 地址", async () => {
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const probe = createNodeProbe({
    platform: "linux",
    env: { PATH: "/usr/bin" },
    home: "/home/test",
    uid: 1000,
    hasSessionBusSocket: async (p) => p === "/run/user/1000/bus",
    run: async (_file, _args, _signal, _timeout, env) => {
      seenEnv = env;
      return { stdout: keyringSecret, exitCode: 0 };
    },
  });
  const cred = await probe.readCredential(new AbortController().signal);
  assert.equal(cred?.accessToken, "keyring-access-token");
  assert.equal(seenEnv?.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(seenEnv?.XDG_RUNTIME_DIR, "/run/user/1000");
  // 覆盖式传参必须继承宿主完整环境，只补这两个变量；探针的 env 只用于路径探测。
  assert.equal(seenEnv?.PATH, process.env.PATH);
});

test("Linux readCredential: 总线 socket 不存在时保持原环境，不误注入", async () => {
  let seenEnv: NodeJS.ProcessEnv | undefined = { STALE: "1" };
  const probe = createNodeProbe({
    platform: "linux",
    env: {},
    home: "/home/test",
    uid: 1000,
    hasSessionBusSocket: async () => false,
    run: async (_file, _args, _signal, _timeout, env) => {
      seenEnv = env;
      return { stdout: keyringSecret, exitCode: 0 };
    },
  });
  assert.ok(await probe.readCredential(new AbortController().signal));
  assert.equal(seenEnv, undefined);
});

test("Linux readCredential: 已配置 DBUS_SESSION_BUS_ADDRESS 时原样透传", async () => {
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const probe = createNodeProbe({
    platform: "linux",
    env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/custom/bus" },
    home: "/home/test",
    uid: 1000,
    hasSessionBusSocket: async () => true,
    run: async (_file, _args, _signal, _timeout, env) => {
      seenEnv = env;
      return { stdout: keyringSecret, exitCode: 0 };
    },
  });
  assert.ok(await probe.readCredential(new AbortController().signal));
  assert.equal(seenEnv, undefined);
});
