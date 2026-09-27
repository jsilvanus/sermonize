/**
 * Line input for prompts and --password-stdin, over node:readline.
 *
 * - On a terminal, hidden prompts mute readline's echo (nothing typed is printed).
 * - On a pipe, lines are read one after another (so `--password-stdin` and the
 *   prompts work in scripts and tests); nothing read is ever written back.
 * Prompts go to stderr so that stdout stays clean for --json and tokens.
 */
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import { CliError } from './errors.js';

export interface InputStream extends NodeJS.ReadableStream {
  isTTY?: boolean;
}
export interface OutputStream {
  write(chunk: string): unknown;
}

export class Prompter {
  private rl: Interface | undefined;
  private lines: AsyncIterator<string> | undefined;
  private muted = false;

  constructor(
    private readonly input: InputStream,
    private readonly output: OutputStream,
  ) {}

  private get tty(): boolean {
    return this.input.isTTY === true;
  }

  private open(): AsyncIterator<string> {
    if (!this.lines) {
      const echo = new Writable({
        write: (chunk: Buffer | string, _encoding, callback) => {
          if (!this.muted) this.output.write(chunk.toString());
          callback();
        },
      });
      this.rl = createInterface({ input: this.input, output: echo, terminal: this.tty });
      // Ctrl-C at a prompt: stop reading (the prompt then fails with "cancelled").
      this.rl.on('SIGINT', () => {
        this.output.write('\n');
        this.rl?.close();
      });
      this.lines = this.rl[Symbol.asyncIterator]();
    }
    return this.lines;
  }

  /** Reads one line. `question` (if any) goes to stderr; `hidden` suppresses the echo. */
  async line(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
    const lines = this.open();
    if (question) this.output.write(question);
    this.muted = opts.hidden === true;
    try {
      const next = await lines.next();
      if (next.done) throw new CliError(question ? 'cancelled: no input' : 'no input on stdin');
      return next.value;
    } finally {
      // On a terminal the hidden input's Enter was swallowed; on a pipe nothing was echoed at all.
      if ((this.muted && this.tty) || (question && !this.tty)) this.output.write('\n');
      this.muted = false;
    }
  }

  /** Asks for a new password twice (hidden) and checks both match. */
  async newPassword(label = 'New password'): Promise<string> {
    const first = await this.line(`${label}: `, { hidden: true });
    const second = await this.line(`Repeat ${label.toLowerCase()}: `, { hidden: true });
    if (first !== second) throw new CliError('the passwords do not match');
    if (first.length === 0) throw new CliError('empty password');
    return first;
  }

  close(): void {
    this.rl?.close();
  }
}
