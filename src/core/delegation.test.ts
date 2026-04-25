import { describe, expect, it } from "vitest";
import type { AddOnManifest, DelegationPacket } from "./contracts";
import { delegationTargetsFromManifests, renderDelegationTaskMarkdown, validateDelegationPacket } from "./delegation";

const basePacket = (overrides: Partial<DelegationPacket> = {}): DelegationPacket => ({
  id: "delegation-1",
  createdAt: "2026-04-25T12:00:00.000Z",
  createdByAgentId: "strategist.core",
  targetAgentId: "opencode.runtime",
  targetRuntime: "embedded-workspace",
  taskType: "code-change",
  mission: "Refactor the provider route card into a smaller component without changing behavior.",
  context: "The shell composition root is being kept small under ADR-002. Preserve existing UX.",
  sourceMemoryRefs: ["archive://concept/provider-fabric"],
  systemMemoryRefs: ["system://resonantos-architecture-contract"],
  workspaceId: "workspace-delegation-1",
  filesInScope: ["src/modules/settings/ProviderRouteCard.tsx"],
  allowedTools: ["filesystem.read", "filesystem.search", "filesystem.patch"],
  forbiddenActions: ["Do not change provider secrets.", "Do not alter routing policy."],
  capabilityGrants: [
    {
      capability: "filesystem",
      granted: true,
      scope: "workspace",
      revocationBehavior: "hard-stop",
    },
  ],
  providerPolicy: {
    preferredProviderProfileIds: ["shared-minimax"],
    preferredRuntimeNodeIds: ["node-minimax-cloud"],
    preferredModels: ["MiniMax-M2.7"],
    allowedRuntimeKinds: ["cloud", "local"],
    fallbackPolicyId: "core-default",
  },
  costPolicy: {
    sensitivity: "medium",
    preferredCostTier: "subscription",
    allowPaidEscalation: false,
    rationale: "Routine coding should prefer subscription or local routes.",
  },
  humanApprovalRequired: false,
  approvalReasons: [],
  verificationRequirements: [
    {
      id: "npm-test",
      label: "Run npm test",
      method: "unit-test",
      required: true,
    },
  ],
  expectedArtifacts: ["summary", "diff", "verification-report"],
  returnProtocol: {
    summaryRequired: true,
    artifactTypes: ["summary", "diff", "verification-report"],
    mustReportFilesChanged: true,
    mustReportCommandsRun: true,
    mustReportResidualRisks: true,
    mustReportVerification: true,
  },
  auditLogPath: "TaskWorkspace/logs/audit.jsonl",
  ...overrides,
});

const manifest = (overrides: Partial<AddOnManifest>): AddOnManifest => ({
  id: "addon.opencode",
  name: "OpenCode",
  version: "0.1.0",
  author: "test",
  category: "tool",
  description: "test",
  runtimeType: "embedded-module",
  surfaces: [],
  requestedCapabilities: [
    {
      capability: "filesystem",
      granted: false,
      scope: "workspace",
      revocationBehavior: "hard-stop",
    },
  ],
  providerRequirements: {
    sharedProfiles: [],
    supportsPrivateCredentials: false,
  },
  archiveIntegration: {
    readScopes: [],
    intakeWriteScopes: [],
    canRequestIngest: false,
    canWriteKnowledgePages: false,
  },
  health: {
    strategy: "none",
  },
  installHooks: {},
  compatibility: {
    shellVersion: "^0.1.0",
    platforms: ["macOS"],
  },
  ...overrides,
});

describe("delegation packet validation", () => {
  it("accepts a concrete code delegation with scope and verification", () => {
    const result = validateDelegationPacket(basePacket());
    expect(result.valid).toBe(true);
    expect(result.issues.filter((entry) => entry.severity === "error")).toHaveLength(0);
  });

  it("rejects vague missions", () => {
    const result = validateDelegationPacket(basePacket({ mission: "Investigate and fix." }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === "vague-mission")).toBe(true);
  });

  it("rejects code delegations without verification", () => {
    const result = validateDelegationPacket(basePacket({ verificationRequirements: [] }));
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === "code-task-without-verification")).toBe(true);
  });

  it("rejects risky delegations without human approval", () => {
    const result = validateDelegationPacket(
      basePacket({
        taskType: "communication",
        filesInScope: [],
        approvalReasons: ["public-action"],
        humanApprovalRequired: false,
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.issues.some((entry) => entry.code === "risky-task-without-approval")).toBe(true);
  });
});

describe("TASK.md renderer", () => {
  it("renders the packet into an interoperable worker brief", () => {
    const rendered = renderDelegationTaskMarkdown(basePacket());
    expect(rendered).toContain("# TASK.md");
    expect(rendered).toContain("## Mission");
    expect(rendered).toContain("ProviderRouteCard.tsx");
    expect(rendered).toContain("Run npm test");
    expect(rendered).toContain("## Return Protocol");
    expect(rendered).toContain("Packet id: delegation-1");
  });
});

describe("delegation targets", () => {
  it("derives delegation targets from add-on manifests", () => {
    const targets = delegationTargetsFromManifests([
      manifest({
        agents: [
          {
            id: "opencode.runtime",
            displayName: "OpenCode",
            trustTier: "addon",
            workspaceBehavior: "delegated",
          },
        ],
        delegation: {
          acceptsTasks: true,
          taskTypes: ["code-change", "bug-fix"],
          artifactReturnTypes: ["summary", "diff", "verification-report"],
          defaultTargetRuntime: "embedded-workspace",
          requiresHumanApprovalBeforeExecution: true,
        },
      }),
      manifest({
        id: "addon.obsidian",
        name: "Obsidian",
      }),
    ]);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.id).toBe("opencode.runtime");
    expect(targets[0]?.acceptedTaskTypes).toContain("code-change");
  });
});

