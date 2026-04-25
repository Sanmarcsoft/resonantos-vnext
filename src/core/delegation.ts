// Intent citation: docs/architecture/ADR-015-delegation-fabric-addon-catalog-native-tools.md

import type {
  AddOnManifest,
  DelegationPacket,
  DelegationTarget,
  DelegationValidationIssue,
  DelegationValidationResult,
} from "./contracts";

const VAGUE_MISSION_PATTERNS = [
  /\binvestigate\s+and\s+fix\b/i,
  /\bfix\s+everything\b/i,
  /\bmake\s+it\s+work\b/i,
  /\bdo\s+the\s+needful\b/i,
  /\bhandle\s+this\b/i,
];

const CODE_TASK_TYPES = new Set(["code-change", "bug-fix", "system-repair"]);
const RISKY_APPROVAL_REASONS = new Set(["destructive", "public-action", "financial", "identity-sensitive", "broad-filesystem"]);

const issue = (severity: DelegationValidationIssue["severity"], code: string, message: string): DelegationValidationIssue => ({
  severity,
  code,
  message,
});

const hasRequiredVerification = (packet: DelegationPacket): boolean =>
  packet.verificationRequirements.some((requirement) => requirement.required && requirement.method !== "none");

const hasGrantedCapability = (packet: DelegationPacket): boolean =>
  packet.capabilityGrants.some((grant) => grant.granted);

export const validateDelegationPacket = (packet: DelegationPacket): DelegationValidationResult => {
  const issues: DelegationValidationIssue[] = [];
  const mission = packet.mission.trim();
  const context = packet.context.trim();

  if (!packet.taskType) {
    issues.push(issue("error", "missing-task-type", "Delegation packet must declare a task type."));
  }
  if (!packet.targetAgentId.trim()) {
    issues.push(issue("error", "missing-target", "Delegation packet must declare a target agent or add-on."));
  }
  if (!mission) {
    issues.push(issue("error", "missing-mission", "Delegation packet must include a mission."));
  }
  if (mission.length < 24) {
    issues.push(issue("error", "mission-too-short", "Delegation mission is too short to preserve intent."));
  }
  if (VAGUE_MISSION_PATTERNS.some((pattern) => pattern.test(mission))) {
    issues.push(issue("error", "vague-mission", "Delegation mission is too vague. Replace it with concrete scope and expected outcome."));
  }
  if (!context) {
    issues.push(issue("warning", "missing-context", "Delegation packet has no context block."));
  }
  if (!packet.workspaceId.trim()) {
    issues.push(issue("error", "missing-workspace", "Delegation packet must bind the task to a workspace."));
  }
  if (!packet.returnProtocol.summaryRequired || !packet.returnProtocol.artifactTypes.length) {
    issues.push(issue("error", "missing-return-protocol", "Delegation packet must define a return protocol and artifact types."));
  }
  if (!packet.expectedArtifacts.length) {
    issues.push(issue("error", "missing-expected-artifacts", "Delegation packet must define expected artifacts."));
  }
  if (CODE_TASK_TYPES.has(packet.taskType) && !packet.filesInScope.length) {
    issues.push(issue("error", "code-task-without-files", "Code or system repair delegation requires files in scope."));
  }
  if (CODE_TASK_TYPES.has(packet.taskType) && !hasRequiredVerification(packet)) {
    issues.push(issue("error", "code-task-without-verification", "Code or system repair delegation requires deterministic verification."));
  }
  if (packet.filesInScope.length > 3 && CODE_TASK_TYPES.has(packet.taskType)) {
    issues.push(issue("warning", "broad-code-scope", "Coding delegation has more than three primary files in scope."));
  }
  if (packet.approvalReasons.some((reason) => RISKY_APPROVAL_REASONS.has(reason)) && !packet.humanApprovalRequired) {
    issues.push(issue("error", "risky-task-without-approval", "Risky delegation requires explicit human approval."));
  }
  if (!hasGrantedCapability(packet)) {
    issues.push(issue("warning", "no-capability-grants", "Delegation packet has no granted capabilities; target may run in degraded mode."));
  }
  if (!packet.systemMemoryRefs.length) {
    issues.push(issue("warning", "missing-system-memory", "Delegation packet does not cite System Architecture Memory."));
  }
  if (packet.costPolicy.sensitivity === "high" && packet.costPolicy.preferredCostTier === "paid-api") {
    issues.push(issue("warning", "high-cost-route", "High cost sensitivity conflicts with paid API preference."));
  }

  return {
    valid: issues.every((entry) => entry.severity !== "error"),
    issues,
  };
};

const renderList = (items: string[], fallback = "None specified."): string =>
  items.length ? items.map((item) => `- ${item}`).join("\n") : `- ${fallback}`;

export const renderDelegationTaskMarkdown = (packet: DelegationPacket): string =>
  [
    `# TASK.md — ${packet.taskType}`,
    "",
    "## Mission",
    packet.mission.trim(),
    "",
    "## Context",
    packet.context.trim() || "No context provided.",
    "",
    "## Target",
    `- Target agent/add-on: ${packet.targetAgentId}`,
    `- Runtime: ${packet.targetRuntime}`,
    `- Workspace: ${packet.workspaceId}`,
    `- Created by: ${packet.createdByAgentId}`,
    "",
    "## Files In Scope",
    renderList(packet.filesInScope),
    "",
    "## System Memory References",
    renderList(packet.systemMemoryRefs),
    "",
    "## Source Memory References",
    renderList(packet.sourceMemoryRefs),
    "",
    "## Allowed Tools",
    renderList(packet.allowedTools),
    "",
    "## Forbidden Actions",
    renderList(packet.forbiddenActions),
    "",
    "## Verification Requirements",
    packet.verificationRequirements.length
      ? packet.verificationRequirements
          .map((requirement) => `- [${requirement.required ? "required" : "optional"}] ${requirement.label} (${requirement.method})`)
          .join("\n")
      : "- None specified.",
    "",
    "## Expected Artifacts",
    renderList(packet.expectedArtifacts),
    "",
    "## Return Protocol",
    `- Summary required: ${packet.returnProtocol.summaryRequired ? "yes" : "no"}`,
    `- Artifact types: ${packet.returnProtocol.artifactTypes.join(", ") || "none"}`,
    `- Report files changed: ${packet.returnProtocol.mustReportFilesChanged ? "yes" : "no"}`,
    `- Report commands run: ${packet.returnProtocol.mustReportCommandsRun ? "yes" : "no"}`,
    `- Report residual risks: ${packet.returnProtocol.mustReportResidualRisks ? "yes" : "no"}`,
    `- Report verification: ${packet.returnProtocol.mustReportVerification ? "yes" : "no"}`,
    "",
    "## Approval And Audit",
    `- Human approval required: ${packet.humanApprovalRequired ? "yes" : "no"}`,
    `- Approval reasons: ${packet.approvalReasons.join(", ") || "none"}`,
    `- Audit log: ${packet.auditLogPath}`,
    "",
    "## Cost And Provider Policy",
    `- Cost sensitivity: ${packet.costPolicy.sensitivity}`,
    `- Preferred cost tier: ${packet.costPolicy.preferredCostTier}`,
    `- Paid escalation allowed: ${packet.costPolicy.allowPaidEscalation ? "yes" : "no"}`,
    `- Cost rationale: ${packet.costPolicy.rationale}`,
    `- Preferred providers: ${packet.providerPolicy.preferredProviderProfileIds.join(", ") || "none"}`,
    `- Preferred models: ${packet.providerPolicy.preferredModels.join(", ") || "none"}`,
    "",
    "## Packet",
    `- Packet id: ${packet.id}`,
    `- Created at: ${packet.createdAt}`,
    "",
  ].join("\n");

export const delegationTargetFromManifest = (manifest: AddOnManifest): DelegationTarget | null => {
  if (!manifest.delegation?.acceptsTasks) {
    return null;
  }

  return {
    id: manifest.agents?.[0]?.id ?? manifest.id,
    label: manifest.name,
    runtime: manifest.delegation.defaultTargetRuntime,
    addonId: manifest.id,
    agentId: manifest.agents?.[0]?.id,
    acceptedTaskTypes: manifest.delegation.taskTypes,
    supportedArtifactTypes: manifest.delegation.artifactReturnTypes,
    requiredCapabilities: manifest.requestedCapabilities.map((grant) => grant.capability),
    defaultRequiresHumanApproval: manifest.delegation.requiresHumanApprovalBeforeExecution,
  };
};

export const delegationTargetsFromManifests = (manifests: AddOnManifest[]): DelegationTarget[] =>
  manifests
    .map((manifest) => delegationTargetFromManifest(manifest))
    .filter((target): target is DelegationTarget => target !== null);

