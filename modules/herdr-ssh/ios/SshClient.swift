import Darwin
import Foundation

let CONNECT_TIMEOUT_MS = 15_000
let DEFAULT_EXEC_TIMEOUT_MS = 120_000
let MAX_EXEC_TIMEOUT_MS = 600_000

/// All sessions and channels of the app. Thread-safe. probe and connect block the caller's thread (up to the
/// connect timeout). Everything on a live session runs on that session's loop and completes via callback, so
/// a stalled channel never holds a thread.
final class SshClient {
  private let lock = NSLock()
  private var sessions = [String: SshSession]()
  private var channelOwner = [String: SshSession]()

  var onData: ((String, String) -> Void)?
  var onClose: ((String, String) -> Void)?

  private func liveSession(_ id: String) throws -> SshSession {
    lock.lock()
    defer { lock.unlock() }
    guard let s = sessions[id] else { throw SshError("ERR_NO_SESSION", "not connected") }
    guard s.isAlive else {
      sessions.removeValue(forKey: id)
      throw SshError("ERR_NO_SESSION", "connection lost")
    }
    return s
  }

  /// A socket to host:port: plain TCP, or a direct-tcpip channel on the jump session bridged to a socketpair.
  private func transport(host: String, port: Int, via: String?, deadline: Deadline) throws -> Int32 {
    guard let via else { return try Net.connect(host: host, port: port, deadline: deadline) }
    lock.lock()
    let jump = sessions[via]
    lock.unlock()
    guard let jump, jump.isAlive else { throw SshError("ERR_JUMP_UNREACHABLE", "the jump host connection was lost") }
    let (local, remote) = try Net.socketPair()
    let done = DispatchSemaphore(value: 0)
    var failure: SshError?
    jump.openBridge(host: host, port: port, localFd: remote, timeoutMs: max(1, deadline.remainingMs)) { e in
      failure = e
      done.signal()
    }
    done.wait()
    if let failure {
      close(local)
      throw failure
    }
    return local
  }

  /// Key exchange only, to show the fingerprint for pinning. Never authenticates.
  func probeHostKey(host: String, port: Int, via: String?) throws -> HostKeyInfo {
    let deadline = Deadline(ms: CONNECT_TIMEOUT_MS)
    let session = try SshSession(fd: transport(host: host, port: port, via: via, deadline: deadline))
    defer { session.abandon() }
    return HostKeyInfo(blob: try session.handshake(deadline))
  }

  func connect(host: String, port: Int, user: String, password: String?, privateKey: String?,
               pinnedKey: String, via: String?) throws -> String {
    guard let pinned = Data(base64Encoded: pinnedKey), !pinned.isEmpty else {
      throw SshError("ERR_ARGS", "invalid pinned key")
    }
    if password == nil && privateKey == nil { throw SshError("ERR_ARGS", "no credentials") }
    let deadline = Deadline(ms: CONNECT_TIMEOUT_MS)
    let session = try SshSession(fd: transport(host: host, port: port, via: via, deadline: deadline))
    do {
      let key = try session.handshake(deadline)
      guard HostKeys.equal(key, pinned) else {
        throw SshError(
          "ERR_HOSTKEY_MISMATCH",
          "host key does not match the pinned key (server sent \(HostKeys.fingerprintSha256(key)))")
      }
      try session.authenticate(user: user, password: password, privateKey: privateKey, deadline: deadline)
      session.onData = { [weak self] ch, data in self?.onData?(ch, data) }
      session.onClose = { [weak self] ch, reason in
        guard let self else { return }
        self.lock.lock()
        self.channelOwner.removeValue(forKey: ch)
        self.lock.unlock()
        self.onClose?(ch, reason)
      }
      session.onDeath = { [weak self, id = session.id] in
        guard let self else { return }
        self.lock.lock()
        self.sessions.removeValue(forKey: id)
        self.lock.unlock()
      }
      lock.lock()
      sessions[session.id] = session
      lock.unlock()
      try session.start()
    } catch {
      lock.lock()
      sessions.removeValue(forKey: session.id)
      lock.unlock()
      session.abandon()
      throw error
    }
    return session.id
  }

  func exec(_ sessionId: String, _ command: String, timeoutMs: Int?,
            completion: @escaping (Result<ExecResult, SshError>) -> Void) {
    let session: SshSession
    do { session = try liveSession(sessionId) } catch { return completion(.failure(error as! SshError)) }
    let timeout = min(max(timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS, 1_000), MAX_EXEC_TIMEOUT_MS)
    session.exec(command, timeoutMs: timeout, completion: completion)
  }

  func openSocket(_ sessionId: String, _ path: String, completion: @escaping (Result<String, SshError>) -> Void) {
    let session: SshSession
    do { session = try liveSession(sessionId) } catch { return completion(.failure(error as! SshError)) }
    session.openSocket(path) { result in
      if case .success(let ch) = result {
        self.lock.lock()
        self.channelOwner[ch] = session
        self.lock.unlock()
      }
      completion(result)
    }
  }

  func write(_ channelId: String, _ data: Data, completion: @escaping (SshError?) -> Void) {
    lock.lock()
    let session = channelOwner[channelId]
    lock.unlock()
    guard let session else { return completion(SshError("ERR_NO_CHANNEL", "channel is closed")) }
    session.write(channelId: channelId, data: data, completion: completion)
  }

  func closeChannel(_ channelId: String) {
    lock.lock()
    let session = channelOwner[channelId]
    lock.unlock()
    session?.closeChannel(channelId)
  }

  func disconnect(_ sessionId: String) {
    lock.lock()
    let session = sessions.removeValue(forKey: sessionId)
    lock.unlock()
    session?.close()
  }

  func disconnectAll() {
    lock.lock()
    let all = Array(sessions.values)
    sessions.removeAll()
    lock.unlock()
    all.forEach { $0.close() }
  }
}
