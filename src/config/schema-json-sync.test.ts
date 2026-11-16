import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PluginConfigSchema } from './schema';
import { dropDefaultedRequired } from './schema-json';

test('published background jobs schema retires managed settings', () => {
  const schema = JSON.parse(
    readFileSync(
      join(import.meta.dir, '..', '..', 'oh-my-opencode-slim.schema.json'),
      'utf8',
    ),
  );
  const properties = schema.properties.backgroundJobs.properties;
  expect(properties.mode.enum).toEqual(['native', 'off']);
  for (const key of [
    'maxSessionsPerAgent',
    'stopConfirmationMs',
    'wallClockTimeoutMs',
    'concurrency',
    'sameProviderPolicy',
    'waitForUserGuard',
    'childInputWake',
    'childInputWakeKinds',
    'pruneEvictedSessions',
  ]) {
    expect(properties[key]).toEqual({ not: {} });
  }
});

/**
 * Keeps the committed oh-my-opencode-slim.schema.json in sync with the
 * parser: the JSON Schema must be exactly what `bun run generate-schema`
 * would emit (same zod conversion, same options, same post-processing).
 * Fails when a schema change (e.g. a new `z.never` removed-key entry) lands
 * without regenerating the published file — editors would then accept config
 * the parser rejects.
 */
test('committed schema.json matches the generated JSON Schema', () => {
  // JSON round-trip drops non-enumerable zod markers (e.g. ~standard)
  // and undefined values, matching what the generator writes to disk.
  const generated = JSON.parse(
    JSON.stringify(
      z.toJSONSchema(PluginConfigSchema, {
        // Mirrors scripts/generate-schema.ts: defaulted fields stay
        // optional for the input shape users actually write.
        io: 'input',
      }),
    ),
  ) as Record<string, unknown>;
  // Mirrors the generator's published post-processing so both sides agree.
  dropDefaultedRequired(generated);
  const committed = JSON.parse(
    readFileSync(
      join(import.meta.dir, '..', '..', 'oh-my-opencode-slim.schema.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;
  // Strip only the publication wrapper the generator adds (title/
  // description); zod emits $schema itself and the wrapper keeps the
  // same value.
  const { title: _t, description: _d, ...published } = committed;
  expect(published).toEqual(generated);
});
