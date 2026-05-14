/**
 * Smoke tests for the widget-bridge HTTP contract.
 *
 * These tests exist to prevent silent breakage of the wire contract that
 * `claude-peers-mcp/bridge.ts` relies on. They DO NOT test the Hermes runtime
 * itself; that is the responsibility of the Hermes Agent project upstream.
 *
 * Run with: bun test
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { StubHermesClient } from "./hermes-client";

import { resolveProfile } from "./hermes-client";

describe("resolveProfile (wire-id translation)", () => {
  test("maps legacy zorin001 to the canonical zorin profile", () => {
    expect(resolveProfile("zorin001")).toBe("zorin");
  });

  test("passes through unknown ids unchanged", () => {
    expect(resolveProfile("zorin")).toBe("zorin");
    expect(resolveProfile("anything-else")).toBe("anything-else");
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

  test("returns ok=false / profile-not-found for the legacy raw zorin001 (must be resolved before client)", async () => {
    const c = new StubHermesClient();
    const res = await c.chat({ botId: "zorin001", message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("profile-not-found");
    }
  });

  test("returns ok=false / profile-not-found for an unknown profile", async () => {
    const c = new StubHermesClient();
    const res = await c.chat({ botId: "nonexistent", message: "hi" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("profile-not-found");
    }
  });

  test("echoes the supplied conversationId when provided", async () => {
    const c = new StubHermesClient();
    const res = await c.chat({
      botId: "zorin",
      message: "status?",
      conversationId: "fixed-id-123",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.conversationId).toBe("fixed-id-123");
    }
  });

  test("listProfiles returns the configured set", async () => {
    const c = new StubHermesClient(["zorin"]);
    const got = await c.listProfiles();
    expect(got.ready).toEqual(["zorin"]);
    expect(got.missing).toEqual([]);
  });
});

describe("HTTP server contract", () => {
  // Boot once for the suite. The server module is a singleton (Bun.serve at
  // top-level), so we import it a single time and share the URL across tests.
  // The url uses 127.0.0.1 because the bound hostname is 0.0.0.0, which is a
  // wildcard, not a connect target.
  let url = "";
  let stop: (() => void) | null = null;

  beforeAll(async () => {
    process.env["PORT"] = "0";
    process.env["HERMES_MODE"] = "stub";
    delete process.env["BRIDGE_TOKEN"];
    const mod = (await import("./server")) as {
      server: { hostname: string; port: number; stop: () => void };
    };
    url = `http://127.0.0.1:${mod.server.port}`;
    stop = () => mod.server.stop();
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
    // Wire contract: caller sent zorin001, response echoes the same id so the
    // legacy bridge.ts sees no change.
    expect(body["botId"]).toBe("zorin001");
    expect(typeof body["reply"]).toBe("string");
    expect(typeof body["conversationId"]).toBe("string");
    expect(typeof body["latencyMs"]).toBe("number");
  });

  test("POST /api/widget/chat also accepts the canonical botId=zorin", async () => {
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "zorin", message: "hi" }),
    });
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["botId"]).toBe("zorin");
  });

  test("GET /health reports profile state", async () => {
    const r = await fetch(`${url}/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as Record<string, unknown>;
    expect(body["status"]).toBe("ok");
    expect(Array.isArray(body["profilesReady"])).toBe(true);
  });

  test("POST /api/widget/chat rejects malformed bodies with 400", async () => {
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "zorin" }), // missing message
    });
    expect(r.status).toBe(400);
  });

  test("POST /api/widget/chat returns 404 for unknown botId", async () => {
    const r = await fetch(`${url}/api/widget/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botId: "does-not-exist", message: "hi" }),
    });
    expect(r.status).toBe(404);
  });
});
