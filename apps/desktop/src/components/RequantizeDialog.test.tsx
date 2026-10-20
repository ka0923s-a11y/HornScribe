import { describe, expect, it } from "vitest";
import { requantizeSeed } from "./RequantizeDialog";

const doc = (quantizationSettings: Record<string, unknown>) => ({
  content: { quantizationSettings },
});

describe("requantizeSeed (#424)", () => {
  it("normalizes stored enum triplet values to the RPC vocabulary", () => {
    // Payloads store TripletPolicy.value ("always"/"never"); the
    // dialog options are keyed in the RPC vocabulary ("allow"/"none").
    expect(requantizeSeed(doc({ triplets: "always" }))?.triplets).toBe(
      "allow",
    );
    expect(requantizeSeed(doc({ triplets: "never" }))?.triplets).toBe(
      "none",
    );
    expect(requantizeSeed(doc({ triplets: "auto" }))?.triplets).toBe(
      "auto",
    );
  });

  it("defaults missing fields and ignores malformed payloads", () => {
    expect(requantizeSeed(doc({}))).toEqual({
      minDurationQl: "1/4",
      triplets: "auto",
      simplicity: "standard",
    });
    expect(requantizeSeed(null)).toBeNull();
    expect(requantizeSeed({ content: "nope" })).toBeNull();
  });
});
