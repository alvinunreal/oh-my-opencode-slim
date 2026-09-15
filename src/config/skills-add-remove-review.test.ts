import { describe, expect, test } from 'bun:test';
import {
  getDefaultGrantedSkillNames,
  resolveEffectiveSkills,
} from '../cli/skills';

describe('skills_add / skills_remove review regressions', () => {
  test('lifting an inherited exclusion allows the same skill to be added', () => {
    expect(
      resolveEffectiveSkills('oracle', ['a', '!foo'], ['foo'], ['!foo']),
    ).toEqual(['a', 'foo']);
  });

  test('plain-name removal still wins over adding the same skill', () => {
    expect(resolveEffectiveSkills('oracle', ['a'], ['foo'], ['foo'])).toEqual([
      'a',
    ]);
  });

  test('legacy agent aliases resolve the same default grants as canonical names', () => {
    expect(getDefaultGrantedSkillNames('explore')).toEqual(
      getDefaultGrantedSkillNames('explorer'),
    );
    expect(getDefaultGrantedSkillNames('frontend-ui-ux-engineer')).toEqual(
      getDefaultGrantedSkillNames('designer'),
    );
  });
});
