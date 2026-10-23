export interface Transport {
  write(data: string): Promise<void>;
  onData(handler: (chunk: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

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

  get remainder(): string {
    return this.pending;
  }
}
