import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeProbe, type CommandResult } from "./probe.js";
import { createUsageHandlers } from "./usage.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const BINARY = "C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe";
const INPUT = { store: "windows-credential-manager" } as const;
const QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const PLAN_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const quota = (buckets: unknown[]) => ({ groups: [{ buckets }] });
const QUOTA = quota([
  { bucketId: "3p-weekly", remainingFraction: 0 },
  { bucketId: "3p-5h", remainingFraction: 0.1 },
  { bucketId: "gemini-weekly", remainingFraction: 0.25, resetTime: "2030-01-08T00:00:00Z" },
  { bucketId: "gemini-5h", remainingFraction: 1 },
]);

function login(email = "test@example.com", accessToken = "test-access", expiry = NOW + 3_600_000) {
  const claims = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return JSON.stringify({
    token: { access_token: accessToken, expiry },
    id_token: `header.${claims}.signature`,
  });
}

const transport: typeof fetch = async (url, options) => {
  if (new Headers(options?.headers).get("authorization") !== "Bearer test-access") return json({}, 401);
  if (new Headers(options?.headers).get("user-agent") !== "antigravity/cli/1.4.2") return json(quota([]));
  if (String(url) === QUOTA_URL) return json(QUOTA);
  if (String(url) === PLAN_URL) return json({ paidTier: { id: "g1-pro-tier" }, currentTier: { id: "free-tier" } });
  throw new Error("Unexpected service endpoint");
};

// Keep the product path real; replace only filesystem, OS keyring and HTTP I/O.
function usage(options: {
  cliInstalled?: boolean;
  readStore?: () => CommandResult;
  renewLogin?: () => CommandResult;
  fetchApi?: typeof fetch;
} = {}) {
  return createUsageHandlers({
    probe: createNodeProbe({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      home: "C:\\Users\\test",
      isExecutable: async (path) => options.cliInstalled !== false && path === BINARY,
      run: async (file, args) => file === BINARY
        ? args[0] === "models"
          ? options.renewLogin?.() ?? { stdout: "", exitCode: 0 }
          : { stdout: "1.4.2\n", exitCode: 0 }
        : options.readStore?.() ?? { stdout: login(), exitCode: 0 },
    }),
    fetchApi: options.fetchApi ?? transport,
    now: () => NOW,
  });
}

test("a signed-in account produces the email footer, plan badge and four quota windows", async () => {
  const api = usage();
  const [account] = await api.discover({ kind: "global" });
  assert.ok(account);
  assert.equal(account.label, "test@example.com");
  assert.deepEqual(account.input, INPUT);

  const report = await api.fetch(account.input);
  assert.ok(report.status === "available");
  assert.equal(report.planLabel, "Google AI Pro");
  assert.deepEqual(report.windows.map(({ id, remainingPct }) => [id, remainingPct]), [
    ["gemini-5h", 100], ["gemini-weekly", 25], ["3p-5h", 10], ["3p-weekly", 0],
  ]);
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.resetsAt, "2030-01-08T00:00:00.000Z");
  assert.deepEqual(report.details, []); // No duplicate Plan or Account rows.
});

test("a separately metered Gemini 4 Argon pool adds its weekly window", async () => {
  const withArgon = quota([
    ...QUOTA.groups.flatMap(({ buckets }) => buckets),
    { bucketId: "gemini-argon-wtu-weekly", remainingFraction: 0.75, resetTime: "2030-01-08T00:00:00Z" },
  ]);
  const report = await usage({ fetchApi: async (url) => json(String(url) === PLAN_URL
    ? { paidTier: { id: "g1-pro-tier" } }
    : withArgon) }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.deepEqual(report.windows.map(({ id, remainingPct }) => [id, remainingPct]), [
    ["gemini-5h", 100], ["gemini-weekly", 25], ["3p-5h", 10], ["3p-weekly", 0], ["gemini-argon-wtu-weekly", 75],
  ]);
  assert.equal(report.windows.at(-1)?.label, "Gemini 4 Argon · Weekly");
  assert.deepEqual(report.details, []);
});

test("Windows 在没有 pwsh 和 PowerShell PATH 时仍能读取登录并获取额度", async () => {
  const executables: Record<string, string> = {
    [BINARY]: "1.4.2\n",
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe": login(),
  };
  const api = createUsageHandlers({
    probe: createNodeProbe({
      platform: "win32",
      env: { SystemRoot: "D:\\Windows", LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local", PATH: "" },
      home: "C:\\Users\\test",
      isExecutable: async (path) => path === BINARY,
      run: async (file) => {
        const stdout = executables[file];
        if (stdout === undefined) throw new Error("Command not found");
        return { stdout, exitCode: 0 };
      },
    }),
    fetchApi: transport,
    now: () => NOW,
  });
  const [account] = await api.discover({ kind: "global" });
  assert.equal(account?.label, "test@example.com");
  const report = await api.fetch(account!.input);
  assert.ok(report.status === "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, 25);
});

test("discovery shows no account without a CLI/login and never assigns the global login to a session", async () => {
  assert.deepEqual(await usage({ cliInstalled: false }).discover({ kind: "global" }), []);
  assert.deepEqual(await usage({ readStore: () => ({ stdout: "", exitCode: 0 }) }).discover({ kind: "global" }), []);
  assert.deepEqual(await usage().discover({ kind: "session", provider: "antigravity", env: {} }), []);
});

test("free-tier cards explain the plan while omitted quotas remain unknown", async () => {
  const report = await usage({ fetchApi: async (url) => json(String(url) === PLAN_URL
    ? { currentTier: { id: "free-tier" } }
    : quota([{ bucketId: "gemini-weekly", remainingFraction: 0.5 }])) }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.equal(report.planLabel, "Free tier");
  assert.deepEqual(report.windows.map(({ remainingPct }) => remainingPct), [null, 50, null, null]);
  assert.ok(report.details?.some(({ value }) => value.includes("weekly buckets")));
});

test("expired, rejected and quota-less logins produce native unavailable diagnostics", async () => {
  const cases = [
    { stored: login("test@example.com", "test-access", NOW - 1), body: QUOTA, status: 200,
      problem: { kind: "expired", expiresAt: new Date(NOW - 1).toISOString(), refreshedBy: "agy" } },
    ...[401, 403].map((status) => ({ stored: login(), body: {}, status,
      problem: { kind: "rejected", status, refreshedBy: "agy" } })),
    { stored: login(), body: quota([]), status: 200, problem: { kind: "no_quota" } },
  ];
  for (const scenario of cases) {
    const report = await usage({
      readStore: () => ({ stdout: scenario.stored, exitCode: 0 }),
      fetchApi: async () => json(scenario.body, scenario.status),
    }).fetch(INPUT);
    assert.ok(report.status === "unavailable");
    assert.equal(report.problem.kind, scenario.problem.kind);
    if (scenario.problem.kind !== "no_quota") assert.deepEqual(report.problem, scenario.problem);
  }
});

test("expired logins are renewed by agy and quota uses the newly stored token", async () => {
  let stored = login("test@example.com", "expired-access", NOW - 1);
  const report = await usage({
    readStore: () => ({ stdout: stored, exitCode: 0 }),
    renewLogin: () => {
      stored = login();
      return { stdout: "", exitCode: 0 };
    },
  }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, 25);
});

test("quota authentication rejection renews the login before retrying with its new token", async () => {
  for (const status of [401, 403]) {
    let stored = login("test@example.com", "rejected-access");
    const report = await usage({
      readStore: () => ({ stdout: stored, exitCode: 0 }),
      renewLogin: () => {
        stored = login();
        return { stdout: "", exitCode: 0 };
      },
      fetchApi: async (url, options) =>
        new Headers(options?.headers).get("authorization") === "Bearer rejected-access"
          ? json({}, status) : transport(url, options),
    }).fetch(INPUT);
    assert.ok(report.status === "available");
    assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, 25);
  }
});

test("failed CLI renewal reports an error without leaking command output", async () => {
  const report = await usage({
    readStore: () => ({ stdout: login("test@example.com", "expired-access", NOW - 1), exitCode: 0 }),
    renewLogin: () => ({ stdout: "private-payload", exitCode: 1 }),
  }).fetch(INPUT);
  assert.ok(report.status === "error");
  assert.ok(!report.error.includes("private-payload"));
});

test("an unavailable plan label does not hide valid quota", async () => {
  const report = await usage({ fetchApi: async (url) => String(url) === PLAN_URL ? json({}, 403) : json(QUOTA) }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.equal(report.planLabel, undefined);
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, 25);
});

test("keyring and upstream failures show errors without exposing private payloads", async () => {
  const cases = [
    usage({ readStore: () => ({ stdout: "private-payload", exitCode: 1 }) }),
    usage({ fetchApi: async () => { throw new Error("private-payload"); } }),
    usage({ fetchApi: async () => new Response("private-payload") }),
    usage({ fetchApi: async () => json({ error: "private-payload" }, 503) }),
  ];
  for (const api of cases) {
    const report = await api.fetch(INPUT);
    assert.ok(report.status === "error");
    assert.ok(!report.error.includes("private-payload"));
  }
});

test("switching the CLI login updates both the discovered account and fetched quota", async () => {
  let stored = login();
  const api = usage({
    readStore: () => ({ stdout: stored, exitCode: 0 }),
    fetchApi: async (url, options) => {
      const nextLogin = new Headers(options?.headers).get("authorization") === "Bearer next-access";
      return nextLogin && String(url) === QUOTA_URL
        ? json(quota([{ bucketId: "gemini-weekly", remainingFraction: 0.8 }])) : transport(url, options);
    },
  });
  const [original] = await api.discover({ kind: "global" });
  assert.ok(original);
  const before = await api.fetch(original.input);
  assert.ok(before.status === "available");
  assert.equal(before.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, 25);
  stored = login("next@example.com", "next-access");
  const [current] = await api.discover({ kind: "global" });
  assert.equal(current?.label, "next@example.com");
  const report = await api.fetch(original.input);
  assert.ok(report.status === "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, 80);
});
