import { encodeUtf8 } from './bytes';
import { CoreTerminalBuffer } from './terminalBuffer';
import { parseAttach, CoreCommandError, type CoreAttach } from './types';
import type { CoreSession } from './CoreSession';

export type CorePaneListener = () => void;

/**
 * One attached viewer of one terminal.
 *
 * It starts in `observe` mode so opening a phone view never resizes the
 * desktop or takes input; the first interaction reattaches as an active
 * viewer. Reattach always replaces the buffer with the core's authoritative
 * paint instead of concatenating cached output.
 */
export class CorePane {
  readonly buffer: CoreTerminalBuffer;
  channel: number | null = null;
  observe: boolean;
  attach: CoreAttach | null = null;
  closedReason: string | null = null;
  private readonly listeners = new Set<CorePaneListener>();
  private opening: Promise<void> | null = null;
  private claiming: Promise<void> | null = null;
  private generation = 0;

  constructor(
    private readonly core: CoreSession,
    readonly address: string,
    cols: number,
    rows: number,
    observe = true,
  ) {
    this.buffer = new CoreTerminalBuffer(cols, rows);
    this.observe = observe;
  }

  subscribe(fn: CorePaneListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  open(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = this.attachNow(this.observe, false).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async attachNow(observe: boolean, resumed: boolean): Promise<void> {
    const client = this.core.currentClient();
    if (!client) throw new CoreCommandError('not_connected', 'Herdr Core is not connected');
    const gen = ++this.generation;
    const result = await client.request<unknown>(
      'terminal.attach',
      {
        terminal: this.address,
        cols: this.buffer.cols,
        rows: this.buffer.rows,
        history: 2000,
        observe,
        resize_notifications: true,
        resumed,
      },
      20_000,
    );
    const attach = parseAttach(result);
    if (gen !== this.generation) {
      // A newer attach superseded this reply; close this viewer, never the terminal.
      client.closeStream(attach.channel);
      return;
    }
    this.detachChannel();
    this.buffer.reset();
    this.buffer.resize(attach.terminal.cols || this.buffer.cols, attach.terminal.rows || this.buffer.rows);
    this.observe = observe;
    this.attach = attach;
    this.channel = attach.channel;
    this.closedReason = null;
    client.registerStream(attach.channel, {
      onData: (bytes) => {
        if (gen !== this.generation) return;
        this.buffer.write(bytes);
        this.emit();
      },
      onResize: (cols, rows) => {
        if (gen !== this.generation) return;
        this.buffer.resize(cols, rows);
        this.emit();
      },
      onClose: (reason) => {
        if (gen !== this.generation) return;
        this.channel = null;
        this.closedReason = reason;
        this.emit();
      },
    });
    this.emit();
  }

  /** Typing claims the viewer: reattach non-observe so keys and sizing apply. */
  async claimInput(): Promise<void> {
    if (!this.observe && this.channel !== null) return;
    if (!this.claiming) {
      this.claiming = this.attachNow(false, true).finally(() => {
        this.claiming = null;
      });
    }
    await this.claiming;
  }

  async write(text: string): Promise<void> {
    const client = this.core.currentClient();
    if (!client) throw new CoreCommandError('not_connected', 'Herdr Core is not connected');
    if (this.observe) await this.claimInput();
    if (this.channel === null) throw new CoreCommandError('no_channel', 'This terminal is no longer attached');
    await client.writeStream(this.channel, encodeUtf8(text));
  }

  /** Automatic query answers are sent only when both capability checks agree. */
  async writeAutomatic(bytes: Uint8Array): Promise<void> {
    const client = this.core.currentClient();
    if (!client || this.channel === null) return;
    if (!this.core.supportsAutomaticInput(this.attach)) return;
    await client.writeStream(this.channel, bytes, true);
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.buffer.resize(cols, rows);
    const client = this.core.currentClient();
    if (client && this.channel !== null && !this.observe) await client.resize(this.channel, cols, rows);
    this.emit();
  }

  focus(gained: boolean): void {
    const client = this.core.currentClient();
    if (client && this.channel !== null && !this.observe) void client.focus(this.channel, gained).catch(() => {});
  }

  detach(): void {
    this.generation++;
    this.detachChannel();
    this.emit();
  }

  private detachChannel(): void {
    const client = this.core.currentClient();
    if (client && this.channel !== null) client.closeStream(this.channel);
    this.channel = null;
    this.attach = null;
  }

  /** Reattach after the core connection came back. */
  async reattach(): Promise<void> {
    if (!this.core.currentClient()) return;
    await this.attachNow(this.observe, true);
  }
}
