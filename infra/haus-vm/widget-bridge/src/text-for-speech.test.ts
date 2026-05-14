import { describe, expect, test } from "bun:test";
import { stripStageDirections } from "./server";

describe("stripStageDirections", () => {
  test("drops a single parenthesised stage direction", () => {
    const out = stripStageDirections("(A pause.) Mister Stevens. Out.");
    expect(out).toBe("Mister Stevens. Out.");
  });

  test("drops multiple parenthesised blocks, including multi-line ones", () => {
    const out = stripStageDirections(
      "(A pause. A slow,\ndeliberate turn of the head.)\n\nMister Stevens. It's going.\n\n(Another pause.) I propose a 1-3-1.",
    );
    expect(out).toBe("Mister Stevens. It's going. I propose a 1-3-1.");
  });

  test("drops square-bracketed metadata such as [whispered]", () => {
    const out = stripStageDirections("[whispered] Mister Stevens. [end]");
    expect(out).toBe("Mister Stevens.");
  });

  test("keeps the content of markdown emphasis but removes the markers", () => {
    expect(stripStageDirections("Move *now*.")).toBe("Move now.");
    expect(stripStageDirections("That is **the** point.")).toBe("That is the point.");
  });

  test("returns an empty string when the input is only parens/brackets", () => {
    expect(stripStageDirections("(A pause.)")).toBe("");
    expect(stripStageDirections("(A pause.)\n[silence]")).toBe("");
  });

  test("asterisks are treated as markdown emphasis, not stage direction", () => {
    // Stage directions in the Zorin persona arrive in parens. Asterisks
    // are reserved for markdown emphasis (rare in conversational replies
    // but possible in framework explanations like "*Buy Back* the time").
    // Strip markers, keep content.
    expect(stripStageDirections("*beat*")).toBe("beat");
    expect(stripStageDirections("Use *Buy Back* the framework.")).toBe(
      "Use Buy Back the framework.",
    );
  });

  test("collapses extra whitespace left after stripping", () => {
    expect(stripStageDirections("Hello    (pause)   world  .")).toBe("Hello world .");
  });

  test("preserves ellipses and other Zorin-cadence punctuation", () => {
    expect(stripStageDirections("It's… going. (pause) That is… that.")).toBe(
      "It's… going. That is… that.",
    );
  });

  test("handles the canonical Zorin reply from the live model", () => {
    const sample = [
      "(A pause. A slow, deliberate turn of the head. The voice is low, almost a murmur.)",
      "",
      "Mister Stevens. It's going. Like a very complex clock, meticulously assembled.",
      "",
      "(A faint smile, almost imperceptible.)",
      "",
      "Out.",
    ].join("\n");
    const out = stripStageDirections(sample);
    expect(out).toBe(
      "Mister Stevens. It's going. Like a very complex clock, meticulously assembled. Out.",
    );
    expect(out).not.toContain("(");
    expect(out).not.toContain(")");
  });
});
