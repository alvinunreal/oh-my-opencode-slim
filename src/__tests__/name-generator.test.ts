import { afterEach, describe, expect, test } from "bun:test";

import { generatePlanName } from "../name-generator";

const originalRandom = Math.random;

afterEach(() => {
  Math.random = originalRandom;
});

describe("generatePlanName", () => {
  test("returns a three-segment kebab-case name", () => {
    const name = generatePlanName();
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  test("generates 100 unique names", () => {
    const values: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const adjectiveIndex = i % 50;
      const gerundIndex = Math.floor(i / 50) % 50;
      const nounIndex = Math.floor(i / 2500) % 50;
      values.push((adjectiveIndex + 0.1) / 50);
      values.push((gerundIndex + 0.1) / 50);
      values.push((nounIndex + 0.1) / 50);
    }

    let cursor = 0;
    Math.random = () => {
      const value = values[cursor % values.length];
      cursor += 1;
      return value;
    };

    const names = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      names.add(generatePlanName());
    }

    expect(names.size).toBe(100);
  });

  test("returns lowercase alpha-only segments", () => {
    const [adjective, gerund, noun] = generatePlanName().split("-");
    expect(adjective).toMatch(/^[a-z]+$/);
    expect(gerund).toMatch(/^[a-z]+$/);
    expect(noun).toMatch(/^[a-z]+$/);
  });
});
