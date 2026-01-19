import { describe, expect, test } from "bun:test"
import {
  getBuiltinSkills,
  getSkillByName,
  getSkillsForAgent,
  canAgentUseSkill,
  DEFAULT_AGENT_SKILLS,
} from "./builtin"
import type { PluginConfig } from "../../config/schema"

describe("getBuiltinSkills", () => {
  test("returns all builtin skills", () => {
    const skills = getBuiltinSkills()
    expect(skills.length).toBeGreaterThan(0)
    
    const names = skills.map(s => s.name)
    expect(names).toContain("yagni-enforcement")
    expect(names).toContain("playwright")
  })
})

describe("getSkillByName", () => {
  test("returns skill by exact name", () => {
    const skill = getSkillByName("yagni-enforcement")
    expect(skill).toBeDefined()
    expect(skill?.name).toBe("yagni-enforcement")
  })

  test("returns undefined for unknown skill", () => {
    const skill = getSkillByName("nonexistent-skill")
    expect(skill).toBeUndefined()
  })

  test("returns playwright skill with mcpConfig", () => {
    const skill = getSkillByName("playwright")
    expect(skill).toBeDefined()
    expect(skill?.mcpConfig).toBeDefined()
    expect(skill?.mcpConfig?.playwright).toBeDefined()
  })
})

describe("DEFAULT_AGENT_SKILLS", () => {
  test("orchestrator has wildcard access", () => {
    expect(DEFAULT_AGENT_SKILLS.orchestrator).toContain("*")
  })

  test("designer has playwright skill", () => {
    expect(DEFAULT_AGENT_SKILLS.designer).toContain("playwright")
  })

  test("oracle has no skills by default", () => {
    expect(DEFAULT_AGENT_SKILLS.oracle).toEqual([])
  })

  test("librarian has no skills by default", () => {
    expect(DEFAULT_AGENT_SKILLS.librarian).toEqual([])
  })

  test("explorer has no skills by default", () => {
    expect(DEFAULT_AGENT_SKILLS.explorer).toEqual([])
  })

  test("fixer has no skills by default", () => {
    expect(DEFAULT_AGENT_SKILLS.fixer).toEqual([])
  })
})

describe("getSkillsForAgent", () => {
  test("returns all skills for orchestrator (wildcard)", () => {
    const skills = getSkillsForAgent("orchestrator")
    const allSkills = getBuiltinSkills()
    expect(skills.length).toBe(allSkills.length)
  })

  test("returns playwright for designer", () => {
    const skills = getSkillsForAgent("designer")
    const names = skills.map(s => s.name)
    expect(names).toContain("playwright")
  })

  test("returns empty for oracle", () => {
    const skills = getSkillsForAgent("oracle")
    expect(skills).toEqual([])
  })

  test("respects config override for agent skills", () => {
    const config: PluginConfig = {
      agents: {
        oracle: { skills: ["yagni-enforcement"] },
      },
    }
    const skills = getSkillsForAgent("oracle", config)
    expect(skills.length).toBe(1)
    expect(skills[0].name).toBe("yagni-enforcement")
  })

  test("config wildcard overrides default", () => {
    const config: PluginConfig = {
      agents: {
        explorer: { skills: ["*"] },
      },
    }
    const skills = getSkillsForAgent("explorer", config)
    const allSkills = getBuiltinSkills()
    expect(skills.length).toBe(allSkills.length)
  })

  test("config empty array removes default skills", () => {
    const config: PluginConfig = {
      agents: {
        designer: { skills: [] },
      },
    }
    const skills = getSkillsForAgent("designer", config)
    expect(skills).toEqual([])
  })

  test("backward compat: 'explore' alias config applies to explorer", () => {
    const config: PluginConfig = {
      agents: {
        explore: { skills: ["playwright"] },
      },
    }
    const skills = getSkillsForAgent("explorer", config)
    expect(skills.length).toBe(1)
    expect(skills[0].name).toBe("playwright")
  })

  test("backward compat: 'frontend-ui-ux-engineer' alias applies to designer", () => {
    const config: PluginConfig = {
      agents: {
        "frontend-ui-ux-engineer": { skills: ["yagni-enforcement"] },
      },
    }
    const skills = getSkillsForAgent("designer", config)
    expect(skills.length).toBe(1)
    expect(skills[0].name).toBe("yagni-enforcement")
  })

  test("returns empty for unknown agent without config", () => {
    const skills = getSkillsForAgent("unknown-agent")
    expect(skills).toEqual([])
  })
})

describe("canAgentUseSkill", () => {
  test("orchestrator can use any skill (wildcard)", () => {
    expect(canAgentUseSkill("orchestrator", "yagni-enforcement")).toBe(true)
    expect(canAgentUseSkill("orchestrator", "playwright")).toBe(true)
    expect(canAgentUseSkill("orchestrator", "any-skill")).toBe(true)
  })

  test("designer can use playwright", () => {
    expect(canAgentUseSkill("designer", "playwright")).toBe(true)
  })

  test("designer cannot use yagni-enforcement by default", () => {
    expect(canAgentUseSkill("designer", "yagni-enforcement")).toBe(false)
  })

  test("oracle cannot use any skill by default", () => {
    expect(canAgentUseSkill("oracle", "yagni-enforcement")).toBe(false)
    expect(canAgentUseSkill("oracle", "playwright")).toBe(false)
  })

  test("respects config override", () => {
    const config: PluginConfig = {
      agents: {
        oracle: { skills: ["yagni-enforcement"] },
      },
    }
    expect(canAgentUseSkill("oracle", "yagni-enforcement", config)).toBe(true)
    expect(canAgentUseSkill("oracle", "playwright", config)).toBe(false)
  })

  test("config wildcard grants all permissions", () => {
    const config: PluginConfig = {
      agents: {
        librarian: { skills: ["*"] },
      },
    }
    expect(canAgentUseSkill("librarian", "yagni-enforcement", config)).toBe(true)
    expect(canAgentUseSkill("librarian", "playwright", config)).toBe(true)
    expect(canAgentUseSkill("librarian", "any-other-skill", config)).toBe(true)
  })

  test("config empty array denies all", () => {
    const config: PluginConfig = {
      agents: {
        designer: { skills: [] },
      },
    }
    expect(canAgentUseSkill("designer", "playwright", config)).toBe(false)
  })

  test("backward compat: alias config affects agent permissions", () => {
    const config: PluginConfig = {
      agents: {
        explore: { skills: ["playwright"] },
      },
    }
    expect(canAgentUseSkill("explorer", "playwright", config)).toBe(true)
    expect(canAgentUseSkill("explorer", "yagni-enforcement", config)).toBe(false)
  })

  test("unknown agent returns false without config", () => {
    expect(canAgentUseSkill("unknown-agent", "playwright")).toBe(false)
  })
})
