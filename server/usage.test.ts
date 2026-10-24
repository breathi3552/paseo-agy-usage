import assert from "node:assert/strict";
import { test } from "node:test";
import { createNodeProbe, ProbeError, type CommandResult } from "./probe.js";
import { createUsageHandlers, request } from "./usage.js";
import { classifyWindow, mapCliUsageOutput, mapQuotaSummary } from "./quota.js";
import { UsageError } from "./errors.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const BINARY = "C:\\Users\\test\\AppData\\Local\\agy\\bin\\agy.exe";
const INPUT = { store: "windows-credential-manager" } as const;
const DAILY_QUOTA_URL = "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const PROD_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary";
const PLAN_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const quota = (buckets: unknown[]) => ({ groups: [{ buckets }] });
const QUOTA = quota([
  { bucketId: "3p-weekly", remainingFraction: 0 },
  { bucketId: "3p-5h", remainingFraction: 0.1 },
  { bucketId: "gemini-weekly", remainingFraction: 0.25, resetTime: "2030-01-08T00:00:00Z" },
  { bucketId: "gemini-5h", remainingFraction: 1 },
]);

const CLI_JSON_QUOTA = JSON.stringify({
  response: {
    groups: [
      {
        displayName: "Gemini",
        buckets: [
          { bucketId: "gemini-5h", remainingFraction: 1 },
          { bucketId: "gemini-weekly", remainingFraction: 0.25, resetTime: "2030-01-08T00:00:00Z" },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-5h", remainingFraction: 0.1 },
          { bucketId: "3p-weekly", remainingFraction: 0 },
        ],
      },
    ],
  },
});

function login(email = "test@example.com", accessToken = "test-access", expiry = NOW + 3_600_000) {
  const claims = Buffer.from(JSON.stringify({ email })).toString("base64url");
  return JSON.stringify({
    token: { access_token: accessToken, expiry },
    id_token: `header.${claims}.signature`,
  });
}

function usage(options: {
  cliInstalled?: boolean;
  readStore?: () => CommandResult;
  cliOutput?: () => CommandResult;
} = {}) {
  return createUsageHandlers({
    probe: createNodeProbe({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
      home: "C:\\Users\\test",
      isExecutable: async (path) => options.cliInstalled !== false && path === BINARY,
      run: async (_file, args) => {
        if (args.includes("/usage")) {
          return options.cliOutput?.() ?? { stdout: CLI_JSON_QUOTA, exitCode: 0 };
        }
        return options.readStore?.() ?? { stdout: login(), exitCode: 0 };
      },
    }),
    now: () => NOW,
  });
}

// ----------------------------------------------------------------------------
// Baseline Regression Tests (Paseo original specification)
// ----------------------------------------------------------------------------

test("a signed-in account produces the email footer, plan badge and four quota windows", async () => {
  const api = usage();
  const [account] = await api.discover({ kind: "global" });
  assert.ok(account);
  assert.equal(account.label, "test@example.com");
  assert.deepEqual(account.input, INPUT);

  const report = await api.fetch(account.input);
  assert.ok(report.status === "available");
  assert.deepEqual(report.windows.map(({ id, remainingPct }) => [id, remainingPct]), [
    ["gemini-5h", 100], ["gemini-weekly", 25], ["3p-5h", 10], ["3p-weekly", 0],
  ]);
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.resetsAt, "2030-01-08T00:00:00.000Z");
  assert.deepEqual(report.details, []); // No duplicate Plan or Account rows.
});

test("discovery shows no account without a CLI/login and never assigns the global login to a session", async () => {
  assert.deepEqual(await usage({ cliInstalled: false }).discover({ kind: "global" }), []);
  assert.deepEqual(await usage({ readStore: () => ({ stdout: "", exitCode: 0 }) }).discover({ kind: "global" }), []);
  assert.deepEqual(await usage().discover({ kind: "session", provider: "antigravity", env: {} }), []);
});

test("free-tier cards explain the plan while omitted quotas remain unknown", async () => {
  const partialCliQuota = JSON.stringify({
    response: {
      groups: [
        {
          displayName: "Gemini",
          buckets: [{ bucketId: "gemini-weekly", remainingFraction: 0.5 }],
        },
      ],
    },
  });
  const report = await usage({
    cliOutput: () => ({ stdout: partialCliQuota, exitCode: 0 }),
  }).fetch(INPUT);
  assert.ok(report.status === "available");
  assert.deepEqual(report.windows.map(({ remainingPct }) => remainingPct), [null, 50, null, null]);
  assert.ok(report.details?.some(({ id }) => id === "missing-buckets"));
});

test("quota-less logins produce native unavailable diagnostics", async () => {
  const emptyCliQuota = JSON.stringify({ response: { groups: [] } });
  const report = await usage({
    readStore: () => ({ stdout: login(), exitCode: 0 }),
    cliOutput: () => ({ stdout: emptyCliQuota, exitCode: 0 }),
  }).fetch(INPUT);
  assert.ok(report.status === "unavailable");
  assert.equal(report.problem.kind, "no_quota");
});

test("P2.3: an expired credential timestamp in keyring does not block fetch, letting CLI refresh token", async () => {
  let cliInvoked = false;
  const expiredKeyringCredential = login("test@example.com", "stale-access", NOW - 3600_000);
  const api = usage({
    readStore: () => ({ stdout: expiredKeyringCredential, exitCode: 0 }),
    cliOutput: () => {
      cliInvoked = true;
      return { stdout: CLI_JSON_QUOTA, exitCode: 0 };
    },
  });

  // Account identity is preserved
  const [account] = await api.discover({ kind: "global" });
  assert.equal(account?.label, "test@example.com");

  // Fetch delegates to CLI without early expiration block
  const report = await api.fetch(INPUT);
  assert.equal(cliInvoked, true, "CLI must be invoked even when stored credential has expired timestamp");
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 100);
});

test("an unavailable plan label does not hide valid quota", async () => {
  const report = await usage().fetch(INPUT);
  assert.ok(report.status === "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, 100);
});

test("keyring and upstream failures show errors without exposing private payloads", async () => {
  const reportKeyring = await usage({ readStore: () => ({ stdout: "untrusted secret", exitCode: 1 }) }).fetch(INPUT);
  assert.equal(reportKeyring.status, "error");
  assert.ok(!reportKeyring.error.includes("untrusted"));

  const reportCli = await usage({ cliOutput: () => ({ stdout: "secret token output", exitCode: 1 }) }).fetch(INPUT);
  assert.equal(reportCli.status, "error");
  assert.ok(!reportCli.error.includes("secret"));
});

test("switching the CLI login updates both the discovered account and fetched quota", async () => {
  let activeEmail = "first@example.com";
  let activeRemaining = 1.0;
  const api = usage({
    readStore: () => ({ stdout: login(activeEmail), exitCode: 0 }),
    cliOutput: () => ({
      stdout: JSON.stringify({
        response: {
          groups: [
            {
              displayName: "Gemini",
              buckets: [{ bucketId: "gemini-5h", remainingFraction: activeRemaining }],
            },
          ],
        },
      }),
      exitCode: 0,
    }),
  });

  const [firstAccount] = await api.discover({ kind: "global" });
  assert.equal(firstAccount?.label, "first@example.com");
  const report1 = await api.fetch(INPUT);
  assert.ok(report1.status === "available");
  assert.equal(report1.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 100);

  activeEmail = "second@example.com";
  activeRemaining = 0.5;
  const [secondAccount] = await api.discover({ kind: "global" });
  assert.equal(secondAccount?.label, "second@example.com");
  const report2 = await api.fetch(INPUT);
  assert.ok(report2.status === "available");
  assert.equal(report2.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 50);
});

// ----------------------------------------------------------------------------
// P2.2 Native CLI Adapter Tests
// ----------------------------------------------------------------------------

test("P2.2: CLI JSON envelope with structured response object maps all 4 windows accurately", async () => {
  const cliOutput = JSON.stringify({
    response: {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            { bucketId: "5-hour", remainingFraction: 1.0 },
            { bucketId: "weekly", remainingFraction: 0.85, resetTime: "2030-01-08T00:00:00Z" },
          ],
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            { bucketId: "3p-5h", remainingFraction: 0.9 },
            { bucketId: "3p-weekly", remainingFraction: 0.7, resetTime: "2030-01-08T00:00:00Z" },
          ],
        },
      ],
    },
  });

  const report = await usage({ cliOutput: () => ({ stdout: cliOutput, exitCode: 0 }) }).fetch(INPUT);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 100);
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.remainingPct, 85);
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.remainingPct, 90);
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.remainingPct, 70);
});

test("P2.2: CLI JSON envelope with array of records maps remaining percent and reset time", async () => {
  const cliOutput = JSON.stringify({
    response: [
      { group: "Gemini", window: "5-hour", remainingPct: 100, resetsAt: "2030-01-01T05:00:00Z" },
      { group: "Gemini", window: "Weekly", remainingPct: 80, resetsAt: "2030-01-08T00:00:00Z" },
      { group: "Claude and GPT", window: "5-hour", remainingPct: 95, resetsAt: "2030-01-01T05:00:00Z" },
      { group: "Claude and GPT", window: "Weekly", remainingPct: 60, resetsAt: "2030-01-08T00:00:00Z" },
    ],
  });

  const report = await usage({ cliOutput: () => ({ stdout: cliOutput, exitCode: 0 }) }).fetch(INPUT);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 100);
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.remainingPct, 80);
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.remainingPct, 95);
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.remainingPct, 60);
});

test("P2.2: CLI JSON envelope with stringified text / TSV format maps all 4 windows", async () => {
  const cliOutput = JSON.stringify({
    response: [
      "Gemini\t5-hour\t100%\t2030-01-01T05:00:00Z",
      "Gemini\tWeekly\t92%\t2030-01-08T00:00:00Z",
      "Claude and GPT\t5-hour\t88%\t2030-01-01T05:00:00Z",
      "Claude and GPT\tWeekly\t75%\t2030-01-08T00:00:00Z",
    ].join("\n"),
  });

  const report = await usage({ cliOutput: () => ({ stdout: cliOutput, exitCode: 0 }) }).fetch(INPUT);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 100);
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.remainingPct, 92);
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.remainingPct, 88);
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.remainingPct, 75);
});

test("P2.2: CLI JSON envelope with human-readable output maps all 4 windows", async () => {
  const cliOutput = JSON.stringify({
    response: [
      "Gemini 5-hour limit: 100% remaining (resets in 4h 12m)",
      "Gemini Weekly limit: 90% remaining (resets Oct 27, 21:00)",
      "Claude and GPT 5-hour limit: 85% remaining (resets in 4h 59m)",
      "Claude and GPT Weekly limit: 70% remaining (resets Oct 27, 21:00)",
    ].join("\n"),
  });

  const report = mapCliUsageOutput(cliOutput);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 100);
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.remainingPct, 90);
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.remainingPct, 85);
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.remainingPct, 70);
});

test("P2.2: CLI partial quota missing keeps omitted Gemini or 3P buckets as null and reports missing-buckets details", async () => {
  const cliOutput = JSON.stringify({
    response: [
      { group: "Claude and GPT", window: "5-hour", remainingPct: 95 },
      { group: "Claude and GPT", window: "Weekly", remainingPct: 60 },
    ],
  });

  const report = await usage({ cliOutput: () => ({ stdout: cliOutput, exitCode: 0 }) }).fetch(INPUT);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, null);
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.remainingPct, null);
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.remainingPct, 95);
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.remainingPct, 60);
  assert.ok(report.details?.some((d) => d.id === "missing-buckets"));
});

test("P2.2: CLI non-zero exit code throws human-readable error without exposing raw output or credentials", async () => {
  const report = await usage({
    cliOutput: () => ({ stdout: "sensitive CLI trace with bearer token", exitCode: 127 }),
  }).fetch(INPUT);

  assert.equal(report.status, "error");
  assert.ok(report.error.includes("failed (exit code 127)"));
  assert.ok(!report.error.includes("sensitive"));
  assert.ok(!report.error.includes("bearer"));
});

test("P2.2: CLI invalid JSON output throws human-readable error without exposing raw output", async () => {
  const report = await usage({
    cliOutput: () => ({ stdout: "NOT VALID JSON: token 123", exitCode: 0 }),
  }).fetch(INPUT);

  assert.equal(report.status, "error");
  assert.ok(report.error.includes("invalid JSON"));
  assert.ok(!report.error.includes("token 123"));
});

test("P2.2: CLI execution timeout is caught and surfaced safely", async () => {
  const probe = createNodeProbe({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    home: "C:\\Users\\test",
    isExecutable: async (path) => path === BINARY,
    run: async (_file, args, signal) => {
      if (args.includes("/usage")) {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Timeout")));
        });
      }
      return { stdout: login(), exitCode: 0 };
    },
  });

  const api = createUsageHandlers({ probe, now: () => NOW });
  const report = await api.fetch(INPUT);
  assert.equal(report.status, "error");
  assert.ok(report.error.includes("timed out") || report.error.includes("failed"));
});

test("locateBinary prioritizes explicit ANTIGRAVITY_CLI_PATH or AGY_PATH environment override", async () => {
  const probedPaths: string[] = [];
  const probe = createNodeProbe({
    platform: "darwin",
    env: { ANTIGRAVITY_CLI_PATH: "/custom/bin/agy-wrapper", PATH: "/usr/bin" },
    home: "/Users/test",
    isExecutable: async (path) => {
      probedPaths.push(path);
      return path === "/custom/bin/agy-wrapper";
    },
  });

  const located = await probe.locateBinary();
  assert.equal(located, "/custom/bin/agy-wrapper");
  assert.equal(probedPaths[0], "/custom/bin/agy-wrapper");
});

test("P2.2: CLI data source does not abort on empty credential.accessToken and preserves account discovery", async () => {
  // Keychain item without immediate access_token (e.g. only refresh_token, or token managed by agy)
  const emptyAccessTokenLogin = JSON.stringify({
    token: { access_token: "", refresh_token: "stored-refresh", expiry: NOW + 3600000 },
    email: "custom-user@example.com",
  });

  let cliInvoked = false;
  const api = usage({
    readStore: () => ({ stdout: emptyAccessTokenLogin, exitCode: 0 }),
    cliOutput: () => {
      cliInvoked = true;
      return { stdout: CLI_JSON_QUOTA, exitCode: 0 };
    },
  });

  const [account] = await api.discover({ kind: "global" });
  assert.equal(account?.label, "custom-user@example.com");

  const report = await api.fetch(INPUT);
  assert.equal(cliInvoked, true, "CLI must be invoked even when access_token is empty");
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 100);
});

test("P2.2: CLI execution passes --print-timeout 10s and separates timeout diagnostics from keychain", async () => {
  let capturedArgs: readonly string[] = [];
  const probe = createNodeProbe({
    platform: "darwin",
    home: "/Users/test",
    isExecutable: async () => true,
    run: async (_file, args) => {
      if (args.includes("/usage")) {
        capturedArgs = args;
        return { stdout: CLI_JSON_QUOTA, exitCode: 0 };
      }
      return { stdout: login(), exitCode: 0 };
    },
  });

  const api = createUsageHandlers({ probe, now: () => NOW });
  const report = await api.fetch({ store: "macos-keychain" });
  assert.equal(report.status, "available");
  assert.ok(capturedArgs.includes("--print-timeout"));
  assert.ok(capturedArgs.includes("10s"));

  // Verify timeout diagnostics separation
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(async () => {
    await probe.runCliUsage(ac.signal);
  }, (err: unknown) => err instanceof UsageError && err.message.includes("Antigravity CLI execution timed out"));

  await assert.rejects(async () => {
    await probe.readCredential(ac.signal);
  }, (err: unknown) => err instanceof ProbeError && err.message.includes("Antigravity credential lookup timed out"));
});

// ----------------------------------------------------------------------------
// P1.1 HTTP Endpoint Fallback Regression Tests (Direct request verification)
// ----------------------------------------------------------------------------

test("P1.1: retrieveUserQuotaSummary prioritizes daily-cloudcode-pa endpoint aligned with AGY CLI 1.4.6", async () => {
  const calledUrls: string[] = [];
  const doc = await request(
    "retrieveUserQuotaSummary",
    "test-access",
    async (url) => {
      const u = String(url);
      calledUrls.push(u);
      if (u === DAILY_QUOTA_URL) return json(QUOTA);
      throw new Error(`Fallback endpoint called unexpectedly: ${u}`);
    },
    new AbortController().signal,
  );

  assert.ok(calledUrls.includes(DAILY_QUOTA_URL), "Must query daily-cloudcode-pa first");
  assert.ok(!calledUrls.includes(PROD_QUOTA_URL), "Must not call production quota endpoint when daily succeeds");
  assert.ok(typeof doc === "object" && doc !== null);
});

test("P1.1: loadCodeAssist strictly stays on cloudcode-pa production and never switches to daily", async () => {
  const planUrls: string[] = [];
  await request(
    "loadCodeAssist",
    "test-access",
    async (url) => {
      const u = String(url);
      planUrls.push(u);
      return json({ paidTier: { id: "g1-pro-tier" } });
    },
    new AbortController().signal,
  );

  assert.deepEqual(planUrls, [PLAN_URL], "loadCodeAssist must strictly query PLAN_BASE_URL");
});

test("P1.1: HTTP 200 with missing Gemini group keeps Gemini unknown (null) and reports missing-buckets", async () => {
  const partialPayload200 = {
    groups: [
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-5h", remainingFraction: 0.8 },
          { bucketId: "3p-weekly", remainingFraction: 0.6 },
        ],
      },
    ],
  };

  const report = mapQuotaSummary(partialPayload200, "Google AI Pro");
  assert.equal(report.status, "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, null);
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, null);
  assert.equal(report.windows.find(({ id }) => id === "3p-5h")?.remainingPct, 80);
  assert.equal(report.windows.find(({ id }) => id === "3p-weekly")?.remainingPct, 60);
  assert.ok(report.details?.some(({ id, value }) => id === "missing-buckets" && value.includes("omitted")));
});

test("P1.1: Duplicate buckets in the same group prioritize explicit IDs over aliases without array duplication", async () => {
  const duplicateBucketPayload = {
    groups: [
      {
        displayName: "Gemini",
        buckets: [
          { bucketId: "5-hour", window: "5h", remainingFraction: 0.5 },
          { bucketId: "gemini-5h", remainingFraction: 0.95 },
          { bucketId: "gemini-weekly", remainingFraction: 0.7 },
        ],
      },
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-5h", remainingFraction: 0.3 },
          { bucketId: "3p-weekly", remainingFraction: 0.1 },
        ],
      },
    ],
  };

  const report = mapQuotaSummary(duplicateBucketPayload, null);
  assert.equal(report.status, "available");
  assert.equal(report.windows.length, 4, "Must not duplicate windows array length");
  assert.equal(report.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, 95);
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, 70);
});

test("P1.1: Ambiguous group names (containing conflicting or unknown identities) are treated as unknown without cross-pollution", async () => {
  const ambiguousPayload = {
    groups: [
      {
        displayName: "Mixed Gemini & Claude Group",
        buckets: [
          { bucketId: "5-hour", remainingFraction: 0.99 },
          { bucketId: "3p-5h", remainingFraction: 0.4 },
          { bucketId: "3p-weekly", remainingFraction: 0.2 },
        ],
      },
    ],
  };

  const report = mapQuotaSummary(ambiguousPayload, null);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, null);
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, null);
  assert.equal(report.windows.find(({ id }) => id === "3p-5h")?.remainingPct, 40);
  assert.equal(report.windows.find(({ id }) => id === "3p-weekly")?.remainingPct, 20);
});

test("P1.1: Single endpoint atomicity — never stitch partial quotas across different endpoints", async () => {
  const calledUrls: string[] = [];
  const partialDailyQuota = {
    groups: [
      {
        displayName: "Claude and GPT models",
        buckets: [
          { bucketId: "3p-5h", remainingFraction: 0.85 },
          { bucketId: "3p-weekly", remainingFraction: 0.65 },
        ],
      },
    ],
  };

  const doc = await request(
    "retrieveUserQuotaSummary",
    "test-access",
    async (url) => {
      const u = String(url);
      calledUrls.push(u);
      if (u === DAILY_QUOTA_URL) return json(partialDailyQuota);
      if (u === PROD_QUOTA_URL) return json(QUOTA);
      return json({});
    },
    new AbortController().signal,
  );

  const report = mapQuotaSummary(doc, null);
  assert.equal(report.status, "available");
  assert.equal(calledUrls.length, 1, "Must query exactly one quota endpoint");
  assert.equal(calledUrls[0], DAILY_QUOTA_URL);
  assert.equal(report.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, null);
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, null);
  assert.equal(report.windows.find(({ id }) => id === "3p-5h")?.remainingPct, 85);
  assert.equal(report.windows.find(({ id }) => id === "3p-weekly")?.remainingPct, 65);
});

test("P1.1: Failure on primary daily endpoint triggers fallback to production", async () => {
  const calledUrls: string[] = [];
  const doc = await request(
    "retrieveUserQuotaSummary",
    "test-access",
    async (url) => {
      const u = String(url);
      calledUrls.push(u);
      if (u === DAILY_QUOTA_URL) return json({ error: "Daily Service Down" }, 502);
      if (u === PROD_QUOTA_URL) return json(QUOTA);
      return json({});
    },
    new AbortController().signal,
  );

  const report = mapQuotaSummary(doc, null);
  assert.equal(report.status, "available");
  assert.deepEqual(calledUrls, [DAILY_QUOTA_URL, PROD_QUOTA_URL], "Must fall back to production on 502");
  assert.deepEqual(report.windows.map(({ id, remainingPct }) => [id, remainingPct]), [
    ["gemini-5h", 100], ["gemini-weekly", 25], ["3p-5h", 10], ["3p-weekly", 0],
  ]);
});

test("P1.1: 401/403 rejection on primary endpoint immediately fails fast without attempting fallback", async () => {
  let fallbackAttempted = false;
  await assert.rejects(async () => {
    await request(
      "retrieveUserQuotaSummary",
      "test-access",
      async (url) => {
        const u = String(url);
        if (u === DAILY_QUOTA_URL) return json({ error: "Unauthorized" }, 401);
        if (u === PROD_QUOTA_URL) {
          fallbackAttempted = true;
          return json(QUOTA);
        }
        return json({});
      },
      new AbortController().signal,
    );
  }, /failed \(HTTP 401\)/);

  assert.equal(fallbackAttempted, false, "Must not attempt fallback when credentials are rejected (401)");
});

test("P1.1: Network timeout on quota request gracefully surfaces error without unhandled exception", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(async () => {
    await request(
      "retrieveUserQuotaSummary",
      "test-access",
      async () => json(QUOTA),
      ac.signal,
    );
  }, /request failed/);
});

test("P1.1: HTTP 400 and HTTP 429 fail fast on primary endpoint without attempting fallback", async () => {
  for (const status of [400, 429]) {
    let fallbackAttempted = false;
    await assert.rejects(async () => {
      await request(
        "retrieveUserQuotaSummary",
        "test-access",
        async (url) => {
          const u = String(url);
          if (u === DAILY_QUOTA_URL) return json({ error: status === 400 ? "Bad Request" : "Rate limit" }, status);
          if (u === PROD_QUOTA_URL) {
            fallbackAttempted = true;
            return json(QUOTA);
          }
          return json({});
        },
        new AbortController().signal,
      );
    });

    assert.equal(
      fallbackAttempted,
      false,
      `HTTP ${status} on primary endpoint must fail fast and not attempt fallback`,
    );
  }
});

test("P1.1: Outer group and explicit bucket ID conflict rejects misclassification", async () => {
  const conflictingDocument = {
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          { bucketId: "3p-5h", remainingFraction: 0.1 },
          { bucketId: "gemini-5h", remainingFraction: 0.9 },
        ],
      },
      {
        displayName: "Claude & GPT",
        buckets: [
          { bucketId: "gemini-weekly", remainingFraction: 0.2 },
          { bucketId: "3p-weekly", remainingFraction: 0.8 },
        ],
      },
    ],
  };

  const report = mapQuotaSummary(conflictingDocument, null);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find(({ id }) => id === "gemini-5h")?.remainingPct, 90);
  assert.equal(report.windows.find(({ id }) => id === "gemini-weekly")?.remainingPct, null);
  assert.equal(report.windows.find(({ id }) => id === "3p-5h")?.remainingPct, null);
  assert.equal(report.windows.find(({ id }) => id === "3p-weekly")?.remainingPct, 80);
  assert.ok(
    report.details?.some(
      ({ id, value }) => id === "missing-buckets" && value.includes("omitted"),
    ),
  );
});

test("P1.1: HTTP 404 and 422 fail fast without fallback, while HTTP 503 triggers fallback to production", async () => {
  for (const clientStatus of [404, 422]) {
    let fallbackAttempted = false;
    await assert.rejects(async () => {
      await request(
        "retrieveUserQuotaSummary",
        "test-access",
        async (url) => {
          const u = String(url);
          if (u === DAILY_QUOTA_URL) return json({ error: `Client Error ${clientStatus}` }, clientStatus);
          if (u === PROD_QUOTA_URL) {
            fallbackAttempted = true;
            return json(QUOTA);
          }
          return json({});
        },
        new AbortController().signal,
      );
    });

    assert.equal(
      fallbackAttempted,
      false,
      `HTTP ${clientStatus} on primary endpoint must fail fast without attempting fallback`,
    );
  }

  let fallbackAttempted503 = false;
  const doc = await request(
    "retrieveUserQuotaSummary",
    "test-access",
    async (url) => {
      const u = String(url);
      if (u === DAILY_QUOTA_URL) return json({ error: "Service Unavailable" }, 503);
      if (u === PROD_QUOTA_URL) {
        fallbackAttempted503 = true;
        return json(QUOTA);
      }
      return json({});
    },
    new AbortController().signal,
  );

  const report = mapQuotaSummary(doc, null);
  assert.equal(report.status, "available");
  assert.equal(
    fallbackAttempted503,
    true,
    "HTTP 503 on primary endpoint must trigger fallback to secondary production endpoint",
  );
});

// ----------------------------------------------------------------------------
// P4.1: Unified Window Classification and 5h TSV Variant Offline Tests
// ----------------------------------------------------------------------------

test("P4.1: classifyWindow recognizes all 5h and weekly variants while rejecting invalid windows", () => {
  const fiveHourVariants = [
    "5h",
    "5-hour",
    "5-hours",
    "5_hour",
    "5_hours",
    "5 hour",
    "5 hours",
    "Five Hour",
    "Five Hours",
    "five hour",
    "five hours",
    "Five Hour Limit Remaining",
    "five-hour",
    "five_hour",
    "5-hour session",
    "5h session",
    "5H",
    "5 HOURS",
  ];
  for (const variant of fiveHourVariants) {
    const res = classifyWindow(variant);
    assert.equal(res.is5h, true, `Variant "${variant}" must be recognized as 5h`);
    assert.equal(res.isWeekly, false, `Variant "${variant}" must not be weekly`);
  }

  const weeklyVariants = ["Weekly", "week", "7d", "7-day", "7-days", "7D", "WEEKLY"];
  for (const variant of weeklyVariants) {
    const res = classifyWindow(variant);
    assert.equal(res.isWeekly, true, `Variant "${variant}" must be recognized as weekly`);
    assert.equal(res.is5h, false, `Variant "${variant}" must not be 5h`);
  }

  const invalidVariants = [
    "Daily",
    "daily",
    "1h",
    "1-hour",
    "hourly",
    "monthly",
    "30d",
    "per-minute",
    "custom_limit",
    "Session",
    "session",
    "",
    "unknown",
  ];
  for (const variant of invalidVariants) {
    const res = classifyWindow(variant);
    assert.equal(res.is5h, false, `Invalid window "${variant}" must not be 5h`);
    assert.equal(res.isWeekly, false, `Invalid window "${variant}" must not be weekly`);
  }
});

test("P4.1: TSV with '5 hours' and '5_hour' formats maps Gemini 5h and Claude/GPT 5h accurately", async () => {
  const cliOutput = JSON.stringify({
    response: [
      "Gemini\t5 hours\t95%\t2030-01-01T05:00:00Z",
      "Gemini\tWeekly\t80%\t2030-01-08T00:00:00Z",
      "Claude and GPT models\t5 hours\t60%\t2030-01-01T05:00:00Z",
      "Claude and GPT models\tWeekly\t40%\t2030-01-08T00:00:00Z",
    ].join("\n"),
  });

  const report = mapCliUsageOutput(cliOutput);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 95);
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.resetsAt, "2030-01-01T05:00:00.000Z");
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.remainingPct, 80);
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.resetsAt, "2030-01-08T00:00:00.000Z");
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.remainingPct, 60);
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.resetsAt, "2030-01-01T05:00:00.000Z");
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.remainingPct, 40);
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.resetsAt, "2030-01-08T00:00:00.000Z");
  assert.equal(report.details?.some((d) => d.id === "missing-buckets"), false);
});

test("P4.1: TSV with all invalid / unrecognized window names produces native unavailable no_quota status", async () => {
  const cliOutput = JSON.stringify({
    response: [
      "Gemini\tDaily\t90%\t2030-01-02T00:00:00Z",
      "Gemini\thourly\t80%\t2030-01-01T01:00:00Z",
      "Claude and GPT models\tmonthly\t70%\t2030-02-01T00:00:00Z",
      "Claude and GPT models\trandom_window\t50%\t2030-01-01T00:00:00Z",
    ].join("\n"),
  });

  const report = mapCliUsageOutput(cliOutput);
  assert.equal(report.status, "unavailable");
  if (report.status === "unavailable") {
    assert.equal((report.problem as { kind: string }).kind, "no_quota");
  }
});

test("P4.1: TSV with valid Weekly but invalid 5h preserves Weekly and marks only 5h as null with missing-buckets", async () => {
  const cliOutput = JSON.stringify({
    response: [
      "Gemini\tinvalid-window\t90%\t2030-01-02T00:00:00Z",
      "Gemini\tWeekly\t75%\t2030-01-08T00:00:00Z",
      "Claude and GPT models\tunknown-window\t60%\t2030-01-02T00:00:00Z",
      "Claude and GPT models\tWeekly\t30%\t2030-01-08T00:00:00Z",
    ].join("\n"),
  });

  const report = mapCliUsageOutput(cliOutput);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, null);
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.remainingPct, 75);
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.remainingPct, null);
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.remainingPct, 30);
  assert.ok(
    report.details?.some(
      ({ id, value }) => id === "missing-buckets" && value.includes("omitted"),
    ),
  );
});

test("P4.3: TSV with real-world 'Five Hour Limit Remaining' and 'Weekly Limit Remaining' maps all 4 windows", async () => {
  const cliOutput = JSON.stringify({
    response: [
      "Gemini\tWeekly Limit Remaining\t94%\t2030-01-08T00:00:00Z",
      "Gemini\tFive Hour Limit Remaining\t100%\t2030-01-01T05:00:00Z",
      "Claude and GPT models\tWeekly Limit Remaining\t100%\t2030-01-08T00:00:00Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2030-01-01T05:00:00Z",
    ].join("\n"),
  });

  const report = mapCliUsageOutput(cliOutput);
  assert.equal(report.status, "available");
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.remainingPct, 100);
  assert.equal(report.windows.find((w) => w.id === "gemini-5h")?.resetsAt, "2030-01-01T05:00:00.000Z");
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.remainingPct, 94);
  assert.equal(report.windows.find((w) => w.id === "gemini-weekly")?.resetsAt, "2030-01-08T00:00:00.000Z");
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.remainingPct, 100);
  assert.equal(report.windows.find((w) => w.id === "3p-5h")?.resetsAt, "2030-01-01T05:00:00.000Z");
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.remainingPct, 100);
  assert.equal(report.windows.find((w) => w.id === "3p-weekly")?.resetsAt, "2030-01-08T00:00:00.000Z");
  assert.equal(report.details?.some((d) => d.id === "missing-buckets"), false);
});

