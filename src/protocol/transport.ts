/** A bidirectional text stream to one Herdr socket connection. */
export interface Transport {
  write(data: string): Promise<void>;
  /** Registers the single data handler. Chunks are arbitrary slices of the stream. */
  onData(handler: (chunk: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

/** Splits a stream of text chunks into complete newline-terminated lines. */
export class LineBuffer {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? '';
    return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
  }

  /** Bytes received after the last newline. */
  get remainder(): string {
    return this.pending;
  }
}
