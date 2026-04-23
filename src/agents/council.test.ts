import { describe, expect, test } from "bun:test";
import { formatCouncillorPrompt, formatCouncillorResults } from "./council";

describe("formatCouncillorResults", () => {
  const originalPrompt =
    "What is the best way to implement a REST API in TypeScript?";

  test("formats completed councillor results correctly", () => {
    const councillorResults = [
      {
        name: "alpha",
        model: "anthropic/claude-opus-4-6",
        status: "completed",
        result: "Use Express.js with TypeScript interfaces for type safety.",
      },
      {
        name: "beta",
        model: "openai/gpt-5.5",
        status: "completed",
        result:
          "Consider Fastify for better performance and built-in type validation.",
      },
    ];

    const formatted = formatCouncillorResults(
      originalPrompt,
      councillorResults
    );

    expect(formatted).toContain("**Original Prompt**:");
    expect(formatted).toContain(originalPrompt);
    expect(formatted).toContain("**alpha** (claude-opus-4-6):");
    expect(formatted).toContain("**beta** (gpt-5.5):");
    expect(formatted).toContain(
      "Use Express.js with TypeScript interfaces for type safety."
    );
    expect(formatted).toContain(
      "Consider Fastify for better performance and built-in type validation."
    );
    expect(formatted).toContain("**Councillor Responses**:");
    expect(formatted).toContain(
      "Synthesize the optimal response based on the above."
    );
    expect(formatted).not.toContain("**Failed/Timed-out Councillors**:");
  });

  test("includes failed councillors section when some fail", () => {
    const councillorResults = [
      {
        name: "alpha",
        model: "anthropic/claude-opus-4-6",
        status: "completed",
        result: "Use Express.js with TypeScript interfaces for type safety.",
      },
      {
        name: "beta",
        model: "openai/gpt-5.5",
        status: "timed_out",
        error: "Request timed out after 180000ms",
      },
      {
        name: "gamma",
        model: "google/gemini-pro",
        status: "failed",
        error: "Provider returned empty response",
      },
    ];

    const formatted = formatCouncillorResults(
      originalPrompt,
      councillorResults
    );

    expect(formatted).toContain("**Councillor Responses**:");
    expect(formatted).toContain("**alpha** (claude-opus-4-6):");
    expect(formatted).toContain(
      "Use Express.js with TypeScript interfaces for type safety."
    );
    expect(formatted).toContain("**Failed/Timed-out Councillors**:");
    expect(formatted).toContain(
      "**beta**: timed_out — Request timed out after 180000ms"
    );
    expect(formatted).toContain(
      "**gamma**: failed — Provider returned empty response"
    );
    expect(formatted).not.toContain("**beta** (gpt-5.5):");
    expect(formatted).not.toContain("**gamma** (gemini-pro):");
  });

  test("returns fallback message when all councillors fail", () => {
    const councillorResults = [
      {
        name: "alpha",
        model: "anthropic/claude-opus-4-6",
        status: "timeout",
        error: "Request timed out",
      },
      {
        name: "beta",
        model: "openai/gpt-5.5",
        status: "error",
        error: "Provider error",
      },
    ];

    const formatted = formatCouncillorResults(
      originalPrompt,
      councillorResults
    );

    expect(formatted).toContain("**Original Prompt**:");
    expect(formatted).toContain(originalPrompt);
    expect(formatted).toContain("**Councillor Responses**:");
    expect(formatted).toContain("All councillors failed to produce output:");
    expect(formatted).toContain("**alpha** (claude-opus-4-6):");
    expect(formatted).toContain("**beta** (gpt-5.5):");
    expect(formatted).toContain("Request timed out");
    expect(formatted).toContain("Provider error");
  });

  test("handles councillors with result but completed status", () => {
    const councillorResults = [
      {
        name: "alpha",
        model: "anthropic/claude-opus-4-6",
        status: "completed",
        result: "Valid response",
      },
      {
        name: "beta",
        model: "openai/gpt-5.5",
        status: "completed",
        result: "Another valid response",
      },
    ];

    const formatted = formatCouncillorResults(
      originalPrompt,
      councillorResults
    );

    expect(formatted).toContain("**alpha** (claude-opus-4-6):");
    expect(formatted).toContain("Valid response");
    expect(formatted).toContain("**beta** (gpt-5.5):");
    expect(formatted).toContain("Another valid response");
    expect(formatted).toContain(
      "Synthesize the optimal response based on the above."
    );
  });
});

describe("formatCouncillorPrompt", () => {
  const userPrompt = "How do I implement async/await in TypeScript?";

  test("returns user prompt unchanged when no councillor prompt is provided", () => {
    const formatted = formatCouncillorPrompt(userPrompt);
    expect(formatted).toBe(userPrompt);
  });

  test("prepends councillor prompt with separator when provided", () => {
    const councillorPrompt =
      "You are a TypeScript expert. Focus on practical examples.";
    const formatted = formatCouncillorPrompt(userPrompt, councillorPrompt);

    expect(formatted).toContain(councillorPrompt);
    expect(formatted).toContain(userPrompt);
    expect(formatted).toContain("---");
    expect(formatted).toMatch(
      new RegExp(
        `^${councillorPrompt.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}\\n\\n---\\n\\n${userPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
      )
    );
  });

  test("handles multiline councillor prompt", () => {
    const councillorPrompt =
      "You are an expert.\nFocus on clarity.\nProvide code examples.";
    const formatted = formatCouncillorPrompt(userPrompt, councillorPrompt);

    expect(formatted).toContain(councillorPrompt);
    expect(formatted).toContain(userPrompt);
    expect(formatted).toContain("---");
    expect(formatted).toMatch(
      new RegExp(
        `^${councillorPrompt.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}\\n\\n---\\n\\n${userPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`
      )
    );
  });

  test("handles empty councillor prompt", () => {
    const formatted = formatCouncillorPrompt(userPrompt, "");
    expect(formatted).toBe(userPrompt);
  });

  test("handles multiline user prompt with councillor prompt", () => {
    const councillorPrompt = "You are an expert.";
    const multilineUserPrompt = "Line 1\nLine 2\nLine 3";
    const formatted = formatCouncillorPrompt(
      multilineUserPrompt,
      councillorPrompt
    );

    expect(formatted).toContain(councillorPrompt);
    expect(formatted).toContain(multilineUserPrompt);
    expect(formatted).toContain("---");
    expect(formatted).toMatch(
      new RegExp(
        `^${councillorPrompt.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}\\n\\n---\\n\\n${multilineUserPrompt.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}$`
      )
    );
  });
});
