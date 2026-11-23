import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * Holds a credential so that logging, string interpolation and JSON.stringify
 * cannot reveal it. Only reveal() returns the value.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return `Secret(${REDACTED})`;
  }
}
