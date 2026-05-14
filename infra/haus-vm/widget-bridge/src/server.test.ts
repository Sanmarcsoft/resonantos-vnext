/**
 * Smoke tests for the widget-bridge HTTP contract.
 *
 * These tests exist to prevent silent breakage of the wire contract that
 * `claude-peers-mcp/bridge.ts` relies on, and to lock in the security
 * hardening (auth gate, body cap, input validation, host allowlist,
 * security headers).
 *
 * Run with: bun test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { StubHermesClient, resolveProfile } from "./hermes-client";
import { assertBootSafety, bearerTokenOk, parseChatRequest } from "./server";

describe("assertBootSafety", () => {
  test("throws when NODE_ENV=production and BRIDGE_TOKEN is empty", () => {
    expect(() => assertBootSafety({ NODE_ENV: "production", BRIDGE_TOKEN: "" })).toThrow(
      /BRIDGE_TOKEN/,
    );
  });

  test("passes when NODE_ENV=production and BRIDGE_TOKEN is set", () => {
    expect(() =>
      assertBootSafety({ NODE_ENV: "production", BRIDGE_TOKEN: "real-token" }),
    ).not.toThrow();
  });

  test("passes in development with empty BRIDGE_TOKEN", () => {
    expect(() => assertBootSafety({ NODE_ENV: "development", BRIDGE_TOKEN: "" })).not.toThrow();
  });

  test("passes in test with empty BRIDGE_TOKEN", () => {
    expect(() => assertBootSafety({ NODE_ENV: "test", BRIDGE_TOKEN: "" })).not.toThrow();
  });
});

describe("bearerTokenOk (constant-time compare)", () => {
  test("accepts matching bearer", () => {
    expect(bearerTokenOk("Bearer correct-secret", "correct-secret")).toBe(true);
  });

  test("rejects mismatched bearer", () => {
    expect(bearerTokenOk("Bearer wrong", "correct-secret")).toBe(false);
  });

  test("rejects when token has different length", () => {
    expect(bearerTokenOk("Bearer s", "correct-secret")).toBe(false);
  });

  test("rejects missing Bearer prefix", () => {
    expect(bearerTokenOk("correct-secret", "correct-secret")).toBe(false);
  });

  test("when expected is empty, returns true (open mode for non-prod)", () => {
    expect(bearerTokenOk("", "")).toBe(true);
    expect(bearerTokenOk("Bearer anything", "")).toBe(true);
  });
});

describe("resolveProfile (wire-id translation)", () => {
  test("maps legacy zorin001 to the canonical zorin profile", () => {
    expect(resolveProfile("zorin001")).toBe("zorin");
  });

  test("passes through unknown ids unchanged", () => {
    expect(resolveProfile("zorin")).toBe("zorin");
    expect(resolveProfile("anything-else")).toBe("anything-else");
  });
});

describe("parseChatRequest (wire-shape adapter)", () => {
  test("accepts simple {botId, message} shape", () => {
    const r = parseChatRequest({ botId: "zorin", message: "hi" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.message).toBe("hi");
  });

  test("accepts legacy {botId, messages:[{role,content}]} shape used by bridge.ts", () => {
    const r = parseChatRequest({
      botId: "zorin001",
      messages: [{ role: "user", content: "what's the status" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.botId).toBe("zorin001");
      expect(r.value.message).toBe("what's the status");
    }
  });

  test("when both shapes are present, prefers `message` field", () => {
    const r = parseChatRequest({
      botId: "zorin",
      message: "explicit",
      messages: [{ role: "user", content: "from-array" }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.message).toBe("explicit");
  });

  test("rejects botId that fails the regex", () => {
    const r = parseChatRequest({ botId: "Zorin", message: "hi" });
    expect(r.ok).toBe(false);
  });

  test("rejects oversized message", () => {
    const long = "x".repeat(8001);
    const r = parseChatRequest({ botId: "zorin", message: long });
    expect(r.ok).toBe(false);
  });

  test("rejects message with control characters", () => {
    const r = parseChatRequest({ botId: "zorin", message: "hi\x01there" });
    expect(r.ok).toBe(false);
  });

  test("rejects malformed conversationId", () => {
    const r = parseChatRequest({ botId: "zorin", message: "hi", conversationId: "bad/slash" });
    expect(r.ok).toBe(false);
  });

  test("rejects malformed caller", () => {
    const r = parseChatRequest({ botId: "zorin", message: "hi", caller: "bad space" });
    expect(r.ok).toBe(false);
  });

  test("rejects empty messages array (no user turn)", () => {
    const r = parseChatRequest({ botId: "zorin", messages: [] });
    expect(r.ok).toBe(false);
  });
});

describe("StubHermesClient", () => {
  test("returns ok=true for the canonical zorin profile", async () => {
    const c = new StubHermesClient();
    const res = await c.chat({ botId: "zorin", message: "hello" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.reply).toContain("zorin");
      expect(res.reply).toContain("hello");
      expect(typeof res.conversationId).toBe("string");
      expect(res.conversationId.length).toBeGreaterThan(0);
    }
  });

  test("default profile set is zorin-only (no m/007/q/moneypenny)", async () => {
    const c = new StubHermesClient();
    const profiles = await c.listProfiles();
    expect(profiles.ready).toEqual(["zorin"]);
  });

  test("returns profile-not-found for the legacy raw zorin001 (must be resolved before client)", async () => {
    const c = new StubHermesClient();
    const res = await c.chat({ botId: "zorin001", message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("profile-not-found");
  });

  test("echoes the supplied conversationId when provided", async () => {
    const c = new StubHermesClient();
    const res = await c.chat({ botId: "zorin", message: "status?", conversationId: "fixed-id-123" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.conversationId).toBe("fixed-id-123");
  });
});

describe("HTTP server contract", () => {
  let url = "";
  let stop: (() => void) | null = null;

  beforeAll(async () => {
    process.env["HERMES_MODE"] = "stub";
    process.env["NODE_ENV"] = "test";
    delete process.env["BRIDGE_TOKEN"];
    const { startServer } = (await import("./server")) as typeof import("./server");
    const srv = startServer({ port: 0, hostname: "127.0.0.1" });
    url = `http://127.0.0.1:${srv.port}`;
    stop = () => srv.stop();
  });

  afterAll(() => {
    if (stop) stop();
  });

  test("POST /api/widget/chat accepts legacy botId=zorin001 and routes it to the zorin profile", async () => {
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "haus.matthewstevens.org" },
      body: JSON.stringify({ botId: "zorin001", message: "hello" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["botId"]).toBe("zorin001");
    expect(typeof body["reply"]).toBe("string");
    expect(typeof body["conversationId"]).toBe("string");
    expect(typeof body["latencyMs"]).toBe("number");
  });

  test("POST /api/widget/chat accepts the legacy bridge.ts payload (messages array)", async () => {
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "haus.matthewstevens.org" },
      body: JSON.stringify({
        botId: "zorin001",
        messages: [{ role: "user", content: "ping" }],
      }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["reply"]).toContain("ping");
  });

  test("POST /api/widget/chat also accepts the canonical botId=zorin", async () => {
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      body: JSON.stringify({ botId: "zorin", message: "hi" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["botId"]).toBe("zorin");
  });

  test("POST /api/widget/chat rejects malformed bodies with 400", async () => {
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      body: JSON.stringify({ botId: "zorin" }),
    });
    expect(r.status).toBe(400);
  });

  test("POST /api/widget/chat returns 404 for unknown botId", async () => {
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      body: JSON.stringify({ botId: "no-such-profile", message: "hi" }),
    });
    expect(r.status).toBe(404);
  });

  test("POST /api/widget/chat rejects oversized body with 413", async () => {
    // Build a real >32 KB body. Message length cap (8000) is checked AFTER
    // the Content-Length cap, but the wire-level body cap must fire first.
    const padding = "x".repeat(40_000);
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      body: JSON.stringify({ botId: "zorin", message: "hi", _pad: padding }),
    });
    expect(r.status).toBe(413);
  });

  test("POST /api/widget/chat rejects disallowed Host with 403", async () => {
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      headers: { host: "attacker.example.com" },
      body: JSON.stringify({ botId: "zorin", message: "hi" }),
    });
    expect(r.status).toBe(403);
  });

  test("response sets the standard security headers", async () => {
    const r = await fetch(`${url}/livez`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("GET /livez always returns 200 ok without leaking profile state", async () => {
    const r = await fetch(`${url}/livez`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(body["profilesReady"]).toBeUndefined();
    expect(body["version"]).toBeUndefined();
  });

  test("GET /health unauthenticated returns minimal payload only", async () => {
    const r = await fetch(`${url}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    // No profile or version leakage on the unauth view.
    expect(body["profilesReady"]).toBeUndefined();
    expect(body["version"]).toBeUndefined();
  });
});
