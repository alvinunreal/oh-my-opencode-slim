import type { ApplyPatchErrorCode, ApplyPatchErrorKind } from './types';

const APPLY_PATCH_ERROR_PREFIX: Record<ApplyPatchErrorKind, string> = {
  blocked: 'apply_patch blocked',
  validation: 'apply_patch validation failed',
  verification: 'apply_patch verification failed',
  internal: 'apply_patch internal error',
};

export class ApplyPatchError extends Error {
  override readonly cause?: unknown;

  constructor(
    readonly kind: ApplyPatchErrorKind,
    readonly code: ApplyPatchErrorCode,
    message: string,
    options?: {
      cause?: unknown;
    },
  ) {
    super(`${APPLY_PATCH_ERROR_PREFIX[kind]}: ${message}`);
    this.name = 'ApplyPatchError';
    this.cause = options?.cause;
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createApplyPatchBlockedError(
  message: string,
  cause?: unknown,
): ApplyPatchError {
  return new ApplyPatchError('blocked', 'outside_workspace', message, {
    cause,
  });
}

export function createApplyPatchValidationError(
  message: string,
  cause?: unknown,
): ApplyPatchError {
  return new ApplyPatchError('validation', 'malformed_patch', message, {
    cause,
  });
}

export function createApplyPatchVerificationError(
  message: string,
  cause?: unknown,
): ApplyPatchError {
  return new ApplyPatchError('verification', 'verification_failed', message, {
    cause,
  });
}

export function createApplyPatchInternalError(
  message: string,
  cause?: unknown,
): ApplyPatchError {
  return new ApplyPatchError('internal', 'internal_unexpected', message, {
    cause,
  });
}

export function isApplyPatchError(error: unknown): error is ApplyPatchError {
  return error instanceof ApplyPatchError;
}

export function isApplyPatchBlockedError(error: unknown): boolean {
  return isApplyPatchError(error) && error.kind === 'blocked';
}

export function isApplyPatchValidationError(error: unknown): boolean {
  return isApplyPatchError(error) && error.kind === 'validation';
}

export function isApplyPatchVerificationError(error: unknown): boolean {
  return isApplyPatchError(error) && error.kind === 'verification';
}

export function isApplyPatchInternalError(error: unknown): boolean {
  return isApplyPatchError(error) && error.kind === 'internal';
}

export function getApplyPatchErrorDetails(error: unknown):
  | {
      kind: ApplyPatchErrorKind;
      code: ApplyPatchErrorCode;
      message: string;
    }
  | undefined {
  if (!isApplyPatchError(error)) {
    return undefined;
  }

  return {
    kind: error.kind,
    code: error.code,
    message: error.message,
  };
}

export function ensureApplyPatchError(
  error: unknown,
  context: string,
): ApplyPatchError {
  if (isApplyPatchError(error)) {
    return error;
  }

  return createApplyPatchInternalError(
    `${context}: ${getErrorMessage(error)}`,
    error,
  );
}
