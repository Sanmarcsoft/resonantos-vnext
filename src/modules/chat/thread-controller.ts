// Intent citation: docs/architecture/ADR-002-modular-codebase.md
// UX citation: docs/architecture/ADR-004-chat-rail.md

import type { MutableRefObject } from "react";
import type { ChatRunPhase, ConversationMessage, ConversationThread, ResonantShellState } from "../../core/contracts";
import {
  appendTranscriptEvent,
  branchTranscriptPayload,
  compactThreadContext,
  copyCompactStatesForFork,
  messageTranscriptPayload,
} from "../../core/context-memory";
import { abortProviderServiceChatCompletion } from "../../core/runtime";
import { activateChatThread } from "../strategist/controller";
import type { ComposerAttachment } from "./types";

type RuntimeStateUpdater = (updater: (current: ResonantShellState) => ResonantShellState) => void;
type SetComposer = (value: string) => void;
type SetAttachments = (value: ComposerAttachment[]) => void;
type SetNotice = (value: string | null) => void;

export function branchChatFromMessageAction({
  activeThread,
  message,
  updateRuntimeState,
  setComposer,
  setAttachments,
  setChatNotice,
}: {
  activeThread: ConversationThread | null;
  message: ConversationMessage;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setAttachments: SetAttachments;
  setChatNotice: SetNotice;
}): void {
  if (!activeThread || message.threadId !== activeThread.id) {
    return;
  }

  updateRuntimeState((draft) => {
    const sourceThread = draft.conversationThreads.find((thread) => thread.id === activeThread.id);
    if (!sourceThread) {
      return draft;
    }

    const messageIndex = sourceThread.messages.findIndex((item) => item.id === message.id);
    if (messageIndex < 0) {
      return draft;
    }

    const forkId = `thread-fork-${Date.now()}`;
    const forkedMessages = sourceThread.messages.slice(0, messageIndex + 1).map((item) => ({
      ...item,
      threadId: forkId,
    }));
    const forkThread = {
      ...sourceThread,
      id: forkId,
      title: `${sourceThread.title} fork`,
      summary: `Forked after ${message.author}'s message.`,
      messages: forkedMessages,
    };
    draft.conversationThreads.push(forkThread);
    draft.contextMemoryStates = copyCompactStatesForFork(
      draft.contextMemoryStates ?? [],
      sourceThread.id,
      forkThread,
      message.id,
    );
    draft.uiPreferences.activeChatThreadId = forkId;
    return appendTranscriptEvent(draft, {
      action: "thread-branched",
      threadId: forkId,
      channelId: forkThread.channelId,
      agentId: forkThread.owningAgentId,
      sourceThreadId: sourceThread.id,
      sourceMessageId: message.id,
      payload: branchTranscriptPayload(sourceThread, forkThread, message.id),
    });
  });
  setComposer("");
  setAttachments([]);
  setChatNotice("Branched this conversation into a new chat.");
}

export function editUserMessageAction({
  activeThread,
  message,
  updateRuntimeState,
  setComposer,
  setChatNotice,
}: {
  activeThread: ConversationThread | null;
  message: ConversationMessage;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setChatNotice: SetNotice;
}): void {
  if (message.role !== "user") {
    return;
  }

  setComposer(message.content);
  updateRuntimeState((draft) =>
    appendTranscriptEvent(draft, {
      action: "message-edit-requested",
      threadId: message.threadId,
      channelId: message.channelId,
      messageId: message.id,
      role: message.role,
      agentId: activeThread?.owningAgentId,
      payload: messageTranscriptPayload(message),
    }),
  );
  setChatNotice("Message loaded into the composer. Edit and send when ready.");
}

export function deleteChatMessageAction({
  message,
  updateRuntimeState,
  setChatNotice,
}: {
  message: ConversationMessage;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  updateRuntimeState((draft) => {
    const targetThread = draft.conversationThreads.find((thread) => thread.id === message.threadId);
    if (!targetThread) {
      return draft;
    }

    targetThread.messages = targetThread.messages.filter((item) => item.id !== message.id);
    return appendTranscriptEvent(draft, {
      action: "message-deleted",
      threadId: message.threadId,
      channelId: message.channelId,
      messageId: message.id,
      role: message.role,
      agentId: targetThread.owningAgentId,
      payload: messageTranscriptPayload(message),
    });
  });
  setChatNotice("Message deleted from this chat.");
}

export function togglePinnedChatThreadAction({
  threadId,
  updateRuntimeState,
}: {
  threadId: string;
  updateRuntimeState: RuntimeStateUpdater;
}): void {
  updateRuntimeState((draft) => {
    const pinned = new Set(draft.uiPreferences.pinnedChatThreadIds ?? []);
    if (pinned.has(threadId)) {
      pinned.delete(threadId);
    } else {
      pinned.add(threadId);
    }
    draft.uiPreferences.pinnedChatThreadIds = Array.from(pinned);
    return draft;
  });
}

export function branchChatThreadAction({
  threadId,
  updateRuntimeState,
  setComposer,
  setAttachments,
  setChatNotice,
}: {
  threadId: string;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setAttachments: SetAttachments;
  setChatNotice: SetNotice;
}): void {
  updateRuntimeState((draft) => {
    const sourceThread = draft.conversationThreads.find((thread) => thread.id === threadId);
    if (!sourceThread) {
      return draft;
    }

    const forkId = `thread-fork-${Date.now()}`;
    const forkThread = {
      ...sourceThread,
      id: forkId,
      title: `${sourceThread.title} fork`,
      summary: `Forked from ${sourceThread.title}.`,
      messages: sourceThread.messages.map((message) => ({
        ...message,
        id: `${forkId}:${message.id.split(":").at(-1) ?? "m"}`,
        threadId: forkId,
      })),
    };
    draft.conversationThreads.unshift(forkThread);
    draft.contextMemoryStates = copyCompactStatesForFork(draft.contextMemoryStates ?? [], sourceThread.id, forkThread);
    draft.uiPreferences.activeChatThreadId = forkId;
    draft.uiPreferences.pinnedChatThreadIds = (draft.uiPreferences.pinnedChatThreadIds ?? []).filter((id) => id !== forkId);
    return appendTranscriptEvent(draft, {
      action: "thread-branched",
      threadId: forkId,
      channelId: forkThread.channelId,
      agentId: forkThread.owningAgentId,
      sourceThreadId: sourceThread.id,
      payload: branchTranscriptPayload(sourceThread, forkThread),
    });
  });
  setComposer("");
  setAttachments([]);
  setChatNotice("Chat branched into a new thread.");
}

export function deleteChatThreadAction({
  activeThread,
  threadId,
  updateRuntimeState,
  setComposer,
  setAttachments,
  setChatNotice,
}: {
  activeThread: ConversationThread | null;
  threadId: string;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setAttachments: SetAttachments;
  setChatNotice: SetNotice;
}): void {
  updateRuntimeState((draft) => {
    if (draft.conversationThreads.length <= 1) {
      return draft;
    }

    const remainingThreads = draft.conversationThreads.filter((thread) => thread.id !== threadId);
    if (remainingThreads.length === draft.conversationThreads.length) {
      return draft;
    }

    draft.conversationThreads = remainingThreads;
    draft.uiPreferences.pinnedChatThreadIds = (draft.uiPreferences.pinnedChatThreadIds ?? []).filter((id) => id !== threadId);
    if (draft.uiPreferences.activeChatThreadId === threadId) {
      const sameAgentThread = remainingThreads.find((thread) => thread.owningAgentId === activeThread?.owningAgentId);
      draft.uiPreferences.activeChatThreadId = sameAgentThread?.id ?? remainingThreads[0]?.id ?? "";
    }
    return draft;
  });
  setComposer("");
  setAttachments([]);
  setChatNotice("Chat deleted.");
}

export function compactActiveChatContextAction({
  activeThread,
  updateRuntimeState,
  setChatNotice,
}: {
  activeThread: ConversationThread | null;
  updateRuntimeState: RuntimeStateUpdater;
  setChatNotice: SetNotice;
}): void {
  if (!activeThread) {
    setChatNotice("No active chat is available to compact.");
    return;
  }

  let preservedSummary = "";
  updateRuntimeState((draft) => {
    const nextState = compactThreadContext(draft, activeThread.id);
    const compactState = nextState.contextMemoryStates.at(-1);
    if (compactState?.threadId === activeThread.id) {
      preservedSummary = [
        `${compactState.preservedRecentMessageIds.length} recent message${compactState.preservedRecentMessageIds.length === 1 ? "" : "s"}`,
        `${compactState.decisions.length} decision${compactState.decisions.length === 1 ? "" : "s"}`,
        `${compactState.openTasks.length} task${compactState.openTasks.length === 1 ? "" : "s"}`,
        `${compactState.preferences.length} preference${compactState.preferences.length === 1 ? "" : "s"}`,
        `${compactState.artifacts.length} artifact${compactState.artifacts.length === 1 ? "" : "s"}`,
      ].join(", ");
    }
    return nextState;
  });
  setChatNotice(
    preservedSummary
      ? `Context compacted. Preserved ${preservedSummary}, plus user intent and rationale.`
      : "Context compaction did not run because this thread was not found.",
  );
}

export function selectChatAgentAction({
  agentId,
  state,
  updateRuntimeState,
  setComposer,
  setChatNotice,
  setAttachments,
}: {
  agentId: string;
  state: ResonantShellState;
  updateRuntimeState: RuntimeStateUpdater;
  setComposer: SetComposer;
  setChatNotice: SetNotice;
  setAttachments: SetAttachments;
}): void {
  const nextThread = state.conversationThreads.find((thread) => thread.owningAgentId === agentId);
  if (!nextThread) {
    setChatNotice("No chat thread exists for that agent yet.");
    return;
  }

  activateChatThread(nextThread.id, updateRuntimeState, setComposer, setChatNotice, setAttachments);
}

export function stopChatGenerationAction({
  chatBusy,
  activeThread,
  activeChatRunTokenRef,
  updateRuntimeState,
  setChatBusy,
  setChatRunPhase,
  setAgentActivityLabel,
  setChatNotice,
}: {
  chatBusy: boolean;
  activeThread: ConversationThread | null;
  activeChatRunTokenRef: MutableRefObject<string | null>;
  updateRuntimeState: RuntimeStateUpdater;
  setChatBusy: (value: boolean) => void;
  setChatRunPhase: (value: ChatRunPhase) => void;
  setAgentActivityLabel: (value: string) => void;
  setChatNotice: SetNotice;
}): void {
  if (!chatBusy || !activeThread) {
    return;
  }

  const stoppedRunToken = activeChatRunTokenRef.current;
  activeChatRunTokenRef.current = null;
  if (stoppedRunToken) {
    void abortProviderServiceChatCompletion(stoppedRunToken);
  }

  updateRuntimeState((draft) => {
    const targetThread = draft.conversationThreads.find((thread) => thread.id === activeThread.id);
    if (!targetThread) {
      return draft;
    }
    const interruptedMessage: ConversationMessage = {
      id: `${targetThread.id}:m${targetThread.messages.length + 1}`,
      threadId: targetThread.id,
      channelId: targetThread.channelId,
      role: "assistant",
      author:
        targetThread.owningAgentId === draft.recoverySession.engineerAgentId
          ? draft.agents.find((agent) => agent.id === draft.recoverySession.engineerAgentId)?.displayName ?? "Resonant Engineer Agent"
          : draft.strategistIdentity.customName ?? draft.strategistIdentity.defaultName,
      content: "Response stopped by the user before a complete reply was returned.",
      createdAt: new Date().toISOString(),
      status: "interrupted",
    };
    targetThread.messages = [...targetThread.messages, interruptedMessage];
    return appendTranscriptEvent(draft, {
      action: "generation-interrupted",
      threadId: interruptedMessage.threadId,
      channelId: interruptedMessage.channelId,
      messageId: interruptedMessage.id,
      role: interruptedMessage.role,
      agentId: targetThread.owningAgentId,
      payload: messageTranscriptPayload(interruptedMessage),
    });
  });
  setChatBusy(false);
  setChatRunPhase("interrupted");
  setAgentActivityLabel("Response interrupted. You can send the correction now.");
  setChatNotice("Response interrupted. Partial assistant message kept in the chat.");
}
