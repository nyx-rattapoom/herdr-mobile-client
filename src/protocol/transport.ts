/** A bidirectional text stream to one Herdr socket connection. */
export interface Transport {
  write(data: string): Promise<void>;
  /** Registers the single data handler. Chunks are arbitrary slices of the stream. */
  onData(handler: (chunk: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

/**
 * Splits a stream of text chunks into complete newline-terminated lines. Linear in input size:
 * chunks without a newline are only appended, and only the newly completed text is split.
 */
export class LineBuffer {
  private pending = '';

  push(chunk: string): string[] {
    const nl = chunk.lastIndexOf('\n');
    if (nl < 0) {
      this.pending += chunk;
      return [];
    }
    const complete = this.pending + chunk.slice(0, nl);
    this.pending = chunk.slice(nl + 1);
    return complete
      .split('\n')
      .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
      .filter((l) => l.length > 0);
  }

  /** Text received after the last newline. */
  get remainder(): string {
    return this.pending;
  }
}
