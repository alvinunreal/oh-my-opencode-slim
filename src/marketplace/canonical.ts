import { createHash } from 'node:crypto';
import type { MarketplacePackageBundle } from './schemas.js';

export function compareMarketplaceCodeUnits(
  left: string,
  right: string,
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Canonical JSON used by the package store, registry CI, and the website. */
export function canonicalizeMarketplaceValue(value: unknown): string {
  return canonicalize(value, new Set());
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return encodePrimitive(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON does not support non-finite numbers');
    }
    return encodePrimitive(value);
  }
  if (typeof value !== 'object') {
    throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError('Canonical JSON does not support circular references');
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
        throw new TypeError('Canonical JSON does not support symbol keys');
      }
      const elements: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (
          !descriptor?.enumerable ||
          !('value' in descriptor) ||
          descriptor.value === undefined
        ) {
          throw new TypeError(
            'Canonical JSON arrays cannot contain holes or undefined',
          );
        }
        elements.push(canonicalize(descriptor.value, ancestors));
      }
      const allowedKeys = new Set([
        'length',
        ...Array.from({ length: value.length }, (_, index) => String(index)),
      ]);
      if (Reflect.ownKeys(value).some((key) => !allowedKeys.has(String(key)))) {
        throw new TypeError(
          'Canonical JSON arrays cannot have extra properties',
        );
      }
      return `[${elements.join(',')}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Canonical JSON only supports plain objects');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== 'string')) {
      throw new TypeError('Canonical JSON does not support symbol keys');
    }
    const entries = (keys as string[]).flatMap((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('Canonical JSON does not support accessors');
      }
      return descriptor.value === undefined
        ? []
        : [[key, descriptor.value] as const];
    });
    entries.sort(([left], [right]) => compareMarketplaceCodeUnits(left, right));
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalize(entry, ancestors)}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function encodePrimitive(value: string | number | boolean | null): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError('Canonical JSON cannot encode this value');
  }
  return encoded;
}

/** Returns the exact UTF-8-compatible canonical JSON text for a bundle. */
export function canonicalizeMarketplaceBundle(
  bundle: MarketplacePackageBundle,
): string {
  return canonicalizeMarketplaceValue(bundle);
}

export function digestMarketplaceBundle(
  bundle: MarketplacePackageBundle,
): string {
  return createHash('sha256')
    .update(canonicalizeMarketplaceBundle(bundle), 'utf8')
    .digest('hex');
}
