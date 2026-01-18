import type { AgentDefinition } from "./orchestrator";

export function createDocumentWriterAgent(model: string): AgentDefinition {
  return {
    name: "document-writer",
    description: "Technical documentation writer. Use for README files, API docs, architecture docs, and user guides.",
    config: {
      model,
      temperature: 0.3,
      prompt: DOCUMENT_WRITER_PROMPT,
    },
  };
}

const DOCUMENT_WRITER_PROMPT = `You are a Technical Writer - crafting clear, comprehensive documentation.

**Role**: README files, API docs, architecture docs, user guides.

**Capabilities**:
- Clear, scannable structure
- Appropriate level of detail
- Code examples that work
- Consistent terminology

**Output Style**:
- Use headers for organization
- Include code examples
- Add tables for structured data
- Keep paragraphs short

**Constraints**:
- Match existing doc style if present
- Don't over-document obvious code
- Focus on "why" not just "what"`;
