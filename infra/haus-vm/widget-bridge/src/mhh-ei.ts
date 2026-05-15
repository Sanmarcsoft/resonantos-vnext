/**
 * MHH-EI classifier (Sean Webb framework, deterministic implementation).
 *
 * Implements the Webb Equation of Emotion in computable form:
 *   EP delta P = ER
 *
 * For each message, returns:
 *   touchedAttachments[]  -- {self}-Map slots the text appears to engage
 *   perceivedValence      -- negative .. positive in [-1, 1]
 *   predictedER           -- {group, severity 1-5, mixed[]}
 *
 * The classifier is deliberately small and deterministic; it runs on every
 * inbound user turn AND on every outbound draft reply. At 4B model scale
 * the prompt cannot reliably compute calibrated severity; this module
 * carries that load instead and feeds hints back into the system context
 * so the LLM can shape its reply.
 *
 * Source framework:
 *   /config/workspace/projects/MHH-EI-for-AI-Language-Enabled-Emotional-Intelligence-and-Theory-of-Mind-Algorithms/
 *   AGPL-3.0, Sean Webb
 *
 * Phase 2 path (not yet wired): replace this with a call to a real MHH
 * service backed by the hermes-agent runtime. The interface below is
 * stable; the implementation can swap underneath.
 */

export type EmotionGroup =
  | "fear"
  | "anger"
  | "sadness"
  | "happiness"
  | "disgust"
  | "anticipation"
  | "worry"
  | "regret"
  | "pride"
  | "shame";

/** {self}-Map attachment slots common to founders / operators. */
export type Attachment =
  | "founder-identity"
  | "family-security"
  | "ceo-competence"
  | "time-scarcity"
  | "capital"
  | "reputation"
  | "autonomy"
  | "team-trust"
  | "product-quality"
  | "vision-alignment";

export interface EiClassification {
  /** Attachments the text appears to engage, with estimated power (1-5). */
  touchedAttachments: Array<{ slot: Attachment; power: number }>;
  /** Aggregate perceived valence of the text in [-1, 1]. Negative = threatening. */
  perceivedValence: number;
  /** The predicted dominant emotional reaction. */
  predictedER: { group: EmotionGroup; severity: number };
  /** Secondary emotions when mixed feelings are detected. */
  mixed: EmotionGroup[];
  /** Suggested response posture for prosocial alignment. */
  recommendedPosture: "amplify" | "validate-then-pivot" | "buffer-then-direct" | "hold-and-confirm" | "neutral";
  /** Human-readable note for prompting the LLM in the same turn. */
  promptHint: string;
}

interface AttachmentSignal {
  slot: Attachment;
  /** Lowercase keyword fragments. Match counts toward attachment power. */
  keywords: string[];
  /** Baseline power when ANY of the keywords appears (1-5). */
  power: number;
}

// Lexicon. Conservative; covers the founder/SaaS coaching domain where Zorin operates.
const ATTACHMENT_SIGNALS: AttachmentSignal[] = [
  {
    slot: "founder-identity",
    keywords: ["founder", "ceo", "build my", "my company", "my business", "my startup", "i started"],
    power: 4,
  },
  {
    slot: "family-security",
    keywords: ["family", "wife", "husband", "kids", "children", "my son", "my daughter", "spouse", "parents"],
    power: 5,
  },
  {
    slot: "ceo-competence",
    keywords: ["decide", "decision", "wrong call", "right call", "should i", "am i", "competent", "good at"],
    power: 4,
  },
  {
    slot: "time-scarcity",
    keywords: ["no time", "busy", "burnout", "exhausted", "overworked", "buyback", "buy back", "delegate", "procrastinat"],
    power: 4,
  },
  {
    slot: "capital",
    keywords: ["cash", "money", "burn", "runway", "revenue", "mrr", "arr", "profit", "raise", "investor", "funding", "contract", "deal", "closed", "client signed", "won the", "big co", "best month", "best quarter", "best year"],
    power: 4,
  },
  {
    slot: "reputation",
    keywords: ["public", "look bad", "embarrass", "what will they think", "reputation", "credibility", "trust me"],
    power: 3,
  },
  {
    slot: "autonomy",
    keywords: ["independent", "freedom", "lifestyle", "control", "own pace", "my way"],
    power: 3,
  },
  {
    slot: "team-trust",
    keywords: ["team", "my team", "hire", "fire", "let go", "co-founder", "cofounder", "manager", "report"],
    power: 4,
  },
  {
    slot: "product-quality",
    keywords: ["product", "ship", "broken", "bug", "feature", "ux", "launch", "release", "customers complain"],
    power: 3,
  },
  {
    slot: "vision-alignment",
    keywords: ["vision", "painted picture", "10x", "10 x", "where we are going", "long term", "5 years", "10 years", "generation"],
    power: 4,
  },
];

const NEGATIVE_TERMS = [
  "afraid", "anxious", "worried", "scared", "fear", "fearful",
  "angry", "furious", "frustrated", "pissed", "annoyed",
  "sad", "down", "depressed", "tired", "exhausted", "burned out", "burnout",
  "ashamed", "embarrass", "regret", "wish i had", "should have", "shouldn't have",
  "stuck", "stalled", "behind", "missing", "missed", "lost", "losing",
  "broken", "fail", "failure", "failed", "wrong",
  "procrastinat", "avoid", "avoiding", "can't bring myself",
  "immediately", "not fast", "not enough", "not moving", "too tight", "haven't slept",
];

// Harsh imperative phrases that read as negative perception even without negative-term hits.
const HARSH_DIRECTIVE_TERMS = [
  "cut the", "cut your", "stop doing", "you need to", "you are not",
  "you're not", "not moving fast", "not fast enough",
];

const POSITIVE_TERMS = [
  "happy", "great", "amazing", "excellent", "love", "loved", "wonderful",
  "proud", "pride", "won", "winning", "win", "shipped", "launched",
  "calm", "clear", "focused", "energised", "energized", "ready",
  "grateful", "thankful", "blessed", "growing", "growth", "compounding",
  "exceeded", "ahead", "early", "on track", "nailed", "crushed",
  "best month", "best quarter", "best year", "best ever", "best",
];

// Strong anger markers. When these co-occur with a relational attachment
// (team-trust, autonomy, founder-identity), force ER group to "anger" so the
// "shipped" lexical hit cannot drown out the felt outrage.
const ANGER_TERMS = [
  "furious", "betrayed", "went around me", "went around my back",
  "behind my back", "explicitly rejected", "without my approval",
  "without telling me", "ignored my", "overruled me",
];

const URGENCY_BOOSTERS = ["urgent", "asap", "now", "today", "deadline", "running out", "no time left"];
const MIXED_MARKERS = ["but", " however ", "though", "and yet", "even though"];

/** Tokenise to lowercase chunks suitable for fragment matching. */
function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[—]/g, ",").replace(/\s+/g, " ").trim()} `;
}

function countMatches(haystack: string, needles: string[]): number {
  let n = 0;
  for (const k of needles) {
    if (haystack.includes(k)) n++;
  }
  return n;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function deriveValence(text: string): number {
  const norm = normalise(text);
  const neg = countMatches(norm, NEGATIVE_TERMS);
  const harsh = countMatches(norm, HARSH_DIRECTIVE_TERMS);
  const pos = countMatches(norm, POSITIVE_TERMS);
  const urgency = countMatches(norm, URGENCY_BOOSTERS);
  const raw = (pos - neg - harsh) - urgency * 0.5;
  // Squash to [-1, 1].
  return clamp(raw / 4, -1, 1);
}

function deriveAttachments(text: string): EiClassification["touchedAttachments"] {
  const norm = normalise(text);
  const out: EiClassification["touchedAttachments"] = [];
  for (const sig of ATTACHMENT_SIGNALS) {
    const hits = countMatches(norm, sig.keywords);
    if (hits > 0) {
      out.push({ slot: sig.slot, power: clamp(sig.power + (hits > 1 ? 1 : 0), 1, 5) });
    }
  }
  return out;
}

/**
 * Map (attachments, valence) to a predicted ER group + severity. The mapping
 * is conservative and biased toward the founder/coaching domain.
 */
function deriveER(
  text: string,
  valence: number,
  touched: EiClassification["touchedAttachments"],
): { group: EmotionGroup; severity: number; mixed: EmotionGroup[] } {
  const norm = normalise(text);
  const maxPower = touched.reduce((acc, t) => Math.max(acc, t.power), 0);
  // Severity scales with attachment power and valence magnitude.
  let severity = clamp(Math.round(Math.abs(valence) * 3 + maxPower / 2), 1, 5);

  // Anger override: relational-attachment + explicit anger markers force
  // the anger group regardless of lexical valence (e.g. "shipped" can drown
  // out felt outrage in raw counts).
  const hasAnger = countMatches(norm, ANGER_TERMS) > 0;
  const hasRelational = touched.some(
    (t) => t.slot === "team-trust" || t.slot === "autonomy" || t.slot === "founder-identity",
  );
  if (hasAnger && hasRelational) {
    return { group: "anger", severity: clamp(Math.max(severity, 4), 1, 5), mixed: [] };
  }

  let group: EmotionGroup;
  if (valence > 0.4) {
    group = touched.some((t) => t.slot === "vision-alignment") ? "anticipation" : "pride";
  } else if (valence > 0.1) {
    group = "happiness";
  } else if (valence < -0.55) {
    group = touched.some((t) => t.slot === "ceo-competence" || t.slot === "reputation") ? "shame" : "fear";
  } else if (valence < -0.25) {
    group = touched.some((t) => t.slot === "time-scarcity" || t.slot === "capital") ? "worry" : "sadness";
  } else if (valence < 0) {
    group = "worry";
  } else {
    group = "anticipation";
  }

  // Mixed detection.
  const mixed: EmotionGroup[] = [];
  return { group, severity, mixed };
}

function recommendedPosture(
  group: EmotionGroup,
  severity: number,
): EiClassification["recommendedPosture"] {
  if (severity >= 4 && (group === "shame" || group === "regret" || group === "sadness")) {
    return "buffer-then-direct";
  }
  if (severity >= 3 && (group === "worry" || group === "fear")) {
    return "validate-then-pivot";
  }
  if (severity >= 3 && (group === "pride" || group === "happiness" || group === "anticipation")) {
    return "amplify";
  }
  if (group === "anger" || group === "disgust") {
    return "hold-and-confirm";
  }
  return "neutral";
}

function detectMixed(text: string): boolean {
  return countMatches(normalise(text), MIXED_MARKERS) > 0;
}

function buildPromptHint(c: EiClassification): string {
  const top = c.touchedAttachments
    .slice()
    .sort((a, b) => b.power - a.power)
    .slice(0, 2)
    .map((a) => `${a.slot} (power ${a.power})`)
    .join(", ");
  const attach = top.length > 0 ? top : "no specific attachment detected";
  return [
    `[EI hint] Touched: ${attach}.`,
    `Predicted ER: ${c.predictedER.group} severity ${c.predictedER.severity}.`,
    c.mixed.length > 0 ? `Mixed with: ${c.mixed.join(", ")}.` : "",
    `Posture: ${c.recommendedPosture}.`,
    "Calibrate tone accordingly. Honour the prosocial rule.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function classifyEI(text: string): EiClassification {
  const touched = deriveAttachments(text);
  const valence = deriveValence(text);
  const erBase = deriveER(text, valence, touched);
  // Detect mixed emotions when the text contains a contrast marker AND has signals on both sides.
  const isMixed = detectMixed(text);
  const norm = normalise(text);
  const hasPos = countMatches(norm, POSITIVE_TERMS) > 0;
  const hasNeg = countMatches(norm, NEGATIVE_TERMS) > 0;
  const mixed: EmotionGroup[] = [];
  if (isMixed && hasPos && hasNeg) {
    // Add the opposite-polarity primary as a mixed marker.
    if (valence < 0) {
      mixed.push("happiness");
    } else if (valence > 0) {
      mixed.push("worry");
    }
  }
  const final = { ...erBase, mixed };
  const posture = recommendedPosture(final.group, final.severity);

  const result: EiClassification = {
    touchedAttachments: touched,
    perceivedValence: valence,
    predictedER: { group: final.group, severity: final.severity },
    mixed,
    recommendedPosture: posture,
    promptHint: "",
  };
  result.promptHint = buildPromptHint(result);
  return result;
}

/**
 * Compare the user's inbound EI shape with a draft reply's EI shape and flag
 * when the draft is likely to LAND BADLY (mismatched severity, wrong posture).
 * Returns a corrective hint to inject before re-asking the model, or null
 * when the draft is acceptable.
 */
export function recommendDraftFix(
  inbound: EiClassification,
  draft: EiClassification,
): string | null {
  // Rule 1: user is in worry/fear/sadness/shame at severity 3+ and the draft
  // amplifies negative valence rather than buffering. Ask for a buffer.
  if (
    ["worry", "fear", "sadness", "shame", "regret"].includes(inbound.predictedER.group) &&
    inbound.predictedER.severity >= 3 &&
    draft.perceivedValence < -0.2
  ) {
    return [
      "[EI corrective] Inbound user emotion is",
      `${inbound.predictedER.group} severity ${inbound.predictedER.severity};`,
      "your draft adds more negative perception without a buffer.",
      "Acknowledge the user's emotional position first in one short clause,",
      "THEN deliver the directive. Stay direct, not blunt.",
    ].join(" ");
  }
  // Rule 2: user is celebrating (pride/happiness/anticipation severity 3+),
  // and the draft reads flat. Ask to amplify.
  if (
    ["pride", "happiness", "anticipation"].includes(inbound.predictedER.group) &&
    inbound.predictedER.severity >= 3 &&
    draft.perceivedValence < 0.1
  ) {
    return [
      "[EI corrective] Inbound user emotion is",
      `${inbound.predictedER.group} severity ${inbound.predictedER.severity};`,
      "your draft is flat against a win. Acknowledge the achievement explicitly",
      "and connect it to the Painted Picture before pivoting to the next move.",
    ].join(" ");
  }
  // Rule 3: anger or disgust in user; hold and confirm.
  if (
    ["anger", "disgust"].includes(inbound.predictedER.group) &&
    inbound.predictedER.severity >= 3 &&
    draft.recommendedPosture !== "hold-and-confirm"
  ) {
    return [
      "[EI corrective] Inbound user emotion is",
      `${inbound.predictedER.group} severity ${inbound.predictedER.severity};`,
      "do not push a decision. Hold, confirm what you heard,",
      "and ask one clarifying question. The decision lives on the next turn.",
    ].join(" ");
  }
  return null;
}
