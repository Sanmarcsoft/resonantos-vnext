import { describe, expect, it } from "vitest";
import type { ResonantShellState } from "./contracts";
import { buildDefaultState } from "./defaults";
import { normalizeState } from "./runtime";

describe("runtime state migration", () => {
  it("migrates legacy recovery state onto the Resonant Engineer Agent and Gemma local runtime", () => {
    const base = buildDefaultState([]);
    const legacy = {
      ...base,
      agents: [
        {
          ...base.agents.find((agent) => agent.id === "strategist.core")!,
          providerProfileId: "shared-minimax",
          fallbackProviderProfileId: "shared-openai",
        },
        {
          ...base.agents.find((agent) => agent.id === "setup.core")!,
          displayName: "Setup",
          providerProfileId: "shared-minimax",
          fallbackProviderProfileId: "shared-openai",
          archiveReadScopes: ["configuration"],
          channelIds: ["desktop-setup"],
        },
        {
          id: "engineer.core",
          displayName: "Engineer Agent",
          trustTier: "core",
          workspaceBehavior: "delegated",
          providerProfileId: "shared-local",
          archiveReadScopes: ["configuration", "constitution"],
          archiveIntakeWriteScopes: ["LivingArchive/REVIEW"],
          canWriteKnowledgePages: false,
          channelIds: ["desktop-engineer"],
        },
        base.agents.find((agent) => agent.id === "archive-ingest.core")!,
      ],
      providers: base.providers.map((provider) =>
        provider.id === "shared-local"
          ? {
              ...provider,
              allowedModels: ["local/creative", "local/transcribe"],
              primaryModel: "local/creative",
            }
          : provider,
      ),
      runtimeNodes: base.runtimeNodes.map((node) =>
        node.id === "node-local-resurrect"
          ? {
              ...node,
              supportedModels: ["local/creative", "local/transcribe"],
            }
          : node,
      ),
      recoverySession: {
        ...base.recoverySession,
        engineerAgentId: "engineer.core",
        active: true,
      },
      conversationThreads: base.conversationThreads.filter((thread) => thread.id !== "thread-recovery-engineer"),
    } satisfies ResonantShellState;

    const normalized = normalizeState(legacy, base);

    const setupAgent = normalized.agents.find((agent) => agent.id === "setup.core");
    expect(setupAgent?.displayName).toBe("Resonant Engineer Agent");
    expect(setupAgent?.providerProfileId).toBe("shared-local");
    expect(normalized.recoverySession.engineerAgentId).toBe("setup.core");
    expect(normalized.providers.find((provider) => provider.id === "shared-local")?.primaryModel).toBe("batiai/gemma4-e2b:q4");
    expect(normalized.runtimeNodes.find((node) => node.id === "node-local-resurrect")?.supportedModels).toContain("batiai/gemma4-e2b:q4");
    expect(normalized.conversationThreads.find((thread) => thread.id === "thread-recovery-engineer")).toBeDefined();
    expect(normalized.modelStrategy.profileId).toBe("personal-studio-default");
    expect(normalized.modelStrategy.workloadStrategies.length).toBeGreaterThan(0);
  });

  it("preserves persisted user-created conversation threads during normalization", () => {
    const base = buildDefaultState([]);
    const persistedFork = {
      ...base.conversationThreads[0],
      id: "thread-fork-custom",
      title: "Custom fork",
      summary: "User-created fork that must survive reload.",
      messages: [
        {
          ...base.conversationThreads[0].messages[0],
          id: "thread-fork-custom:m1",
          threadId: "thread-fork-custom",
        },
      ],
    };
    const persisted = {
      ...base,
      conversationThreads: [...base.conversationThreads, persistedFork],
      uiPreferences: {
        ...base.uiPreferences,
        activeChatThreadId: persistedFork.id,
        pinnedChatThreadIds: [persistedFork.id],
      },
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);

    expect(normalized.conversationThreads.find((thread) => thread.id === "thread-fork-custom")).toBeDefined();
    expect(normalized.uiPreferences.activeChatThreadId).toBe("thread-fork-custom");
    expect(normalized.uiPreferences.pinnedChatThreadIds).toContain("thread-fork-custom");
  });

  it("preserves the transcript ledger during state normalization", () => {
    const base = buildDefaultState([]);
    const persisted = {
      ...base,
      transcriptLedger: [
        {
          id: "thread-main-desktop:e1",
          createdAt: "2026-04-25T10:00:00.000Z",
          action: "message-appended" as const,
          threadId: "thread-main-desktop",
          channelId: "desktop-main",
          messageId: "thread-main-desktop:m2",
          role: "user" as const,
          agentId: "strategist.core",
          payload: {
            content: "Preserve this raw turn.",
          },
        },
      ],
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);

    expect(normalized.transcriptLedger).toHaveLength(1);
    expect(normalized.transcriptLedger[0]?.payload.content).toBe("Preserve this raw turn.");
  });

  it("preserves stored context memory states during state normalization", () => {
    const base = buildDefaultState([]);
    const persisted = {
      ...base,
      contextMemoryStates: [
        {
          threadId: "thread-main-desktop",
          compactedAt: "2026-04-25T10:00:00.000Z",
          sourceRange: {
            fromMessageId: "thread-main-desktop:m1",
            toMessageId: "thread-main-desktop:m2",
          },
          userIntent: {
            goal: "Implement compaction.",
            why: "Avoid amnesia.",
            successCriteria: ["Context survives reload."],
            prioritySignals: ["quality"],
            sourceMessageIds: ["thread-main-desktop:m1"],
          },
          workingSummary: "Compaction work in progress.",
          decisions: [],
          facts: [],
          preferences: [],
          openTasks: [],
          artifacts: [],
          risks: [],
          unresolvedQuestions: [],
          preservedRecentMessageIds: ["thread-main-desktop:m2"],
          checksum: "fnv32:test",
        },
      ],
    } satisfies ResonantShellState;

    const normalized = normalizeState(persisted, base);

    expect(normalized.contextMemoryStates).toHaveLength(1);
    expect(normalized.contextMemoryStates[0]?.userIntent.why).toBe("Avoid amnesia.");
  });
});
