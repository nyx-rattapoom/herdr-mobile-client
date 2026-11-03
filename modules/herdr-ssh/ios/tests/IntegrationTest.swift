import Foundation


private struct Target {
  let user: String
  let password: String
  let host: String
  let port: Int

  init(_ spec: String) {
    let at = spec.lastIndex(of: "@")!
    let cred = spec[..<at].split(separator: ":", maxSplits: 1)
    let hp = spec[spec.index(after: at)...].split(separator: ":")
    user = String(cred[0])
    password = String(cred[1])
    host = String(hp[0])
    port = Int(hp[1])!
  }

  var socket: String { "/home/\(user)/.config/herdr/herdr.sock" }
}

private var failures = 0

private func check(_ ok: Bool, _ what: String) {
  print(ok ? "  ok   \(what)" : "  FAIL \(what)")
  if !ok { failures += 1 }
}

private func expectError(_ code: String, _ what: String, _ block: () throws -> Void) {
  do {
    try block()
    check(false, "\(what): expected \(code), got success")
  } catch let e as SshError {
    check(e.code == code, "\(what) → \(e.code) (\(e.message))")
  } catch {
    check(false, "\(what): unexpected \(error)")
  }
}

private final class Events {
  private let lock = NSLock()
  private var data = [String: String]()
  private var closed = [String: String]()

  func attach(_ c: SshClient) {
    c.onData = { ch, d in self.lock.lock(); self.data[ch, default: ""] += d; self.lock.unlock() }
    c.onClose = { ch, r in print("  · channel \(ch.prefix(8)) closed: \(r)"); self.lock.lock(); self.closed[ch] = r; self.lock.unlock() }
  }

  func waitFor(_ ch: String, contains s: String, ms: Int = 5000) -> String? {
    let d = Deadline(ms: ms)
    while !d.expired {
      lock.lock()
      let v = data[ch]
      lock.unlock()
      if let v, v.contains(s) { return v }
      usleep(20_000)
    }
    return nil
  }

  func closeReason(_ ch: String, ms: Int = 5000) -> String? {
    let d = Deadline(ms: ms)
    while !d.expired {
      lock.lock()
      let v = closed[ch]
      lock.unlock()
      if let v { return v }
      usleep(20_000)
    }
    return nil
  }
}

private func ping(_ c: SshClient, _ ev: Events, _ session: String, _ socket: String, _ id: String) throws -> String {
  let ch = try c.openSocket(session, socket)
  try c.write(ch, Data("{\"id\":\"\(id)\",\"method\":\"ping\",\"params\":{}}\n".utf8))
  let line = ev.waitFor(ch, contains: "\"\(id)\"")
  check(line?.contains("pong") == true, "Herdr ping \(id) over direct-streamlocal")
  return ch
}

private func wait<T>(_ start: (@escaping (Result<T, SshError>) -> Void) -> Void) throws -> T {
  let done = DispatchSemaphore(value: 0)
  var result: Result<T, SshError>?
  start { result = $0; done.signal() }
  done.wait()
  return try result!.get()
}

extension SshClient {
  func exec(_ s: String, _ cmd: String, timeoutMs: Int?) throws -> ExecResult {
    try wait { self.exec(s, cmd, timeoutMs: timeoutMs, completion: $0) }
  }
  func openSocket(_ s: String, _ path: String) throws -> String {
    try wait { self.openSocket(s, path, completion: $0) }
  }
  func write(_ ch: String, _ data: Data) throws {
    let _: Bool = try wait { done in self.write(ch, data) { e in done(e.map { .failure($0) } ?? .success(true)) } }
  }
}

@main
struct IntegrationTest {
  static func main() throws {
    setvbuf(stdout, nil, _IOLBF, 0)
    Libssh2.ensureInit()
    let t = Target(ProcessInfo.processInfo.environment["HERDR_TEST_SSH"]!)
    let c = SshClient()
    let ev = Events()
    ev.attach(c)

    print("probe and pin")
    let info = try c.probeHostKey(host: t.host, port: t.port, via: nil)
    check(info.fingerprint.hasPrefix("SHA256:") && !info.key.isEmpty, "probe \(info.algorithm) \(info.fingerprint)")
    check(try c.probeHostKey(host: t.host, port: t.port, via: nil).key == info.key, "probe is stable")
    var wrong = Data(base64Encoded: info.key)!
    wrong[wrong.count - 1] ^= 1
    expectError("ERR_HOSTKEY_MISMATCH", "wrong pin") {
      _ = try c.connect(host: t.host, port: t.port, user: t.user, password: t.password, privateKey: nil,
                        pinnedKey: wrong.base64EncodedString(), via: nil)
    }
    expectError("ERR_AUTH", "wrong password") {
      _ = try c.connect(host: t.host, port: t.port, user: t.user, password: "nope", privateKey: nil,
                        pinnedKey: info.key, via: nil)
    }
    expectError("ERR_ARGS", "no credentials") {
      _ = try c.connect(host: t.host, port: t.port, user: t.user, password: nil, privateKey: nil,
                        pinnedKey: info.key, via: nil)
    }
    expectError("ERR_CONNECT", "closed port") { _ = try c.probeHostKey(host: "127.0.0.1", port: 1, via: nil) }

    print("password session")
    let s = try c.connect(host: t.host, port: t.port, user: t.user, password: t.password, privateKey: nil,
                          pinnedKey: info.key, via: nil)
    let r = try c.exec(s, "echo out; echo err >&2; printf 'ü€'; exit 3", timeoutMs: 10_000)
    check(r.stdout == "out\nü€" && r.stderr == "err\n" && r.exitCode == 3, "exec stdout/stderr/exit \(r)")
    let big = try c.exec(s, "head -c 300000 /dev/zero | tr '\\0' x", timeoutMs: 10_000)
    check(big.stdout.count == 300_000, "exec 300 kB output")
    expectError("ERR_EXEC", "exec output over 1 MiB") {
      _ = try c.exec(s, "head -c 2000000 /dev/zero", timeoutMs: 10_000)
    }
    expectError("ERR_TIMEOUT", "exec timeout") { _ = try c.exec(s, "sleep 5", timeoutMs: 1_000) }
    check((try c.exec(s, "kill -9 $$", timeoutMs: 10_000)).exitCode == -1, "command killed by a signal → exit -1")
    check((try? c.exec(s, "true", timeoutMs: 5_000))?.exitCode == 0, "session usable after timeout")

    let ch = try ping(c, ev, s, t.socket, "p1")
    let group = DispatchGroup()
    var parallelOk = 0
    let plock = NSLock()
    for i in 0..<4 {
      group.enter()
      DispatchQueue.global().async {
        if let r = try? c.exec(s, "echo \(i)", timeoutMs: 10_000), r.stdout == "\(i)\n" {
          plock.lock(); parallelOk += 1; plock.unlock()
        }
        group.leave()
      }
    }
    group.wait()
    check(parallelOk == 4, "4 parallel execs while a socket channel is open")
    check(ev.closeReason(ch) == "eof", "server close of the socket emits onChannelClose(eof)")
    expectError("ERR_NO_CHANNEL", "write after close") { try c.write(ch, Data("x".utf8)) }
    let sub = try c.openSocket(s, t.socket)
    try c.write(sub, Data("{\"id\":\"s1\",\"method\":\"events.subscribe\",\"params\":{\"subscriptions\":[{\"type\":\"workspace.created\"}]}}\n".utf8))
    check(ev.waitFor(sub, contains: "\"s1\"") != nil, "events.subscribe answered")
    let more = try c.exec(s, "echo still", timeoutMs: 10_000)
    check(more.stdout == "still\n", "exec while a subscription is open")
    c.closeChannel(sub)
    check(ev.closeReason(sub) != nil, "closeChannel emits onChannelClose")
    expectError("ERR_SOCKET_UNAVAILABLE", "missing socket") { _ = try c.openSocket(s, "/tmp/nothing-here.sock") }

    print("device key")
    let key = Keys.generateEd25519(comment: "herdr-ios-test")
    check(key.publicKey.hasPrefix("ssh-ed25519 ") && key.publicKey.hasSuffix(" herdr-ios-test"), "generated public key")
    let add = try c.exec(s, "mkdir -p ~/.ssh && echo '\(key.publicKey)' >> ~/.ssh/authorized_keys", timeoutMs: 10_000)
    check(add.exitCode == 0, "authorized the key")
    let ks = try c.connect(host: t.host, port: t.port, user: t.user, password: nil, privateKey: key.privateKey,
                           pinnedKey: info.key, via: nil)
    check((try c.exec(ks, "whoami", timeoutMs: 10_000)).stdout == "\(t.user)\n", "key-only auth")
    c.disconnect(ks)
    let other = Keys.generateEd25519(comment: "unauthorized")
    expectError("ERR_AUTH", "unauthorized key") {
      _ = try c.connect(host: t.host, port: t.port, user: t.user, password: nil, privateKey: other.privateKey,
                        pinnedKey: info.key, via: nil)
    }
    _ = try c.exec(s, "sed -i '/herdr-ios-test/d' ~/.ssh/authorized_keys", timeoutMs: 10_000)

    print("jump hosts")
    let innerKey = try c.probeHostKey(host: "127.0.0.1", port: 22, via: s)
    check(innerKey.key == info.key, "probe through the jump host")
    var wrongInner = Data(base64Encoded: innerKey.key)!
    wrongInner[wrongInner.count - 1] ^= 1
    expectError("ERR_HOSTKEY_MISMATCH", "wrong inner pin") {
      _ = try c.connect(host: "127.0.0.1", port: 22, user: t.user, password: t.password, privateKey: nil,
                        pinnedKey: wrongInner.base64EncodedString(), via: s)
    }
    expectError("ERR_JUMP_UNREACHABLE", "jump to closed port") {
      _ = try c.probeHostKey(host: "127.0.0.1", port: 1, via: s)
    }
    let hop2 = try c.connect(host: "127.0.0.1", port: 22, user: t.user, password: t.password, privateKey: nil,
                             pinnedKey: innerKey.key, via: s)
    _ = try ping(c, ev, hop2, t.socket, "j1")
    let hop3Key = try c.probeHostKey(host: "127.0.0.1", port: 22, via: hop2)
    let hop3 = try c.connect(host: "127.0.0.1", port: 22, user: t.user, password: t.password, privateKey: nil,
                             pinnedKey: hop3Key.key, via: hop2)
    _ = try ping(c, ev, hop3, t.socket, "j2")
    let ch3 = try c.openSocket(hop3, t.socket)
    try c.write(ch3, Data("{\"id\":\"s3\",\"method\":\"events.subscribe\",\"params\":{\"subscriptions\":[{\"type\":\"workspace.created\"}]}}\n".utf8))
    check(ev.waitFor(ch3, contains: "\"s3\"") != nil, "subscription two hops deep")
    check((try c.exec(hop3, "echo deep", timeoutMs: 10_000)).stdout == "deep\n", "exec two hops deep")
    c.disconnect(hop3)
    check(ev.closeReason(ch3) != nil, "inner disconnect closes its channels")
    check((try? c.exec(hop2, "true", timeoutMs: 5_000)) != nil, "second hop survives the inner disconnect")
    let hop3b = try c.connect(host: "127.0.0.1", port: 22, user: t.user, password: t.password, privateKey: nil,
                              pinnedKey: hop3Key.key, via: hop2)
    c.disconnect(s)
    let d = Deadline(ms: 5000)
    var gone = false
    while !d.expired && !gone {
      gone = (try? c.exec(hop3b, "true", timeoutMs: 1_000)) == nil
      if !gone { usleep(100_000) }
    }
    check(gone, "closing the first hop ends the sessions behind it")
    expectError("ERR_JUMP_UNREACHABLE", "connect via a closed jump session") {
      _ = try c.probeHostKey(host: "127.0.0.1", port: 22, via: s)
    }

    if let nofwd = ProcessInfo.processInfo.environment["HERDR_TEST_NOFWD"] {
      print("forwarding prohibited")
      let n = Target("\(t.user):\(t.password)@\(nofwd)")
      let nk = try c.probeHostKey(host: n.host, port: n.port, via: nil)
      let ns = try c.connect(host: n.host, port: n.port, user: n.user, password: n.password, privateKey: nil,
                             pinnedKey: nk.key, via: nil)
      expectError("ERR_SOCKET_UNAVAILABLE", "AllowStreamLocalForwarding no") { _ = try c.openSocket(ns, n.socket) }
      check((try c.exec(ns, "test -S \(n.socket) && echo SOCKET_EXISTS", timeoutMs: 10_000)).stdout.contains("SOCKET_EXISTS"),
            "socket exists, so the app explains it as forwarding prohibited")
      c.disconnect(ns)
    }

    print("teardown")
    c.disconnectAll()
    let leak = Deadline(ms: 5000)
    while SshSession.live > 0 && !leak.expired { usleep(50_000) }
    check(SshSession.live == 0, "every libssh2 session freed after disconnect (\(SshSession.live) left)")

    print("utf-8 stream")
    var u = Utf8Stream()
    let bytes = Array("aü€😀".utf8)
    var out = ""
    for b in bytes { out += [b].withUnsafeBufferPointer { u.decode($0) } }
    check(out == "aü€😀", "byte-at-a-time decoding")

    print(failures == 0 ? "ALL PASSED" : "\(failures) FAILED")
    exit(failures == 0 ? 0 : 1)
  }
}
