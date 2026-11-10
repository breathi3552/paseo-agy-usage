import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeProbe } from "./probe.js";

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
