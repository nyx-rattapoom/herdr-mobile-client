import CryptoKit
import Darwin
import Foundation


struct SshError: Error, CustomStringConvertible {
  let code: String
  let message: String
  init(_ code: String, _ message: String) {
    self.code = code
    self.message = message
  }
  var description: String { "\(code): \(message)" }
}

struct ExecResult {
  let stdout: String
  let stderr: String
  let exitCode: Int
}

struct HostKeyInfo {
  let algorithm: String
  let key: String
  let fingerprint: String

  init(blob: Data) {
    algorithm = HostKeys.algorithm(blob)
    key = blob.base64EncodedString()
    fingerprint = HostKeys.fingerprintSha256(blob)
  }
}

struct Deadline {
  private let end: UInt64

  init(ms: Int) {
    end = DispatchTime.now().uptimeNanoseconds + UInt64(max(0, ms)) * 1_000_000
  }

  var remainingMs: Int {
    let now = DispatchTime.now().uptimeNanoseconds
    return now >= end ? 0 : Int((end - now) / 1_000_000)
  }

  var expired: Bool { remainingMs <= 0 }
}

enum HostKeys {
  static func fingerprintSha256(_ blob: Data) -> String {
    let digest = Data(SHA256.hash(data: blob))
    return "SHA256:" + digest.base64EncodedString().replacingOccurrences(of: "=", with: "")
  }

  static func algorithm(_ blob: Data) -> String {
    let b = [UInt8](blob)
    guard b.count >= 4 else { return "unknown" }
    let len = Int(b[0]) << 24 | Int(b[1]) << 16 | Int(b[2]) << 8 | Int(b[3])
    guard len > 0, len <= b.count - 4 else { return "unknown" }
    return String(decoding: b[4..<(4 + len)], as: UTF8.self)
  }

  static func equal(_ a: Data, _ b: Data) -> Bool {
    guard a.count == b.count else { return false }
    var diff: UInt8 = 0
    for (x, y) in zip(a, b) { diff |= x ^ y }
    return diff == 0
  }
}

enum Keys {
  /// An OpenSSH-format (openssh-key-v1, unencrypted) Ed25519 key pair, the same shape JSch writes on Android.
  static func generateEd25519(comment: String) -> (privateKey: String, publicKey: String) {
    let key = Curve25519.Signing.PrivateKey()
    let seed = key.rawRepresentation
    let pub = key.publicKey.rawRepresentation
    let comment = sanitizeComment(comment)

    var pubBlob = Data()
    pubBlob.sshString("ssh-ed25519")
    pubBlob.sshString(pub)

    var check = [UInt8](repeating: 0, count: 4)
    if SecRandomCopyBytes(kSecRandomDefault, 4, &check) != errSecSuccess {
      check = [UInt8]((0..<4).map { _ in UInt8.random(in: 0...255) })
    }
    var priv = Data()
    priv.append(contentsOf: check)
    priv.append(contentsOf: check)
    priv.sshString("ssh-ed25519")
    priv.sshString(pub)
    priv.sshString(seed + pub)
    priv.sshString(comment)
    var pad: UInt8 = 1
    while priv.count % 8 != 0 {
      priv.append(pad)
      pad += 1
    }

    var body = Data("openssh-key-v1".utf8)
    body.append(0)
    body.sshString("none")
    body.sshString("none")
    body.sshString(Data())
    body.sshUInt32(1)
    body.sshString(pubBlob)
    body.sshString(priv)

    let b64 = body.base64EncodedString(options: [.lineLength64Characters, .endLineWithLineFeed])
    let pem = "-----BEGIN OPENSSH PRIVATE KEY-----\n\(b64)\n-----END OPENSSH PRIVATE KEY-----\n"
    let publicKey = "ssh-ed25519 \(pubBlob.base64EncodedString()) \(comment)"
    priv.resetBytes(in: 0..<priv.count)
    return (pem, publicKey)
  }

  static func sanitizeComment(_ c: String) -> String {
    let kept = c.unicodeScalars.filter { $0 == " " || (0x21...0x7e).contains($0.value) }
    let s = String(String.UnicodeScalarView(kept)).trimmingCharacters(in: .whitespaces)
    let t = String(s.prefix(64))
    return t.isEmpty ? "herdr-client" : t
  }
}

extension Data {
  mutating func sshUInt32(_ v: UInt32) {
    append(contentsOf: [UInt8(v >> 24 & 0xff), UInt8(v >> 16 & 0xff), UInt8(v >> 8 & 0xff), UInt8(v & 0xff)])
  }

  mutating func sshString(_ d: Data) {
    sshUInt32(UInt32(d.count))
    append(d)
  }

  mutating func sshString(_ s: String) {
    sshString(Data(s.utf8))
  }
}

/// Incremental UTF-8 decoding: a multi-byte sequence split across reads is held back until it completes.
struct Utf8Stream {
  private var pending = [UInt8]()

  mutating func decode(_ bytes: UnsafeBufferPointer<UInt8>) -> String {
    pending.append(contentsOf: bytes)
    let cut = Utf8Stream.completePrefix(pending)
    let s = String(decoding: pending[0..<cut], as: UTF8.self)
    pending.removeFirst(cut)
    return s
  }

  /// Length of the longest prefix that does not end inside an incomplete (but so far valid) sequence.
  static func completePrefix(_ b: [UInt8]) -> Int {
    let n = b.count
    var i = n - 1
    var back = 0
    while i >= 0 && back < 4 {
      let c = b[i]
      if c & 0xC0 != 0x80 {
        let need: Int
        if c & 0x80 == 0 { need = 1 }
        else if c & 0xE0 == 0xC0 { need = 2 }
        else if c & 0xF0 == 0xE0 { need = 3 }
        else if c & 0xF8 == 0xF0 { need = 4 }
        else { return n }
        return n - i < need ? i : n
      }
      i -= 1
      back += 1
    }
    return n
  }
}

enum Net {
  static func setNonBlocking(_ fd: Int32) {
    let flags = fcntl(fd, F_GETFL, 0)
    _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
  }

  static func noSigPipe(_ fd: Int32) {
    var on: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
  }

  /// TCP keepalive so a silently dead peer is noticed (~40 s), like ServerAliveInterval/CountMax on Android.
  private static func tune(_ fd: Int32) {
    var on: Int32 = 1
    var idle: Int32 = 10
    var intvl: Int32 = 10
    var cnt: Int32 = 3
    let sz = socklen_t(MemoryLayout<Int32>.size)
    _ = setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sz)
    _ = setsockopt(fd, SOL_SOCKET, SO_KEEPALIVE, &on, sz)
    _ = setsockopt(fd, IPPROTO_TCP, TCP_KEEPALIVE, &idle, sz)
    _ = setsockopt(fd, IPPROTO_TCP, TCP_KEEPINTVL, &intvl, sz)
    _ = setsockopt(fd, IPPROTO_TCP, TCP_KEEPCNT, &cnt, sz)
  }

  static func connect(host: String, port: Int, deadline: Deadline) throws -> Int32 {
    var hints = addrinfo()
    hints.ai_family = AF_UNSPEC
    hints.ai_socktype = SOCK_STREAM
    hints.ai_protocol = IPPROTO_TCP
    var res: UnsafeMutablePointer<addrinfo>?
    let rc = getaddrinfo(host, String(port), &hints, &res)
    if rc != 0 {
      throw SshError("ERR_CONNECT", "unknown host \(host): \(String(cString: gai_strerror(rc)))")
    }
    defer { freeaddrinfo(res) }
    var addresses = [UnsafeMutablePointer<addrinfo>]()
    var p = res
    while let ai = p {
      addresses.append(ai)
      p = ai.pointee.ai_next
    }
    var lastError = "connection failed"
    for (index, ai) in addresses.enumerated() {
      let share = max(2_000, deadline.remainingMs / (addresses.count - index))
      let attempt = Deadline(ms: min(share, deadline.remainingMs))
      let fd = socket(ai.pointee.ai_family, ai.pointee.ai_socktype, ai.pointee.ai_protocol)
      if fd < 0 { continue }
      setNonBlocking(fd)
      noSigPipe(fd)
      tune(fd)
      if Darwin.connect(fd, ai.pointee.ai_addr, ai.pointee.ai_addrlen) == 0 { return fd }
      if errno == EINPROGRESS {
        var pfd = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
        var n: Int32
        repeat {
          n = poll(&pfd, 1, Int32(attempt.remainingMs))
        } while n < 0 && errno == EINTR
        if n == 0 {
          close(fd)
          if deadline.expired { throw SshError("ERR_TIMEOUT", "connection timed out") }
          lastError = "connection timed out"
          continue
        }
        var soErr: Int32 = 0
        var len = socklen_t(MemoryLayout<Int32>.size)
        _ = getsockopt(fd, SOL_SOCKET, SO_ERROR, &soErr, &len)
        if n > 0 && soErr == 0 { return fd }
        lastError = String(cString: strerror(soErr != 0 ? soErr : errno))
      } else {
        lastError = String(cString: strerror(errno))
      }
      close(fd)
    }
    if lastError == "connection timed out" { throw SshError("ERR_TIMEOUT", lastError) }
    throw SshError("ERR_CONNECT", lastError)
  }

  /// A connected local socket pair: one end carries an SSH session, the other is pumped through a channel.
  static func socketPair() throws -> (Int32, Int32) {
    var fds: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0 else {
      throw SshError("ERR_SSH", "socketpair failed: \(String(cString: strerror(errno)))")
    }
    for fd in fds {
      setNonBlocking(fd)
      noSigPipe(fd)
    }
    return (fds[0], fds[1])
  }
}
