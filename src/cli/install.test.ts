import { expect, test } from 'bun:test';
import { checkOpenCodeInstalled } from './install';

test('installer accepts unknown preview versions but rejects old releases', () => {
  const host = { path: '/isolated/opencode' };
  expect(checkOpenCodeInstalled({ ...host, version: 'opencode vlocal' })).toBe(
    true,
  );
  expect(checkOpenCodeInstalled({ ...host, version: 'opencode v2.2.4' })).toBe(
    false,
  );
});
