import {
  toneFromUsedPct,
  unavailable,
  windowFromUsedPct,
  type UsageDetail,
  type UsageReport,
} from "@getpaseo/plugin/server/usage";
import { z } from "zod";
import { timestampMs } from "./probe.js";
import { UsageError } from "./errors.js";

// These period names are justified by the API's bucketId, not response order or
// time until reset. durationMs is not part of Paseo 0.11's UsageWindow contract.
const BUCKETS = [
  { id: "gemini-5h", label: "Gemini · 5h", shortLabel: "Gemini 5h" },
  { id: "gemini-weekly", label: "Gemini · Weekly", shortLabel: "Gemini wk" },
  { id: "3p-5h", label: "Claude & GPT · 5h", shortLabel: "3P 5h" },
  { id: "3p-weekly", label: "Claude & GPT · Weekly", shortLabel: "3P wk" },
] as const;

type BucketTargetId = typeof BUCKETS[number]["id"];

const summarySchema = z.object({ groups: z.array(z.unknown()) });
const groupSchema = z.object({
  displayName: z.string().optional(),
  name: z.string().optional(),
  buckets: z.array(z.unknown()),
});
const bucketSchema = z.object({
  bucketId: z.string(),
  displayName: z.string().optional(),
  window: z.string().optional(),
  remainingFraction: z.unknown().optional(),
  resetTime: z.unknown().optional(),
});
type Bucket = z.infer<typeof bucketSchema>;

type GroupKind = "gemini" | "3p" | "unknown";

export function classifyGroup(displayName?: string, name?: string): GroupKind {
  const combined = `${displayName ?? ""} ${name ?? ""}`.toLowerCase();
  const hasGemini = combined.includes("gemini") || combined.includes("google") || combined.includes("1p");
  const has3p =
    combined.includes("claude") ||
    combined.includes("gpt") ||
    combined.includes("3p") ||
    combined.includes("third") ||
    combined.includes("partner");

  // Ambiguous group containing both or neither is classified as unknown
  if (hasGemini && !has3p) return "gemini";
  if (has3p && !hasGemini) return "3p";
  return "unknown";
}

export interface WindowClassification {
  is5h: boolean;
  isWeekly: boolean;
}

export function classifyWindow(windowStr: string): WindowClassification {
  const w = windowStr.toLowerCase();
  const is5h =
    w.includes("5h") ||
    w.includes("5-hour") ||
    w.includes("5_hour") ||
    w.includes("5 hour") ||
    w.includes("five-hour") ||
    w.includes("five_hour") ||
    w.includes("five hour");
  const isWeekly =
    w.includes("week") ||
    w.includes("7d") ||
    w.includes("7-day");

  return { is5h, isWeekly };
}

function isExplicitId(rawId: string): boolean {
  return rawId === "gemini-5h" || rawId === "gemini-weekly" || rawId === "3p-5h" || rawId === "3p-weekly";
}

export function matchBucketTarget(
  bucket: Bucket,
  groupKind: GroupKind,
): BucketTargetId | null {
  const rawId = bucket.bucketId.toLowerCase();

  // Reject explicit conflict between outer group kind and bucket identity
  if (groupKind === "gemini" && (rawId.startsWith("3p") || rawId.includes("claude") || rawId.includes("gpt"))) {
    return null;
  }
  if (groupKind === "3p" && (rawId.startsWith("gemini") || rawId.includes("google") || rawId.startsWith("1p"))) {
    return null;
  }

  // 1. Direct explicit bucket ID match (highest precedence when not conflicting)
  if (rawId === "gemini-5h") return "gemini-5h";
  if (rawId === "gemini-weekly") return "gemini-weekly";
  if (rawId === "3p-5h") return "3p-5h";
  if (rawId === "3p-weekly") return "3p-weekly";

  // 2. Preserving model group context: avoid cross-group matching
  const windowStr = `${bucket.window ?? ""} ${bucket.displayName ?? ""} ${rawId}`;
  const { is5h, isWeekly } = classifyWindow(windowStr);

  if (groupKind === "gemini") {
    if (is5h) return "gemini-5h";
    if (isWeekly) return "gemini-weekly";
  } else if (groupKind === "3p") {
    if (is5h) return "3p-5h";
    if (isWeekly) return "3p-weekly";
  }

  return null;
}

export function readTierLabel(document: unknown): string | null {
  const tier = z.object({ id: z.string().min(1) });
  const parsed = z.object({
    g1Tier: z.unknown().optional(),
    paidTier: z.unknown().optional(),
    currentTier: z.unknown().optional(),
  }).safeParse(document);
  if (!parsed.success) return null;
  const root = parsed.data;
  // currentTier alone is Code Assist's plan, often free even for a paid
  // Antigravity user. Prefer the consumer Google One fields when present.
  const id = typeof root.g1Tier === "string" && root.g1Tier !== "" ? root.g1Tier
    : tier.safeParse(root.paidTier).data?.id ?? tier.safeParse(root.currentTier).data?.id;
  if (!id) return null;
  const names: Record<string, string> = {
    "free-tier": "Free tier",
    "standard-tier": "Standard tier",
    "g1-pro-tier": "Google AI Pro",
    "g1-ultra-tier": "Google AI Ultra",
  };
  return Object.hasOwn(names, id) ? names[id] ?? id : id;
}

export function mapQuotaSummary(
  document: unknown,
  planLabel: string | null = null,
): UsageReport {
  const parsed = summarySchema.safeParse(document);
  if (!parsed.success) throw new UsageError("Antigravity returned an invalid quota summary (expected groups).");

  // Map of target bucket ID -> resolved Bucket data
  const byTarget = new Map<BucketTargetId, Bucket>();

  for (const rawGroup of parsed.data.groups) {
    const group = groupSchema.safeParse(rawGroup);
    if (!group.success) throw new UsageError("Antigravity returned an invalid quota group (expected buckets).");

    const groupKind = classifyGroup(group.data.displayName, group.data.name);

    for (const rawBucket of group.data.buckets) {
      const bucket = bucketSchema.safeParse(rawBucket);
      if (!bucket.success) continue;

      const targetId = matchBucketTarget(bucket.data, groupKind);
      if (targetId) {
        const existing = byTarget.get(targetId);
        if (!existing) {
          byTarget.set(targetId, bucket.data);
        } else {
          // Explicit ID wins over inferred alias; otherwise preserve the first bucket
          if (isExplicitId(bucket.data.bucketId.toLowerCase()) && !isExplicitId(existing.bucketId.toLowerCase())) {
            byTarget.set(targetId, bucket.data);
          }
        }
      }
    }
  }

  if (!BUCKETS.some(({ id }) => byTarget.has(id))) {
    return unavailable({ kind: "no_quota", detail: "Antigravity did not report the Gemini or Claude & GPT quota pools for this login." });
  }

  const windows = BUCKETS.map(({ id, label, shortLabel }) => {
    const bucket = byTarget.get(id);
    const remaining = bucket?.remainingFraction;
    const usedPct = typeof remaining === "number" && Number.isFinite(remaining)
      ? Math.max(0, Math.min(100, (1 - remaining) * 100)) : null;
    const resetsAtMs = timestampMs(bucket?.resetTime);
    return windowFromUsedPct({
      id,
      label,
      shortLabel,
      summary: true,
      utilizationPct: usedPct,
      resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
      tone: toneFromUsedPct(usedPct),
    });
  });

  if (windows.every((window) => window.usedPct === null)) {
    throw new UsageError("Antigravity quota buckets contain no valid remainingFraction readings.");
  }

  const details: UsageDetail[] = [];
  if (planLabel === "Free tier") {
    details.push({
      id: "free-tier-note",
      label: "Free tier",
      value: "On free plans the 5h buckets may stay at full remaining quota; use the weekly buckets to track consumption.",
    });
  }
  if (windows.some((window) => window.usedPct === null)) {
    details.push({ id: "missing-buckets", label: "Quota data", value: "Some quota buckets were omitted or had no valid reading; their usage is unknown, not zero." });
  }

  return {
    status: "available",
    ...(planLabel ? { planLabel } : {}),
    windows,
    details,
  };
}

interface ExtractedRecord {
  groupKind: GroupKind;
  is5h: boolean;
  isWeekly: boolean;
  remainingPct: number | null;
  resetsAt: string | null;
}

function buildReportFromExtracted(
  records: ExtractedRecord[],
  planLabel?: string | null,
): UsageReport {
  const byTarget = new Map<BucketTargetId, ExtractedRecord>();

  for (const record of records) {
    let targetId: BucketTargetId | null = null;
    if (record.groupKind === "gemini") {
      if (record.is5h) targetId = "gemini-5h";
      if (record.isWeekly) targetId = "gemini-weekly";
    } else if (record.groupKind === "3p") {
      if (record.is5h) targetId = "3p-5h";
      if (record.isWeekly) targetId = "3p-weekly";
    }

    if (targetId && !byTarget.has(targetId)) {
      byTarget.set(targetId, record);
    }
  }

  if (byTarget.size === 0) {
    return unavailable({
      kind: "no_quota",
      detail: "Antigravity CLI did not report Gemini or Claude & GPT quota pools for this login.",
    });
  }

  const windows = BUCKETS.map(({ id, label, shortLabel }) => {
    const record = byTarget.get(id);
    if (!record || record.remainingPct === null) {
      return {
        id,
        label,
        shortLabel,
        summary: true,
        usedPct: null,
        remainingPct: null,
        resetsAt: null,
        tone: "default" as const,
      };
    }

    const remainingPct = record.remainingPct;
    const usedPct = Math.max(0, Math.min(100, 100 - remainingPct));
    return windowFromUsedPct({
      id,
      label,
      shortLabel,
      summary: true,
      utilizationPct: usedPct,
      resetsAt: record.resetsAt,
      tone: toneFromUsedPct(usedPct),
    });
  });

  const details: UsageDetail[] = [];
  if (planLabel === "Free tier") {
    details.push({
      id: "free-tier-note",
      label: "Free tier",
      value: "On free plans the 5h buckets may stay at full remaining quota; use the weekly buckets to track consumption.",
    });
  }
  if (windows.some((w) => w.usedPct === null)) {
    details.push({
      id: "missing-buckets",
      label: "Quota data",
      value: "Some quota buckets were omitted or had no valid reading; their usage is unknown, not zero.",
    });
  }

  return {
    status: "available",
    ...(planLabel ? { planLabel } : {}),
    windows,
    details,
  };
}

function mapArrayRecords(items: unknown[], planLabel?: string | null): UsageReport {
  const records: ExtractedRecord[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;

    const groupStr = `${obj.group ?? ""} ${obj.model ?? ""} ${obj.displayName ?? ""} ${obj.name ?? ""}`.toLowerCase();
    const windowStr = `${obj.window ?? ""} ${obj.period ?? ""} ${obj.bucketId ?? ""} ${obj.label ?? ""}`.toLowerCase();

    const groupKind = classifyGroup(groupStr, windowStr);
    const { is5h, isWeekly } = classifyWindow(windowStr);

    if (!is5h && !isWeekly) continue;

    let remainingPct: number | null = null;
    if (typeof obj.remainingPct === "number" && Number.isFinite(obj.remainingPct)) {
      remainingPct = obj.remainingPct;
    } else if (typeof obj.remainingFraction === "number" && Number.isFinite(obj.remainingFraction)) {
      remainingPct = obj.remainingFraction * 100;
    } else if (typeof obj.remaining === "number" && Number.isFinite(obj.remaining)) {
      remainingPct = obj.remaining <= 1 ? obj.remaining * 100 : obj.remaining;
    } else if (typeof obj.utilizationPct === "number" && Number.isFinite(obj.utilizationPct)) {
      remainingPct = 100 - obj.utilizationPct;
    } else if (typeof obj.usedPct === "number" && Number.isFinite(obj.usedPct)) {
      remainingPct = 100 - obj.usedPct;
    } else if (typeof obj.remainingPct === "string") {
      const num = parseFloat(obj.remainingPct.replace("%", ""));
      if (Number.isFinite(num)) remainingPct = num;
    }

    if (remainingPct !== null) {
      remainingPct = Math.max(0, Math.min(100, remainingPct));
    }

    let resetsAt: string | null = null;
    const rawReset = obj.resetsAt ?? obj.resetTime ?? obj.reset ?? obj.resets_at ?? null;
    if (typeof rawReset === "string" && rawReset.trim() !== "") {
      const ms = timestampMs(rawReset);
      resetsAt = ms !== null ? new Date(ms).toISOString() : rawReset;
    } else if (typeof rawReset === "number") {
      const ms = timestampMs(rawReset);
      resetsAt = ms !== null ? new Date(ms).toISOString() : null;
    }

    records.push({ groupKind, is5h, isWeekly, remainingPct, resetsAt });
  }

  return buildReportFromExtracted(records, planLabel);
}

function mapTextLines(text: string, planLabel?: string | null): UsageReport {
  const lines = text.trim().split("\n");
  const records: ExtractedRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;

    // TSV format
    if (trimmed.includes("\t")) {
      const cols = trimmed.split("\t").map((c) => c.trim());
      if (cols.length >= 3) {
        const groupStr = cols[0]!;
        const windowStr = cols[1]!;
        const pctStr = cols[2]!;
        const resetStr = cols[3] ?? null;

        const groupKind = classifyGroup(groupStr, "");
        const { is5h, isWeekly } = classifyWindow(windowStr);
        const num = parseFloat(pctStr.replace("%", ""));
        const remainingPct = Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : null;

        let resetsAt: string | null = null;
        if (resetStr) {
          const ms = timestampMs(resetStr);
          resetsAt = ms !== null ? new Date(ms).toISOString() : resetStr;
        }

        if (is5h || isWeekly) {
          records.push({ groupKind, is5h, isWeekly, remainingPct, resetsAt });
        }
        continue;
      }
    }

    // Terminal formatted line: e.g. "Gemini 5-hour limit: 100% remaining (resets in 4h 12m)"
    const match = trimmed.match(
      /^(Gemini|Claude(?:\s+and\s+GPT)?|3P)\s*[:\t-]?\s*(5-hours?|5-hour|5h|5\s*hours?|5_hours?|five-hours?|five\s*hours?|five_hours?|Weekly|week|7-day|7d)[^:]*:\s*([\d.]+)%\s*remaining(?:\s*\((?:resets\s*(?:in\s*|at\s*|on\s*)?([^)]+))\))?/i,
    );
    if (match) {
      const groupStr = match[1]!;
      const windowStr = match[2]!;
      const pctStr = match[3]!;
      const resetStr = match[4] ?? null;

      const groupKind = classifyGroup(groupStr, "");
      const { is5h, isWeekly } = classifyWindow(windowStr);
      const num = parseFloat(pctStr);
      const remainingPct = Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : null;

      if (is5h || isWeekly) {
        records.push({ groupKind, is5h, isWeekly, remainingPct, resetsAt: resetStr });
      }
    }
  }

  return buildReportFromExtracted(records, planLabel);
}

export function mapCliUsageOutput(
  rawOutput: string,
  planLabel?: string | null,
): UsageReport {
  let jsonDoc: unknown;
  try {
    jsonDoc = JSON.parse(rawOutput.trim());
  } catch {
    throw new UsageError("Antigravity CLI returned invalid JSON output.");
  }

  // Unwrap `response` envelope from `agy -p "/usage" --output-format json`
  let payload: unknown = jsonDoc;
  if (typeof jsonDoc === "object" && jsonDoc !== null && "response" in jsonDoc) {
    payload = (jsonDoc as Record<string, unknown>).response;
  }

  // If payload is a stringified JSON, unwrap it
  if (typeof payload === "string") {
    try {
      const parsedNested = JSON.parse(payload.trim());
      if (typeof parsedNested === "object" && parsedNested !== null) {
        payload = parsedNested;
      }
    } catch {
      // Keep payload as string (will be parsed as text/TSV)
    }
  }

  // Case 1: payload is a QuotaSummary document with groups (or summary.groups)
  if (typeof payload === "object" && payload !== null) {
    let candidateGroups: unknown = payload;
    if ("summary" in payload && typeof (payload as any).summary === "object" && (payload as any).summary !== null) {
      candidateGroups = (payload as any).summary;
    }
    if (
      typeof candidateGroups === "object" &&
      candidateGroups !== null &&
      "groups" in candidateGroups &&
      Array.isArray((candidateGroups as any).groups)
    ) {
      return mapQuotaSummary(candidateGroups, planLabel);
    }
  }

  // Case 2: payload is an array of record objects
  if (Array.isArray(payload)) {
    return mapArrayRecords(payload, planLabel);
  }

  // Case 3: payload is text / TSV lines
  if (typeof payload === "string") {
    return mapTextLines(payload, planLabel);
  }

  throw new UsageError("Antigravity CLI output has an unsupported response format.");
}
