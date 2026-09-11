export class MarketplaceError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'MarketplaceError';
  }
}

export class MarketplaceValidationError extends MarketplaceError {
  constructor(message: string) {
    super(message, 'validation');
    this.name = 'MarketplaceValidationError';
  }
}

export class MarketplaceLockfileError extends MarketplaceError {
  constructor(message: string) {
    super(message, 'lockfile');
    this.name = 'MarketplaceLockfileError';
  }
}

export class MarketplaceIntegrityError extends MarketplaceError {
  constructor(message: string) {
    super(message, 'integrity');
    this.name = 'MarketplaceIntegrityError';
  }
}

export class MarketplaceConflictError extends MarketplaceError {
  constructor(message: string) {
    super(message, 'conflict');
    this.name = 'MarketplaceConflictError';
  }
}

export class MarketplaceBusyError extends MarketplaceError {
  constructor(message: string) {
    super(message, 'busy');
    this.name = 'MarketplaceBusyError';
  }
}

export class MarketplaceLockOwnershipError extends MarketplaceError {
  constructor(message: string) {
    super(message, 'lock-ownership');
    this.name = 'MarketplaceLockOwnershipError';
  }
}

export class MarketplaceCompatibilityError extends MarketplaceError {
  constructor(message: string) {
    super(message, 'compatibility');
    this.name = 'MarketplaceCompatibilityError';
  }
}

export class MarketplaceActivationReferenceError extends MarketplaceError {
  constructor(message: string) {
    super(message, 'activation-reference');
    this.name = 'MarketplaceActivationReferenceError';
  }
}

export class MarketplaceActivationError extends MarketplaceError {
  constructor(message: string) {
    super(message, 'activation');
    this.name = 'MarketplaceActivationError';
  }
}
