import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_COMPLETION_PROMISE, COMPLETION_TAG_PATTERN } from "./constants";

describe("ralph-loop constants", () => {
  test("DEFAULT_MAX_ITERATIONS should be 100", () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(100);
  });

  test("DEFAULT_COMPLETION_PROMISE should be DONE", () => {
    expect(DEFAULT_COMPLETION_PROMISE).toBe("DONE");
  });

  test("COMPLETION_TAG_PATTERN matches valid promise tags", () => {
    // #given
    const text = "Task complete. <promise>DONE</promise>";
    
    // #when
    const match = text.match(COMPLETION_TAG_PATTERN);
    
    // #then
    expect(match).not.toBeNull();
    expect(match![1]).toBe("DONE");
  });

  test("COMPLETION_TAG_PATTERN is case-insensitive", () => {
    // #given
    const text = "<PROMISE>done</PROMISE>";
    
    // #when
    const match = text.match(COMPLETION_TAG_PATTERN);
    
    // #then
    expect(match).not.toBeNull();
    expect(match![1]).toBe("done");
  });

  test("COMPLETION_TAG_PATTERN handles multiline", () => {
    // #given
    const text = `
      Task complete.
      <promise>
      READY_FOR_REVIEW
      </promise>
    `;
    
    // #when
    const match = text.match(COMPLETION_TAG_PATTERN);
    
    // #then
    expect(match).not.toBeNull();
  });
});
