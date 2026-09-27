/** Exit codes of sermonize-admin. */
export const EXIT_OK = 0;
/** API errors, usage errors, network errors. */
export const EXIT_ERROR = 1;
/** Not signed in, invalid/expired token, or not allowed (401/403). */
export const EXIT_AUTH = 2;

/** An error that ends the command with a message on stderr and an exit code. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT_ERROR,
    /** The API's error body, if the error came from the API (printed with --json). */
    readonly apiError?: { code: string; message: string; details?: unknown },
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string) {
    super(message, EXIT_ERROR);
    this.name = 'UsageError';
  }
}
