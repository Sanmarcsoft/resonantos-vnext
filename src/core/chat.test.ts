import { describe, expect, it } from "vitest";
import { appendAssistantMessage, appendUserMessage, createStrategistThread } from "./chat";
import { buildDefaultState } from "./defaults";

describe("chat transcript ledger", () => {
  it("records appended visible messages in an append-only transcript ledger", () => {
    const base = buildDefaultState([]);
    const withUser = appendUserMessage(base, "thread-main-desktop", "Preserve the why behind the work.");
    const withAssistant = appendAssistantMessage(withUser, "thread-main-desktop", "I will preserve user intent.");

    expect(withAssistant.transcriptLedger).toHaveLength(2);
    expect(withAssistant.transcriptLedger[0]).toMatchObject({
      action: "message-appended",
      threadId: "thread-main-desktop",
      role: "user",
      payload: expect.objectContaining({
        content: "Preserve the why behind the work.",
      }),
    });
    expect(withAssistant.transcriptLedger[1]).toMatchObject({
      action: "message-appended",
      role: "assistant",
      payload: expect.objectContaining({
        content: "I will preserve user intent.",
      }),
    });
  });

  it("records created chat threads without depending on visible thread history", () => {
    const base = buildDefaultState([]);
    const next = createStrategistThread(base, {
      channelId: "desktop-main",
      workspaceId: "workspace-main",
      title: "Compaction test",
    });

    expect(next.transcriptLedger).toHaveLength(1);
    expect(next.transcriptLedger[0]).toMatchObject({
      action: "thread-created",
      agentId: "strategist.core",
      payload: expect.objectContaining({
        title: "Compaction test",
      }),
    });
  });

  it("keeps provider usage telemetry on assistant messages and transcript events", () => {
    const base = buildDefaultState([]);
    const next = appendAssistantMessage(base, "thread-main-desktop", "Usage measured.", {
      providerUsage: {
        providerId: "shared-minimax",
        model: "MiniMax-M2.7",
        source: "provider",
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        durationMs: 2200,
        tokensPerSecond: 13.6,
      },
    });

    const message = next.conversationThreads
      .find((thread) => thread.id === "thread-main-desktop")
      ?.messages.at(-1);
    expect(message?.providerUsage).toMatchObject({
      providerId: "shared-minimax",
      promptTokens: 120,
      totalTokens: 150,
    });
    expect(next.transcriptLedger.at(-1)?.payload).toMatchObject({
      providerUsage: expect.objectContaining({
        model: "MiniMax-M2.7",
        completionTokens: 30,
        tokensPerSecond: 13.6,
      }),
    });
  });

  it("uses the owning add-on agent display name for add-on assistant messages", () => {
    const base = buildDefaultState([
      {
        id: "addon.hermes",
        name: "Hermes",
        version: "0.1.0",
        author: "test",
        category: "agent",
        description: "test",
        runtimeType: "agent-addon",
        surfaces: [],
        requestedCapabilities: [],
        providerRequirements: { sharedProfiles: [], supportsPrivateCredentials: false },
        archiveIntegration: {
          readScopes: [],
          intakeWriteScopes: [],
          canRequestIngest: false,
          canWriteKnowledgePages: false,
        },
        health: { strategy: "test" },
        installHooks: {},
        compatibility: { shellVersion: "^0.1.0", platforms: ["macOS"] },
      },
    ]);
    const state = {
      ...base,
      conversationThreads: [
        {
          id: "thread-hermes-test",
          title: "Hermes",
          owningAgentId: "hermes.agent",
          workspaceId: "workspace-hermes",
          channelId: "desktop-hermes",
          summary: "Hermes add-on test.",
          messages: [],
        },
        ...base.conversationThreads,
      ],
    };
    const next = appendAssistantMessage(state, "thread-hermes-test", "I am here.");

    const message = next.conversationThreads.find((thread) => thread.id === "thread-hermes-test")?.messages.at(-1);
    expect(message?.author).toBe("Hermes");
  });
});
