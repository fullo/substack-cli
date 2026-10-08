export class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  constructor(message: string, exitCode: number, code: string) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.code = code;
  }
}

export class UsageError extends CliError {
  constructor(message: string) { super(message, 64, 'USAGE'); }
}

export class AuthError extends CliError {
  constructor(message: string) { super(message, 2, 'AUTH'); }
}

export class ApiShapeError extends CliError {
  readonly httpStatus: number | undefined;
  constructor(message: string, httpStatus?: number) {
    super(message, 3, 'API_SHAPE');
    this.httpStatus = httpStatus;
  }
}

export class NetworkError extends CliError {
  constructor(message: string) { super(message, 4, 'NETWORK'); }
}

export class RateLimitError extends CliError {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message, 4, 'RATE_LIMIT');
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderError extends CliError {
  constructor(message: string) { super(message, 5, 'PROVIDER'); }
}

export class StateError extends CliError {
  constructor(message: string) { super(message, 6, 'STATE'); }
}
