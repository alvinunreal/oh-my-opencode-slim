import { expect, test } from 'bun:test';
import { ROLE_ROUTING_BLOCKS, ROLE_ROUTING_SLIM_LINES } from './role-routing';

test('ROLE_ROUTING_BLOCKS and ROLE_ROUTING_SLIM_LINES have identical key sets', () => {
  expect(Object.keys(ROLE_ROUTING_SLIM_LINES).sort()).toEqual(
    Object.keys(ROLE_ROUTING_BLOCKS).sort(),
  );
});
