#!/usr/bin/env bun
/**
 * Generates a JSON Schema from the Zod PluginConfigSchema.
 * Run as part of the build step so the schema stays in sync with the source.
 */

import { z } from 'zod';
import { PluginConfigSchema } from '../src/config/schema';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const outputPath = join(rootDir, 'oh-my-opencode-slim.schema.json');

const schema = z.toJSONSchema(PluginConfigSchema, {
  // Use $ref strategy that works well with IDE tooling
  io: 'output',
});

// Add metadata
const jsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'oh-my-opencode-slim',
  description:
    'Configuration schema for oh-my-opencode-slim plugin for OpenCode',
  ...schema,
};

const json = JSON.stringify(jsonSchema, null, 2);
writeFileSync(outputPath, json + '\n');

console.log(`✅ Schema written to ${outputPath}`);
