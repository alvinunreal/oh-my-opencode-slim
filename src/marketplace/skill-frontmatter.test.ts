import { describe, expect, test } from 'bun:test';
import { parseSkillFrontmatterName } from './skill-frontmatter';

describe('parseSkillFrontmatterName', () => {
  test('accepts quoted names and YAML comments', () => {
    expect(
      parseSkillFrontmatterName(`---
name: "quoted-skill" # name comment
description: Test skill. # description comment
---

# body
`),
    ).toBe('quoted-skill');
  });

  test('accepts block scalar names', () => {
    expect(
      parseSkillFrontmatterName(`---
name: |-
  block-skill
description: Test skill.
---
`),
    ).toBe('block-skill');
  });

  test('accepts CRLF frontmatter', () => {
    expect(
      parseSkillFrontmatterName(
        '---\r\nname: crlf-skill\r\ndescription: Test skill.\r\n---\r\n',
      ),
    ).toBe('crlf-skill');
  });

  test('sanitizes malformed plain values containing colons', () => {
    expect(
      parseSkillFrontmatterName(`---
name: colon:skill
description: Text with a colon: accepted by fallback
---
`),
    ).toBe('colon:skill');
  });

  test('rejects non-string names', () => {
    expect(
      parseSkillFrontmatterName(`---
name: 123
description: Test skill.
---
`),
    ).toBeUndefined();
  });

  test('rejects non-string descriptions', () => {
    expect(
      parseSkillFrontmatterName(`---
name: typed-skill
description: true
---
`),
    ).toBeUndefined();
  });
});
