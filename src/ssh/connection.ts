import HerdrSsh from '../../modules/herdr-ssh';
import { HerdrClient } from '../protocol/client';
import {
  discoveryCommand,
  explainInstall,
  explainStart,
  installCommand,
  parseDiscovery,
  startServerCommand,
  SAFE_SERVER_PATH,
  type DiscoveryResult,
  type InstallOutcome,
} from '../protocol/sessions';
import type { Transport } from '../protocol/transport';
import type { HostKeyPin } from './pinning';

const FORWARDING_PROHIBITED_TEXT =
  "This server's sshd doesn't allow Unix-socket forwarding (AllowStreamLocalForwarding). Ask the admin to enable it for your user.";

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
    let channelId: string;
    try {
      channelId = await HerdrSsh.openSocket(this.sessionId, socketPath);
    } catch (e) {
      throw await this.explainOpenFailure(e, socketPath);
    }
    return new HerdrClient(new SshSocketTransport(channelId));
  }

  /**
   * OpenSSH answers both "no such socket" and "AllowStreamLocalForwarding no" with the same
   * generic open failure, so look at the server: if the socket exists, forwarding was refused.
   */
  private async explainOpenFailure(e: unknown, socketPath: string): Promise<unknown> {
    if ((e as { code?: string })?.code !== 'ERR_SOCKET_UNAVAILABLE') return e;
    // The path comes from the server; only probe paths that need no quoting in any shell.
    if (!SAFE_SERVER_PATH.test(socketPath)) return e;
    try {
      const res = await HerdrSsh.exec(this.sessionId, `test -S ${socketPath} && echo SOCKET_EXISTS`);
      if (res.stdout.includes('SOCKET_EXISTS')) {
        return Object.assign(new Error(FORWARDING_PROHIBITED_TEXT), {
          code: 'ERR_FORWARDING_PROHIBITED',
        });
      }
    } catch {
      // Keep the original error.
    }
    return e;
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
  // expo-secure-store rejections from the biometric vault.
  if (/canceled the authentication|User canceled|authentication was canceled/i.test(msg)) {
    return 'Unlock cancelled. Saved credentials stay locked until you authenticate.';
  }
  if (/Could not Authenticate|KeyPermanentlyInvalidated|Key user not authenticated/i.test(msg)) {
    return 'Could not unlock saved credentials. If you changed fingerprints or face unlock, re-enter passwords and recreate the device key.';
  }
  switch (code) {
    case 'ERR_HOSTKEY_MISMATCH':
      return 'The server host key does not match the pinned key. Connection blocked.';
    case 'ERR_AUTH':
      return 'Authentication failed. Check the user and password, or that the device public key is in ~/.ssh/authorized_keys on the server.';
    case 'ERR_TIMEOUT':
      return 'Connection timed out.';
    case 'ERR_FORWARDING_PROHIBITED':
      return FORWARDING_PROHIBITED_TEXT;
    case 'ERR_SOCKET_UNAVAILABLE':
      return "Herdr isn't running on this server (its socket isn't accepting connections).";
    case 'ERR_CONNECT':
      return `Could not connect: ${msg}`;
    default:
      return msg;
  }
}
