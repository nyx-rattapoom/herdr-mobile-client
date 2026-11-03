import Darwin
import Foundation


private let WINDOW: UInt32 = 2 * 1024 * 1024
private let PACKET: UInt32 = 32768
private let EAGAIN_SSH = Int32(LIBSSH2_ERROR_EAGAIN)
private let READ_CHUNK = 32 * 1024
private let BRIDGE_BUFFER = 256 * 1024
let OUTPUT_LIMIT = 1 << 20

private let HOSTKEY_PREFS =
  "ssh-ed25519,ecdsa-sha2-nistp256,ecdsa-sha2-nistp384,ecdsa-sha2-nistp521,rsa-sha2-512,rsa-sha2-256,ssh-rsa"

enum Libssh2 {
  private static let once: Void = { _ = libssh2_init(0) }()
  static func ensureInit() { _ = once }
}

/// Context for the keyboard-interactive callback, reached through the session's abstract pointer.
private final class AuthContext {
  var password: String?
  var prompts = 0
}

private let kbdCallback: @convention(c) (
  UnsafePointer<CChar>?, Int32, UnsafePointer<CChar>?, Int32, Int32,
  UnsafePointer<LIBSSH2_USERAUTH_KBDINT_PROMPT>?, UnsafeMutablePointer<LIBSSH2_USERAUTH_KBDINT_RESPONSE>?,
  UnsafeMutablePointer<UnsafeMutableRawPointer?>?
) -> Void = { _, _, _, _, count, prompts, responses, abstract in
  guard let abstract, let raw = abstract.pointee, let prompts, let responses else { return }
  let ctx = Unmanaged<AuthContext>.fromOpaque(raw).takeUnretainedValue()
  guard count == 1, let password = ctx.password, ctx.prompts == 0 else { return }
  let p = prompts[0]
  guard p.echo == 0, let text = p.text else { return }
  let prompt = String(decoding: UnsafeBufferPointer(start: text, count: Int(p.length)), as: UTF8.self)
  guard prompt.range(of: "password", options: .caseInsensitive) != nil else { return }
  ctx.prompts += 1
  responses[0].text = strdup(password)
  responses[0].length = UInt32(password.utf8.count)
}

final class SshSession {
  let id = UUID().uuidString
  private let s: OpaquePointer
  private let fd: Int32
  private let auth = AuthContext()
  private var authRef: Unmanaged<AuthContext>

  /// Called on the loop thread.
  var onData: ((String, String) -> Void)?
  var onClose: ((String, String) -> Void)?
  var onDeath: (() -> Void)?

  private let lock = NSLock()
  private var inbox = [() -> Void]()
  private var dead = false
  private var started = false
  private var wakeR: Int32 = -1
  private var wakeW: Int32 = -1

  private var tasks = [LoopTask]()
  private var streams = [String: StreamChannel]()
  private var bridges = [Bridge]()
  /// Channels being freed: first their half-sent packet (if any) is completed, then libssh2_channel_free runs
  /// until it stops returning EAGAIN. After the deadline they're left for libssh2_session_free.
  private var garbage = [(ch: OpaquePointer, settled: Bool, abandoned: Bool, deadline: Deadline)]()
  private var opener: AnyObject?
  private var progressed = false
  private var stopping = false

  var isAlive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !dead
  }

  /// Takes ownership of `fd` (closed when the session ends).
  init(fd: Int32) throws {
    Libssh2.ensureInit()
    self.fd = fd
    authRef = Unmanaged.passRetained(auth)
    guard let session = libssh2_session_init_ex(nil, nil, nil, authRef.toOpaque()) else {
      authRef.release()
      Darwin.close(fd)
      throw SshError("ERR_SSH", "could not create an SSH session")
    }
    s = session
    SshSession.count(+1)
    libssh2_session_set_blocking(s, 0)
    _ = libssh2_session_method_pref(s, Int32(LIBSSH2_METHOD_HOSTKEY), HOSTKEY_PREFS)
    libssh2_keepalive_config(s, 0, 10)
  }

  deinit {
    authRef.release()
  }

  private static let countLock = NSLock()
  private static var liveSessions = 0
  /// libssh2 sessions not yet freed (for the native test's leak check).
  static var live: Int {
    countLock.lock()
    defer { countLock.unlock() }
    return liveSessions
  }
  private static func count(_ d: Int) {
    countLock.lock()
    liveSessions += d
    countLock.unlock()
  }

  /// Frees the libssh2 session without further I/O. Marking the socket disconnected first makes
  /// libssh2_session_free free open channels instead of trying (non-blocking) to close them, which would
  /// return EAGAIN and leak the whole session.
  private func freeSession() {
    _ = libssh2_session_disconnect_ex(s, Int32(SSH_DISCONNECT_BY_APPLICATION), "bye", "")
    herdr_libssh2_mark_disconnected(s)
    _ = shutdown(fd, SHUT_RDWR)
    var rc = libssh2_session_free(s)
    var tries = 0
    while rc == EAGAIN_SSH && tries < 100 {
      tries += 1
      rc = libssh2_session_free(s)
    }
    if rc == 0 { SshSession.count(-1) }
    Darwin.close(fd)
  }


  private func lastError() -> (Int32, String) {
    var msg: UnsafeMutablePointer<CChar>?
    var len: Int32 = 0
    let code = libssh2_session_last_error(s, &msg, &len, 0)
    let text = msg.map { String(cString: $0) } ?? ""
    return (code, text)
  }

  /// Waits until the socket is ready in the direction libssh2 is blocked on.
  private func waitSocket(_ deadline: Deadline) throws {
    let dir = libssh2_session_block_directions(s)
    var events: Int16 = 0
    if dir & Int32(LIBSSH2_SESSION_BLOCK_INBOUND) != 0 { events |= Int16(POLLIN) }
    if dir & Int32(LIBSSH2_SESSION_BLOCK_OUTBOUND) != 0 { events |= Int16(POLLOUT) }
    if events == 0 { events = Int16(POLLIN) }
    var pfd = pollfd(fd: fd, events: events, revents: 0)
    let ms = deadline.remainingMs
    if ms <= 0 { throw SshError("ERR_TIMEOUT", "connection timed out") }
    _ = poll(&pfd, 1, Int32(min(ms, 1000)))
  }

  private func drive(_ deadline: Deadline, _ op: () -> Int32) throws -> Int32 {
    while true {
      let rc = op()
      if rc != EAGAIN_SSH { return rc }
      try waitSocket(deadline)
    }
  }

  /// Key exchange only. Returns the server's host key blob; nothing about the user has been sent yet.
  func handshake(_ deadline: Deadline) throws -> Data {
    let rc = try drive(deadline) { libssh2_session_handshake(s, fd) }
    if rc != 0 {
      let (code, msg) = lastError()
      if code == Int32(LIBSSH2_ERROR_TIMEOUT) || code == Int32(LIBSSH2_ERROR_SOCKET_TIMEOUT) {
        throw SshError("ERR_TIMEOUT", "connection timed out")
      }
      throw SshError("ERR_CONNECT", msg.isEmpty ? "SSH handshake failed (\(code))" : msg)
    }
    var len = 0
    var type: Int32 = 0
    guard let key = libssh2_session_hostkey(s, &len, &type), len > 0 else {
      throw SshError("ERR_PROBE", "no host key received")
    }
    return Data(bytes: key, count: len)
  }

  private var authAttempted = false

  /// Must only be called after the host key matched the pin.
  func authenticate(user: String, password: String?, privateKey: String?, deadline: Deadline) throws {
    var methods: String?
    while true {
      if let list = libssh2_userauth_list(s, user, UInt32(user.utf8.count)) {
        methods = String(cString: list)
        break
      }
      if libssh2_userauth_authenticated(s) != 0 { return }
      let (code, msg) = lastError()
      if code != EAGAIN_SSH { throw SshError("ERR_CONNECT", msg.isEmpty ? "authentication failed" : msg) }
      try waitSocket(deadline)
    }
    let offered = Set((methods ?? "").split(separator: ",").map(String.init))

    if let privateKey, offered.contains("publickey") {
      authAttempted = true
      let rc = try drive(deadline) {
        privateKey.withCString { pk in
          libssh2_userauth_publickey_frommemory(s, user, user.utf8.count, nil, 0, pk, privateKey.utf8.count, nil)
        }
      }
      if rc == 0 { return }
      try checkAuthFailure(rc)
      if rc == Int32(LIBSSH2_ERROR_FILE) {
        throw SshError("ERR_ARGS", "stored private key is unreadable")
      }
    }
    if let password, offered.contains("password") {
      authAttempted = true
      let rc = try drive(deadline) {
        libssh2_userauth_password_ex(s, user, UInt32(user.utf8.count), password, UInt32(password.utf8.count), nil)
      }
      if rc == 0 { return }
      try checkAuthFailure(rc)
    }
    if let password, offered.contains("keyboard-interactive") {
      authAttempted = true
      auth.password = password
      auth.prompts = 0
      defer { auth.password = nil }
      let rc = try drive(deadline) {
        libssh2_userauth_keyboard_interactive_ex(s, user, UInt32(user.utf8.count), kbdCallback)
      }
      if rc == 0 { return }
      try checkAuthFailure(rc)
    }
    throw SshError("ERR_AUTH", "authentication failed")
  }

  /// Transport failures during auth are connection errors; anything else just means this method failed.
  private func checkAuthFailure(_ rc: Int32) throws {
    let transport: [Int32] = [
      LIBSSH2_ERROR_SOCKET_SEND, LIBSSH2_ERROR_SOCKET_RECV, LIBSSH2_ERROR_SOCKET_DISCONNECT,
      LIBSSH2_ERROR_SOCKET_TIMEOUT, LIBSSH2_ERROR_TIMEOUT, LIBSSH2_ERROR_PROTO,
    ].map { Int32($0) }
    if transport.contains(rc) {
      if rc == Int32(LIBSSH2_ERROR_SOCKET_DISCONNECT) && authAttempted {
        throw SshError("ERR_AUTH", "authentication failed")
      }
      let (_, msg) = lastError()
      throw SshError("ERR_CONNECT", msg.isEmpty ? "connection lost during authentication" : msg)
    }
  }

  /// Closes a session that never started its loop (probe, failed connect).
  func abandon() {
    lock.lock()
    let wasStarted = started
    dead = true
    lock.unlock()
    guard !wasStarted else { return close() }
    freeSession()
  }


  func start() throws {
    var p: [Int32] = [0, 0]
    guard pipe(&p) == 0 else { throw SshError("ERR_SSH", "pipe failed") }
    Net.setNonBlocking(p[0])
    Net.setNonBlocking(p[1])
    lock.lock()
    wakeR = p[0]
    wakeW = p[1]
    started = true
    lock.unlock()
    let t = Thread { [self] in run() }
    t.name = "herdr-ssh-\(id.prefix(8))"
    t.qualityOfService = .userInitiated
    t.start()
  }

  /// Runs `block` on the loop thread. Returns false if the session is already dead.
  @discardableResult
  private func submit(_ block: @escaping () -> Void) -> Bool {
    lock.lock()
    if dead {
      lock.unlock()
      return false
    }
    inbox.append(block)
    var b: UInt8 = 1
    _ = Darwin.write(wakeW, &b, 1)
    lock.unlock()
    return true
  }

  private func run() {
    var idleSpins = 0
    var bufferedSpins = 0
    while true {
      lock.lock()
      let work = inbox
      inbox.removeAll()
      lock.unlock()
      progressed = !work.isEmpty
      work.forEach { $0() }
      if stopping { break }

      if let fatal = pass() {
        finish(reason: fatal)
        return
      }
      if stopping { break }

      if progressed {
        idleSpins = 0
        bufferedSpins = 0
        continue
      }
      if hasBufferedInput() && bufferedSpins < 3 {
        bufferedSpins += 1
        continue
      }
      bufferedSpins = 0
      let woke = waitForActivity()
      idleSpins = woke ? 0 : idleSpins + 1
      if idleSpins > 50 { usleep(5000) }
    }
    finish(reason: "session closed")
  }

  /// One pass over all work. Returns a reason if the session's transport failed.
  private func pass() -> String? {
    let rc = herdr_libssh2_pump(s)
    if rc < 0 && rc != EAGAIN_SSH {
      switch rc {
      case Int32(LIBSSH2_ERROR_SOCKET_RECV), Int32(LIBSSH2_ERROR_SOCKET_DISCONNECT):
        return "connection closed by the server"
      case Int32(LIBSSH2_ERROR_DECRYPT), Int32(LIBSSH2_ERROR_INVALID_MAC):
        return "connection corrupted (\(rc))"
      default:
        return "connection lost (\(rc))"
      }
    }
    if let fatal = stepTasks() { return fatal }
    for (id, ch) in streams {
      if let reason = pumpStream(ch) {
        if let fatal = transportFailure() { return fatal }
        streams.removeValue(forKey: id)
        collect(ch.ch)
        ch.failWrites(SshError("ERR_NO_CHANNEL", "channel is closed"))
        onClose?(id, reason)
        progressed = true
      }
    }
    var b = 0
    while b < bridges.count {
      if pumpBridge(bridges[b]) {
        if let fatal = transportFailure() { return fatal }
        let br = bridges.remove(at: b)
        Darwin.close(br.fd)
        collect(br.ch)
        progressed = true
      } else {
        b += 1
      }
    }
    if let fatal = stepTasks() { return fatal }
    var g = 0
    while g < garbage.count {
      var item = garbage[g]
      if !item.settled || item.abandoned {
        if herdr_libssh2_channel_flush_owned(item.ch) == EAGAIN_SSH {
          g += 1
          continue
        }
        if item.abandoned {
          garbage.remove(at: g)
          continue
        }
        item.settled = true
        garbage[g] = item
      }
      let rc = libssh2_channel_free(item.ch)
      if rc != EAGAIN_SSH {
        garbage.remove(at: g)
      } else if item.deadline.expired && herdr_libssh2_send_pending(s) == 0 {
        item.abandoned = true
        garbage[g] = item
        g += 1
      } else {
        g += 1
      }
    }
    sendKeepAlive()
    return transportFailure()
  }

  private func stepTasks() -> String? {
    var i = 0
    while i < tasks.count {
      switch tasks[i].step(self) {
      case .pending: i += 1
      case .done:
        tasks.remove(at: i)
        progressed = true
      case .fatal(let reason): return reason
      }
    }
    return nil
  }

  /// The session-level error, if libssh2's last error is a dead transport.
  fileprivate func transportFailure() -> String? {
    let (code, msg) = lastError()
    let fatal: [Int32] = [
      LIBSSH2_ERROR_SOCKET_SEND, LIBSSH2_ERROR_SOCKET_RECV, LIBSSH2_ERROR_SOCKET_DISCONNECT,
      LIBSSH2_ERROR_PROTO, LIBSSH2_ERROR_BAD_SOCKET, LIBSSH2_ERROR_DECRYPT, LIBSSH2_ERROR_INVALID_MAC,
      LIBSSH2_ERROR_KEX_FAILURE, LIBSSH2_ERROR_SOCKET_NONE,
    ].map { Int32($0) }
    return fatal.contains(code) ? (msg.isEmpty ? "connection lost" : msg) : nil
  }

  fileprivate func progress() { progressed = true }

  /// Keepalive (every 10 s, like ServerAliveInterval on Android). Only sent when the socket has room, so the
  /// small packet goes out whole: libssh2 can't resume a half-sent keepalive (its buffer is on the stack).
  private func sendKeepAlive() {
    guard herdr_libssh2_send_pending(s) == 0,
          streams.values.allSatisfy({ $0.queue.isEmpty }), bridges.allSatisfy({ $0.toCh.isEmpty }) else { return }
    var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
    guard poll(&pfd, 1, 0) == 1, pfd.revents & Int16(POLLOUT) != 0 else { return }
    var next: Int32 = 0
    _ = libssh2_keepalive_send(s, &next)
  }

  fileprivate func isOpener(_ owner: AnyObject) -> Bool { opener === owner }

  /// Frees a channel that won't be used again. If libssh2's half-sent packet is this channel's, it is sent
  /// out first: no other packet can be sent until it is, and nothing else would ever resend it.
  fileprivate func collect(_ ch: OpaquePointer?) {
    guard let ch else { return }
    garbage.append((ch, false, false, Deadline(ms: 10_000)))
  }

  fileprivate func acquireOpen(_ owner: AnyObject) -> Bool {
    if opener == nil { opener = owner }
    return opener === owner
  }

  fileprivate func releaseOpen(_ owner: AnyObject) {
    if opener === owner { opener = nil }
  }

  fileprivate var session: OpaquePointer { s }
  fileprivate var lastErrno: Int32 { libssh2_session_last_errno(s) }
  fileprivate var lastMessage: String { lastError().1 }

  private func hasBufferedInput() -> Bool {
    for ch in streams.values where libssh2_poll_channel_read(ch.ch, 0) > 0 { return true }
    for br in bridges where libssh2_poll_channel_read(br.ch, 0) > 0 && br.toFd.count < BRIDGE_BUFFER { return true }
    for t in tasks where t.hasBufferedInput() { return true }
    return false
  }

  /// Returns true if poll() reported activity.
  private func waitForActivity() -> Bool {
    var fds = [pollfd]()
    var events = Int16(POLLIN)
    if libssh2_session_block_directions(s) & Int32(LIBSSH2_SESSION_BLOCK_OUTBOUND) != 0 || herdr_libssh2_send_pending(s) != 0 {
      events |= Int16(POLLOUT)
    }
    fds.append(pollfd(fd: fd, events: events, revents: 0))
    fds.append(pollfd(fd: wakeR, events: Int16(POLLIN), revents: 0))
    for br in bridges {
      var e: Int16 = 0
      if !br.fdEof && br.toCh.count < BRIDGE_BUFFER { e |= Int16(POLLIN) }
      if !br.toFd.isEmpty { e |= Int16(POLLOUT) }
      fds.append(pollfd(fd: e == 0 ? -1 : br.fd, events: e, revents: 0))
    }
    var timeout = 5_000
    for t in tasks { if let d = t.deadline { timeout = min(timeout, max(1, d.remainingMs)) } }
    let n = poll(&fds, nfds_t(fds.count), Int32(timeout))
    if fds[1].revents != 0 {
      var buf = [UInt8](repeating: 0, count: 64)
      while Darwin.read(wakeR, &buf, buf.count) > 0 {}
    }
    return n > 0
  }

  private func finish(reason: String) {
    lock.lock()
    dead = true
    let leftovers = inbox
    inbox.removeAll()
    Darwin.close(wakeR)
    Darwin.close(wakeW)
    lock.unlock()
    leftovers.forEach { $0() }
    let err = SshError("ERR_NO_SESSION", "connection lost")
    tasks.forEach { $0.abort(err) }
    tasks.removeAll()
    for (id, ch) in streams {
      ch.failWrites(SshError("ERR_NO_CHANNEL", "channel is closed"))
      onClose?(id, reason)
    }
    streams.removeAll()
    for br in bridges { Darwin.close(br.fd) }
    bridges.removeAll()
    garbage.removeAll()
    freeSession()
    onDeath?()
  }


  func exec(_ command: String, timeoutMs: Int, completion: @escaping (Result<ExecResult, SshError>) -> Void) {
    let task = ExecTask(command: command, timeoutMs: timeoutMs, completion: completion)
    if !submit({ self.tasks.append(task) }) { completion(.failure(SshError("ERR_NO_SESSION", "connection lost"))) }
  }

  func openSocket(_ path: String, completion: @escaping (Result<String, SshError>) -> Void) {
    let task = OpenTask(kind: .streamLocal(path)) { result in
      switch result {
      case .failure(let e): completion(.failure(e))
      case .success(let ch):
        let stream = StreamChannel(ch: ch)
        self.streams[stream.id] = stream
        completion(.success(stream.id))
      }
    }
    if !submit({ self.tasks.append(task) }) { completion(.failure(SshError("ERR_NO_SESSION", "connection lost"))) }
  }

  /// Opens direct-tcpip to host:port and pumps it to/from `localFd` (the other socketpair end carries the
  /// next hop's SSH session). Takes ownership of `localFd`.
  func openBridge(host: String, port: Int, localFd: Int32, timeoutMs: Int,
                  completion: @escaping (SshError?) -> Void) {
    let task = OpenTask(kind: .directTcp(host, port), timeoutMs: timeoutMs) { result in
      switch result {
      case .failure(let e):
        Darwin.close(localFd)
        completion(e)
      case .success(let ch):
        self.bridges.append(Bridge(ch: ch, fd: localFd))
        completion(nil)
      }
    }
    if !submit({ self.tasks.append(task) }) {
      Darwin.close(localFd)
      completion(SshError("ERR_JUMP_UNREACHABLE", "the jump host connection was lost"))
    }
  }

  func write(channelId: String, data: Data, completion: @escaping (SshError?) -> Void) {
    let ok = submit {
      guard let ch = self.streams[channelId], !ch.closing else {
        return completion(SshError("ERR_NO_CHANNEL", "channel is closed"))
      }
      if data.isEmpty { return completion(nil) }
      ch.queue.append(PendingWrite(data: data, done: completion))
      self.progressed = true
    }
    if !ok { completion(SshError("ERR_NO_CHANNEL", "channel is closed")) }
  }

  func closeChannel(_ channelId: String) {
    submit {
      guard let ch = self.streams[channelId], !ch.closing else { return }
      ch.closing = true
      ch.closeDeadline = Deadline(ms: 5_000)
      self.progressed = true
    }
  }

  func close() {
    if !submit({ self.stopping = true }) { return }
  }


  /// Returns a close reason when the channel is finished.
  private func pumpStream(_ c: StreamChannel) -> String? {
    var buf = [UInt8](repeating: 0, count: READ_CHUNK)
    var text = ""
    var total = 0
    var closeReason: String?
    while total < BRIDGE_BUFFER {
      let n = buf.withUnsafeMutableBytes { p in
        libssh2_channel_read_ex(c.ch, 0, p.baseAddress!.assumingMemoryBound(to: CChar.self), READ_CHUNK)
      }
      if n > 0 {
        total += n
        text += buf.withUnsafeBufferPointer { c.decoder.decode(UnsafeBufferPointer(rebasing: $0[0..<n])) }
        continue
      }
      if n == Int(EAGAIN_SSH) { break }
      if n == 0 {
        if libssh2_channel_eof(c.ch) != 0 { closeReason = "eof" }
        break
      }
      closeReason = lastMessage.isEmpty ? "read error" : lastMessage
      break
    }
    if !text.isEmpty {
      progressed = true
      onData?(c.id, text)
    }
    if let closeReason { return closeReason }

    while let w = c.queue.first {
      let n = w.data.withUnsafeBytes { p in
        libssh2_channel_write_ex(
          c.ch, 0, p.baseAddress!.advanced(by: w.offset).assumingMemoryBound(to: CChar.self), w.data.count - w.offset)
      }
      if n == Int(EAGAIN_SSH) { break }
      if n < 0 {
        let msg = lastMessage
        c.failWrites(SshError("ERR_SSH", msg.isEmpty ? "write failed" : msg))
        return msg.isEmpty ? "write error" : msg
      }
      progressed = true
      w.offset += n
      if w.offset >= w.data.count {
        c.queue.removeFirst()
        w.done(nil)
      }
    }
    if c.closing && (c.queue.isEmpty || c.closeDeadline?.expired == true) {
      c.failWrites(SshError("ERR_NO_CHANNEL", "channel is closed"))
      return "eof"
    }
    return nil
  }

  /// Returns true when the bridge is finished.
  private func pumpBridge(_ b: Bridge) -> Bool {
    var buf = [UInt8](repeating: 0, count: READ_CHUNK)
    while b.toFd.count < BRIDGE_BUFFER {
      let n = buf.withUnsafeMutableBytes { p in
        libssh2_channel_read_ex(b.ch, 0, p.baseAddress!.assumingMemoryBound(to: CChar.self), READ_CHUNK)
      }
      if n > 0 {
        b.toFd.append(contentsOf: buf[0..<n])
        progressed = true
        continue
      }
      if n == Int(EAGAIN_SSH) { break }
      if n == 0 && libssh2_channel_eof(b.ch) == 0 { break }
      b.chEof = true
      break
    }
    while !b.toFd.isEmpty {
      let n = b.toFd.withUnsafeBytes { p in Darwin.write(b.fd, p.baseAddress!, p.count) }
      if n > 0 {
        b.toFd.removeFirst(n)
        progressed = true
        continue
      }
      if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { break }
      return true
    }
    while !b.fdEof && b.toCh.count < BRIDGE_BUFFER {
      let n = buf.withUnsafeMutableBytes { p in Darwin.read(b.fd, p.baseAddress!, READ_CHUNK) }
      if n > 0 {
        b.toCh.append(contentsOf: buf[0..<n])
        progressed = true
        continue
      }
      if n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK) { break }
      b.fdEof = true
    }
    while !b.toCh.isEmpty {
      let n = b.toCh.withUnsafeBytes { p in
        libssh2_channel_write_ex(b.ch, 0, p.baseAddress!.assumingMemoryBound(to: CChar.self), p.count)
      }
      if n == Int(EAGAIN_SSH) { break }
      if n < 0 { return true }
      b.toCh.removeFirst(n)
      progressed = true
    }
    if b.fdEof && b.toCh.isEmpty { return true }
    if b.chEof && b.toFd.isEmpty { return true }
    return false
  }
}


private final class PendingWrite {
  let data: Data
  var offset = 0
  let done: (SshError?) -> Void
  init(data: Data, done: @escaping (SshError?) -> Void) {
    self.data = data
    self.done = done
  }
}

private final class StreamChannel {
  let id = UUID().uuidString
  let ch: OpaquePointer
  var queue = [PendingWrite]()
  var decoder = Utf8Stream()
  var closing = false
  var closeDeadline: Deadline?
  init(ch: OpaquePointer) { self.ch = ch }

  func failWrites(_ e: SshError) {
    let q = queue
    queue.removeAll()
    q.forEach { $0.done(e) }
  }
}

private final class Bridge {
  let ch: OpaquePointer
  let fd: Int32
  var toFd = Data()
  var toCh = Data()
  var fdEof = false
  var chEof = false
  init(ch: OpaquePointer, fd: Int32) {
    self.ch = ch
    self.fd = fd
  }
}

private enum StepResult {
  case pending
  case done
  case fatal(String)
}

private protocol LoopTask: AnyObject {
  func step(_ s: SshSession) -> StepResult
  /// The session died; complete without touching libssh2.
  func abort(_ e: SshError)
  var deadline: Deadline? { get }
  func hasBufferedInput() -> Bool
}

/// Opens a direct-streamlocal (Herdr socket) or direct-tcpip (jump) channel. libssh2 keeps the open state
/// per session, so only one open runs at a time; a timed-out open is still driven to completion, then freed.
private final class OpenTask: LoopTask {
  enum Kind {
    case streamLocal(String)
    case directTcp(String, Int)
  }

  let kind: Kind
  let deadline: Deadline?
  private let timeoutMs: Int
  private var completion: ((Result<OpaquePointer, SshError>) -> Void)?
  private var started = false

  init(kind: Kind, timeoutMs: Int = 10_000, completion: @escaping (Result<OpaquePointer, SshError>) -> Void) {
    self.kind = kind
    self.timeoutMs = timeoutMs
    self.deadline = Deadline(ms: timeoutMs)
    self.completion = completion
  }

  private func complete(_ r: Result<OpaquePointer, SshError>) {
    let c = completion
    completion = nil
    c?(r)
  }

  func step(_ s: SshSession) -> StepResult {
    if completion != nil, let d = deadline, d.expired {
      complete(.failure(timeoutError()))
      if !started { return .done }
    }
    guard s.acquireOpen(self) else { return .pending }
    started = true
    let ch: OpaquePointer?
    switch kind {
    case .streamLocal(let path):
      ch = libssh2_channel_direct_streamlocal_ex(s.session, path, "", 0)
    case .directTcp(let host, let port):
      ch = libssh2_channel_direct_tcpip_ex(s.session, host, Int32(port), "127.0.0.1", 0)
    }
    if ch == nil && s.lastErrno == EAGAIN_SSH { return .pending }
    s.releaseOpen(self)
    s.progress()
    guard let ch else {
      if let fatal = s.transportFailure() {
        complete(.failure(lostError()))
        return .fatal(fatal)
      }
      complete(.failure(openError(s.lastMessage)))
      return .done
    }
    if completion == nil {
      s.collect(ch)
    } else {
      complete(.success(ch))
    }
    return .done
  }

  func abort(_ e: SshError) { complete(.failure(lostError())) }

  func hasBufferedInput() -> Bool { false }

  private func timeoutError() -> SshError {
    switch kind {
    case .streamLocal: return SshError("ERR_CHANNEL", "timeout: channel open did not finish")
    case .directTcp: return SshError("ERR_JUMP_UNREACHABLE", "the jump host did not open a channel to the target in time")
    }
  }

  private func lostError() -> SshError {
    switch kind {
    case .streamLocal: return SshError("ERR_NO_SESSION", "connection lost")
    case .directTcp: return SshError("ERR_JUMP_UNREACHABLE", "the jump host connection was lost")
    }
  }

  private func openError(_ msg: String) -> SshError {
    let prohibited = msg.contains("administratively prohibited")
    let connectFailed = msg.contains("(connect failed)")
    switch kind {
    case .streamLocal(let path):
      if prohibited {
        return SshError("ERR_FORWARDING_PROHIBITED", "sshd refused Unix-socket forwarding (AllowStreamLocalForwarding)")
      }
      if connectFailed { return SshError("ERR_SOCKET_UNAVAILABLE", "nothing is listening on \(path)") }
      return SshError("ERR_CHANNEL", msg.isEmpty ? "channel open failed" : msg)
    case .directTcp:
      if prohibited {
        return SshError("ERR_JUMP_PROHIBITED", "the jump host's sshd refused TCP forwarding (AllowTcpForwarding)")
      }
      if connectFailed { return SshError("ERR_JUMP_UNREACHABLE", "the jump host could not reach the target") }
      return SshError("ERR_JUMP_UNREACHABLE", msg.isEmpty ? "jump channel failed" : msg)
    }
  }
}

/// exec: open a session channel, run the command, collect stdout/stderr (1 MiB each) and the exit status.
/// After a timeout or error the channel is still closed properly so libssh2 is never left mid-operation.
private final class ExecTask: LoopTask {
  private enum State {
    case open, start, read, close, waitClosed
  }

  private let command: String
  private let timeoutMs: Int
  let deadline: Deadline?
  private var completion: ((Result<ExecResult, SshError>) -> Void)?
  private var state = State.open
  private var ch: OpaquePointer?
  private var out = Data()
  private var err = Data()
  private var closeFlushed = false

  init(command: String, timeoutMs: Int, completion: @escaping (Result<ExecResult, SshError>) -> Void) {
    self.command = command
    self.timeoutMs = timeoutMs
    self.deadline = Deadline(ms: timeoutMs)
    self.completion = completion
  }

  private func complete(_ r: Result<ExecResult, SshError>) {
    let c = completion
    completion = nil
    c?(r)
  }

  private func fail(_ e: SshError) {
    complete(.failure(e))
    if ch != nil && (state == .read) { state = .close }
  }

  func abort(_ e: SshError) { complete(.failure(e)) }

  func hasBufferedInput() -> Bool {
    guard let ch, state == .read else { return false }
    return libssh2_poll_channel_read(ch, 1) > 0
  }

  func step(_ s: SshSession) -> StepResult {
    if completion != nil, let d = deadline, d.expired {
      fail(SshError("ERR_TIMEOUT", "command did not finish within \(timeoutMs / 1000) s"))
      if state == .open && ch == nil && !s.isOpener(self) { return .done }
    }
    switch state {
    case .open:
      guard s.acquireOpen(self) else { return .pending }
      let c = libssh2_channel_open_ex(s.session, "session", 7, WINDOW, PACKET, nil, 0)
      if c == nil && s.lastErrno == EAGAIN_SSH { return .pending }
      s.releaseOpen(self)
      s.progress()
      guard let c else {
        if let fatal = s.transportFailure() {
          complete(.failure(SshError("ERR_NO_SESSION", "connection lost")))
          return .fatal(fatal)
        }
        complete(.failure(SshError("ERR_SSH", "could not open an exec channel: \(s.lastMessage)")))
        return .done
      }
      ch = c
      state = completion == nil ? .close : .start
      return .pending
    case .start:
      let rc = libssh2_channel_process_startup(ch, "exec", 4, command, UInt32(command.utf8.count))
      if rc == EAGAIN_SSH { return .pending }
      s.progress()
      if rc < 0 {
        complete(.failure(SshError("ERR_SSH", "exec request failed: \(s.lastMessage)")))
        state = .close
      } else {
        state = completion == nil ? .close : .read
      }
      return .pending
    case .read:
      var outDone = false
      var errDone = false
      if let e = drain(s, stream: 0, into: &out, ended: &outDone) ?? drain(s, stream: 1, into: &err, ended: &errDone) {
        if s.transportFailure() != nil {
          complete(.failure(SshError("ERR_NO_SESSION", "connection lost")))
          return .fatal(s.lastMessage)
        }
        fail(e)
        return .pending
      }
      if outDone && errDone {
        state = .close
        s.progress()
      }
      return .pending
    case .close:
      if !closeFlushed {
        if herdr_libssh2_channel_flush_owned(ch) == EAGAIN_SSH { return .pending }
        closeFlushed = true
      }
      let rc = libssh2_channel_close(ch)
      if rc == EAGAIN_SSH { return .pending }
      s.progress()
      state = .waitClosed
      return .pending
    case .waitClosed:
      let rc = libssh2_channel_wait_closed(ch)
      if rc == EAGAIN_SSH { return .pending }
      var sig: UnsafeMutablePointer<CChar>?
      var sigLen = 0
      _ = libssh2_channel_get_exit_signal(ch, &sig, &sigLen, nil, nil, nil, nil)
      let exit = sig != nil ? -1 : Int(libssh2_channel_get_exit_status(ch))
      if let sig { libssh2_free(s.session, sig) }
      s.collect(ch)
      ch = nil
      complete(.success(ExecResult(
        stdout: String(decoding: out, as: UTF8.self), stderr: String(decoding: err, as: UTF8.self), exitCode: exit)))
      return .done
    }
  }

  /// Reads one stream until it would block. Returns an error to stop the command.
  private func drain(_ s: SshSession, stream: Int32, into data: inout Data, ended: inout Bool) -> SshError? {
    var buf = [UInt8](repeating: 0, count: READ_CHUNK)
    while true {
      let n = buf.withUnsafeMutableBytes { p in
        libssh2_channel_read_ex(ch, stream, p.baseAddress!.assumingMemoryBound(to: CChar.self), READ_CHUNK)
      }
      if n > 0 {
        s.progress()
        if data.count + n > OUTPUT_LIMIT { return SshError("ERR_EXEC", "command output too large") }
        data.append(contentsOf: buf[0..<n])
        continue
      }
      if n == 0 {
        ended = libssh2_channel_eof(ch) != 0
        return nil
      }
      if n == Int(EAGAIN_SSH) { return nil }
      return SshError("ERR_EXEC", s.lastMessage.isEmpty ? "exec read failed" : s.lastMessage)
    }
  }
}
