import { describe, expect, it } from "vitest";
import type { ArchiveAiMemoryBuildJobSummary } from "../../core/contracts";
import { selectAutoContinuableAiMemoryJob } from "./archive-ai-memory-jobs";

const job = (overrides: Partial<ArchiveAiMemoryBuildJobSummary>): ArchiveAiMemoryBuildJobSummary => ({
  jobId: "resonant-os-base-unix-10",
  jobFile: "/tmp/review/jobs/resonant-os-base-unix-10.json",
  status: "running",
  libraryName: "RESONANT_OS_BASE",
  manifestPath: "/tmp/resonant-os-base-manifest.json",
  startedAt: "unix:10",
  finishedAt: "unix:12",
  recordsSeen: 1454,
  queuedThisRun: 6,
  processedThisRun: 6,
  promotedThisRun: 4,
  queueRemaining: 1448,
  reviewPending: 0,
  reviewApproved: 0,
  reviewEscalated: 0,
  reviewRejected: 0,
  errors: [],
  nextAction: "Continue the AI Memory build.",
  ...overrides,
});

describe("ArchiveWorkspace AI Memory auto-continuation policy", () => {
  it("selects safe running and ready-to-promote jobs", () => {
    expect(selectAutoContinuableAiMemoryJob([job({ status: "running" })])?.jobId).toBe("resonant-os-base-unix-10");
    expect(selectAutoContinuableAiMemoryJob([job({ status: "ready-to-promote" })])?.jobId).toBe("resonant-os-base-unix-10");
  });

  it("blocks jobs requiring human attention or missing continuation state", () => {
    expect(selectAutoContinuableAiMemoryJob([job({ status: "complete" })])).toBeUndefined();
    expect(selectAutoContinuableAiMemoryJob([job({ status: "needs-human-review", reviewEscalated: 1 })])).toBeUndefined();
    expect(selectAutoContinuableAiMemoryJob([job({ status: "attention", errors: ["provider failed"] })])).toBeUndefined();
    expect(selectAutoContinuableAiMemoryJob([job({ manifestPath: "" })])).toBeUndefined();
  });
});
