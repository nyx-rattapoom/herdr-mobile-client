import HerdrSsh from '../../modules/herdr-ssh';
import { HerdrClient } from '../protocol/client';
import {
  discoveryCommand,
  explainInstall,
  explainStart,
  installCommand,
  parseDiscovery,
  startServerCommand,
  type DiscoveryResult,
  type InstallOutcome,
} from '../protocol/sessions';
import type { Transport } from '../protocol/transport';
import type { HostKeyPin } from './pinning';

/** Herdr socket connection tunnelled over a direct-streamlocal SSH channel. */
class SshSocketTransport implements Transport {
  private dataHandler: (chunk: string) => void = () => {};
  private closeHandler: (reason: string) => void = () => {};
  private readonly subs: { remove(): void }[];

  constructor(private readonly channelId: string) {
    this.subs = [
      HerdrSsh.addListener('onChannelData', (e) => {
        if (e.channelId === this.channelId) this.dataHandler(e.data);
      }),
      HerdrSsh.addListener('onChannelClose', (e) => {
        if (e.channelId !== this.channelId) return;
        this.unsubscribe();
        this.closeHandler(e.reason);
      }),
    ];
  }

  write(data: string) {
    return HerdrSsh.write(this.channelId, data);
  }
  onData(h: (chunk: string) => void) {
    this.dataHandler = h;
  }
  onClose(h: (reason: string) => void) {
    this.closeHandler = h;
  }
  close() {
    this.unsubscribe();
    HerdrSsh.closeChannel(this.channelId);
  }
  private unsubscribe() {
    this.subs.forEach((s) => s.remove());
  }
}

export type ConnectParams = { host: string; port: number; username: string; password?: string; privateKey?: string };

/** An authenticated SSH session to one server. */
export class ServerConnection {
  private constructor(private readonly sessionId: string) {}

  /** The native side re-checks the pin during key exchange and fails before auth on mismatch. */
  static async open(p: ConnectParams, pin: HostKeyPin): Promise<ServerConnection> {
    const id = await HerdrSsh.connect(p.host, p.port, p.username, { password: p.password, privateKey: p.privateKey }, pin.key);
    return new ServerConnection(id);
  }

  async discoverSessions(herdrPath?: string): Promise<DiscoveryResult> {
    const res = await HerdrSsh.exec(this.sessionId, discoveryCommand(herdrPath));
    return parseDiscovery(res.stdout);
  }

  /** Runs the official Herdr installer on the server (user-confirmed). */
  async installHerdr(): Promise<InstallOutcome & { log: string }> {
    const res = await HerdrSsh.exec(this.sessionId, installCommand());
    return { ...explainInstall(res.exitCode, res.stdout, res.stderr), log: `${res.stdout}${res.stderr}` };
  }

  /** Starts a detached default-session server if none is running. */
  async startHerdr(herdrPath?: string): Promise<InstallOutcome> {
    const res = await HerdrSsh.exec(this.sessionId, startServerCommand(herdrPath));
    return explainStart(res.exitCode);
  }

  async openHerdr(socketPath: string): Promise<HerdrClient> {
    const channelId = await HerdrSsh.openSocket(this.sessionId, socketPath);
    return new HerdrClient(new SshSocketTransport(channelId));
  }

  close() {
    HerdrSsh.disconnect(this.sessionId);
  }
}

export const probeHostKey = (host: string, port: number) => HerdrSsh.probeHostKey(host, port);

/** User-facing text for native error codes. */
export function describeSshError(e: unknown): string {
  const code = (e as { code?: string })?.code;
  const msg = (e as { message?: string })?.message ?? String(e);
  switch (code) {
    case 'ERR_HOSTKEY_MISMATCH':
      return 'The server host key does not match the pinned key. Connection blocked.';
    case 'ERR_AUTH':
      return 'Authentication failed. Check the user and password, or that the device public key is in ~/.ssh/authorized_keys on the server.';
    case 'ERR_TIMEOUT':
      return 'Connection timed out.';
    case 'ERR_FORWARDING_PROHIBITED':
      return "This server's sshd doesn't allow Unix-socket forwarding (AllowStreamLocalForwarding). Ask the admin to enable it for your user.";
    case 'ERR_SOCKET_UNAVAILABLE':
      return "Herdr isn't running on this server (its socket isn't accepting connections).";
    case 'ERR_CONNECT':
      return `Could not connect: ${msg}`;
    default:
      return msg;
  }
}
