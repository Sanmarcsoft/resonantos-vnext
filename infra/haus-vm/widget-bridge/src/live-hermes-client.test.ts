/**
 * Tests for the LiveHermesClient. fetch is injected so no network calls fire.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { LiveHermesClient } from "./live-hermes-client";

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  LiveHermesClient._clearConversationCache();
});

describe("LiveHermesClient", () => {
  test("posts to {providerUrl}/chat/completions with bearer auth and a Zorin system prompt", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetcher = async (url: string | URL, init?: RequestInit) => {
      captured = { url: String(url), init: init ?? {} };
      return ok({ choices: [{ message: { content: "Zorin online. Out." } }], model: "test-model" });
    };
    const client = new LiveHermesClient({
      providerUrl: "https://example.test/v1",
      providerKey: "k-test",
      model: "test-model",
      fetcher: fetcher as typeof fetch,
      eiEnabled: false,
    });

    const res = await client.chat({ botId: "zorin", message: "hello" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reply).toBe("Zorin online. Out.");
      expect(res.model).toBe("test-model");
      expect(typeof res.conversationId).toBe("string");
    }

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://example.test/v1/chat/completions");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer k-test");
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe("test-model");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Max Zorin");
    expect(body.messages[body.messages.length - 1]).toEqual({ role: "user", content: "hello" });
  });

  test("preserves conversationId and accumulates history across turns", async () => {
    const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetcher = async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      calls.push({ messages: body.messages });
      const turn = calls.length;
      return ok({ choices: [{ message: { content: `reply-${turn}` } }], model: "m" });
    };
    const client = new LiveHermesClient({
      providerUrl: "https://x.test/v1",
      providerKey: "k",
      model: "m",
      fetcher: fetcher as typeof fetch,
      eiEnabled: false,
    });

    const r1 = await client.chat({ botId: "zorin", message: "one" });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = await client.chat({ botId: "zorin", message: "two", conversationId: r1.conversationId });
    expect(r2.ok).toBe(true);

    expect(calls[0]!.messages.map((m) => m.content)).toEqual([calls[0]!.messages[0]!.content, "one"]);
    expect(calls[1]!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(calls[1]!.messages.at(-1)!.content).toBe("two");
    expect(calls[1]!.messages.at(-2)!.content).toBe("reply-1");
  });

  test("rejects unknown profile with profile-not-found", async () => {
    const client = new LiveHermesClient({ providerKey: "k", fetcher: (async () => ok({})) as unknown as typeof fetch });
    const r = await client.chat({ botId: "nobody", message: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("profile-not-found");
  });

  test("refuses to call provider when HERMES_PROVIDER_KEY is empty", async () => {
    let called = false;
    const fetcher = (async () => {
      called = true;
      return ok({});
    }) as unknown as typeof fetch;
    const client = new LiveHermesClient({ providerKey: "", fetcher });
    const r = await client.chat({ botId: "zorin", message: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("runtime-error");
      expect(r.detail).toContain("HERMES_PROVIDER_KEY");
    }
    expect(called).toBe(false);
  });

  test("maps provider 5xx to runtime-error with detail snippet", async () => {
    const fetcher = (async () =>
      new Response("upstream blew up", { status: 503 })) as unknown as typeof fetch;
    const client = new LiveHermesClient({ providerKey: "k", fetcher });
    const r = await client.chat({ botId: "zorin", message: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("runtime-error");
      expect(r.detail).toContain("HTTP 503");
    }
  });

  test("maps empty choices to runtime-error", async () => {
    const fetcher = (async () => ok({ choices: [], model: "m" })) as unknown as typeof fetch;
    const client = new LiveHermesClient({ providerKey: "k", fetcher });
    const r = await client.chat({ botId: "zorin", message: "x" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("runtime-error");
  });

  test("listProfiles reports the configured set", async () => {
    const client = new LiveHermesClient({ providerKey: "k", knownProfiles: ["zorin"] });
    const p = await client.listProfiles();
    expect(p.ready).toEqual(["zorin"]);
  });

  test("injects an EI hint system message just before the user turn when eiEnabled", async () => {
    let captured: { messages: Array<{ role: string; content: string }> } | null = null;
    const fetcher = (async (_url: string | URL, init?: RequestInit) => {
      captured = JSON.parse((init?.body as string) ?? "{}");
      return ok({ choices: [{ message: { content: "Acknowledged. Out." } }], model: "m" });
    }) as unknown as typeof fetch;

    const client = new LiveHermesClient({ providerKey: "k", fetcher });
    const r = await client.chat({
      botId: "zorin",
      message: "I'm worried my runway is too tight. I haven't slept in two weeks.",
    });
    expect(r.ok).toBe(true);
    expect(captured).not.toBeNull();
    const roles = captured!.messages.map((m) => m.role);
    expect(roles).toEqual(["system", "system", "user"]);
    expect(captured!.messages[1]!.content).toContain("[EI hint]");
    expect(captured!.messages[1]!.content).toMatch(/worry|fear|sadness/);
  });

  test("re-asks once when the draft mis-fits the inbound EI shape", async () => {
    let callCount = 0;
    const replies = [
      "Cut the marketing spend immediately. You are not moving fast enough.",
      "I hear the runway is tight. Trim non-essential spend by month-end. Then we sprint. Out.",
    ];
    const seen: Array<Array<{ role: string; content: string }>> = [];
    const fetcher = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      seen.push(body.messages);
      const reply = replies[callCount] ?? "fallback";
      callCount += 1;
      return ok({ choices: [{ message: { content: reply } }], model: "m" });
    }) as unknown as typeof fetch;

    const client = new LiveHermesClient({ providerKey: "k", fetcher });
    const r = await client.chat({
      botId: "zorin",
      message: "I'm worried my runway is too tight. I haven't slept in two weeks.",
    });
    expect(callCount).toBe(2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reply).toContain("I hear the runway");
    // The retry call should contain the previous draft as assistant + a corrective system note.
    const retry = seen[1]!;
    expect(retry.some((m) => m.role === "assistant" && m.content.startsWith("Cut the marketing"))).toBe(true);
    expect(retry.some((m) => m.role === "system" && m.content.includes("[EI corrective]"))).toBe(true);
  });

  test("does not re-ask when draft already aligns with inbound", async () => {
    let callCount = 0;
    const fetcher = (async () => {
      callCount += 1;
      return ok({
        choices: [{ message: { content: "Excellent work. Carry that momentum into the quarterly review. Out." } }],
        model: "m",
      });
    }) as unknown as typeof fetch;
    const client = new LiveHermesClient({ providerKey: "k", fetcher });
    const r = await client.chat({ botId: "zorin", message: "Quick status: shipped the dashboard. Calm week." });
    expect(r.ok).toBe(true);
    expect(callCount).toBe(1);
  });
});
