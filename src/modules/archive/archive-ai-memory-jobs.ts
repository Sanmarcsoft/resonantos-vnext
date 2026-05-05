import type { ArchiveAiMemoryBuildJobSummary } from "../../core/contracts";

export const selectAutoContinuableAiMemoryJob = (
  jobs: ArchiveAiMemoryBuildJobSummary[],
): ArchiveAiMemoryBuildJobSummary | undefined =>
  jobs.find(
    (job) =>
      ["running", "ready-to-promote"].includes(job.status) &&
      job.errors.length === 0 &&
      job.reviewEscalated === 0 &&
      job.manifestPath.trim(),
  );
