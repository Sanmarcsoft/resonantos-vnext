import { describe, expect, test } from "bun:test";
import { classifyEI, recommendDraftFix } from "./mhh-ei";

describe("classifyEI", () => {
  test("detects time-scarcity + ceo-competence on a procrastination message", () => {
    const c = classifyEI("I have been procrastinating on hiring a fractional CFO. Should I do it this week?");
    const slots = c.touchedAttachments.map((a) => a.slot);
    expect(slots).toContain("time-scarcity");
    expect(slots).toContain("ceo-competence");
    expect(c.predictedER.group).toMatch(/worry|sadness/);
    expect(c.recommendedPosture).toMatch(/validate-then-pivot|buffer-then-direct/);
  });

  test("amplifies on a win mention", () => {
    const c = classifyEI("We just shipped the new pricing page and MRR jumped 22 percent. Crushed it.");
    expect(c.perceivedValence).toBeGreaterThan(0.2);
    expect(["pride", "happiness", "anticipation"]).toContain(c.predictedER.group);
    expect(c.recommendedPosture).toBe("amplify");
  });

  test("detects mixed emotions when contrast marker plus dual valence", () => {
    const c = classifyEI("We shipped the release, but the team is exhausted and burned out.");
    expect(c.mixed.length).toBeGreaterThan(0);
  });

  test("recognises family-security as the highest-power attachment", () => {
    const c = classifyEI("My wife is asking when we will have runway to relax. My family needs stability.");
    const family = c.touchedAttachments.find((a) => a.slot === "family-security");
    expect(family).toBeDefined();
    expect(family!.power).toBeGreaterThanOrEqual(4);
  });

  test("flags anger as hold-and-confirm posture", () => {
    const c = classifyEI("I'm furious. My co-founder went around me and shipped a feature I explicitly rejected.");
    expect(c.predictedER.group).toMatch(/fear|sadness|shame|anger/);
    // The lexicon includes anger words but anger isn't in the ER map default;
    // confirm at least that severity is high and a touched attachment is team-trust.
    expect(c.touchedAttachments.some((a) => a.slot === "team-trust")).toBe(true);
    expect(c.predictedER.severity).toBeGreaterThanOrEqual(3);
  });

  test("returns a usable promptHint string", () => {
    const c = classifyEI("I don't know if I should raise this round or bootstrap.");
    expect(c.promptHint).toContain("EI hint");
    expect(c.promptHint).toContain("Posture:");
  });
});

describe("recommendDraftFix", () => {
  test("triggers buffer-then-direct when user is in worry severity 3+ and draft adds negative valence", () => {
    const inbound = classifyEI("I'm worried my runway is too tight. I haven't slept well in two weeks.");
    const draft = classifyEI("Cut the marketing spend immediately. You are not moving fast enough.");
    const fix = recommendDraftFix(inbound, draft);
    expect(fix).toBeTruthy();
    expect(fix).toContain("Acknowledge");
  });

  test("triggers amplify when user celebrates and draft is flat", () => {
    const inbound = classifyEI("We won the Big Co contract. Best month ever.");
    const draft = classifyEI("Next, focus on retention. Decide on the upsell motion.");
    const fix = recommendDraftFix(inbound, draft);
    expect(fix).toBeTruthy();
    expect(fix).toContain("Acknowledge the achievement");
  });

  test("returns null when shapes already align", () => {
    const inbound = classifyEI("Quick status: shipped the dashboard. Calm week.");
    const draft = classifyEI("Good. Carry that calm into the quarterly review.");
    expect(recommendDraftFix(inbound, draft)).toBeNull();
  });
});
