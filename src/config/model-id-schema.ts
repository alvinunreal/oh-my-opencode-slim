import { z } from 'zod';

/**
 * A provider ID followed by a nonempty, verbatim model remainder.
 *
 * Providers cannot contain slashes or whitespace. Model remainders may contain
 * spaces and additional slashes because provider adapters may expose nested or
 * human-readable model names.
 */
export const ProviderModelIdSchema = z
  .string()
  .regex(
    /^[^/\s]+\/.+$/,
    'Expected provider/model format (provider/.../model)',
  );
