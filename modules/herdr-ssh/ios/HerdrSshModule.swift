import ExpoModulesCore
import UIKit

public class HerdrSshModule: Module {
  private let client = SshClient()
  private let work = DispatchQueue(label: "herdr-ssh.work", qos: .userInitiated, attributes: .concurrent)
  private let monitor = BackgroundMonitor()
  private let privacy = PrivacyCover()

  public func definition() -> ModuleDefinition {
    Name("HerdrSsh")

    Events("onChannelData", "onChannelClose")

    OnCreate {
      Libssh2.ensureInit()
      self.client.onData = { [weak self] ch, data in
        self?.sendEvent("onChannelData", ["channelId": ch, "data": data])
      }
      self.client.onClose = { [weak self] ch, reason in
        self?.sendEvent("onChannelClose", ["channelId": ch, "reason": reason])
      }
    }

    AsyncFunction("probeHostKey") { (host: String, port: Int, viaSessionId: String?, promise: Promise) in
      self.run(promise) {
        let info = try self.client.probeHostKey(host: host, port: port, via: viaSessionId)
        return ["algorithm": info.algorithm, "key": info.key, "fingerprint": info.fingerprint]
      }
    }

    AsyncFunction("generateEd25519") { (comment: String, promise: Promise) in
      self.run(promise) {
        let k = Keys.generateEd25519(comment: comment)
        return ["privateKey": k.privateKey, "publicKey": k.publicKey]
      }
    }

    AsyncFunction("connect") {
      (host: String, port: Int, username: String, auth: [String: Any], pinnedKey: String, viaSessionId: String?,
       promise: Promise) in
      self.run(promise) {
        let password = (auth["password"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        let privateKey = (auth["privateKey"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return try self.client.connect(
          host: host, port: port, user: username, password: password, privateKey: privateKey,
          pinnedKey: pinnedKey, via: viaSessionId)
      }
    }

    AsyncFunction("exec") { (sessionId: String, command: String, timeoutMs: Int?, promise: Promise) in
      self.client.exec(sessionId, command, timeoutMs: timeoutMs) { result in
        self.settle(promise, result.map { ["stdout": $0.stdout, "stderr": $0.stderr, "exitCode": $0.exitCode] })
      }
    }

    AsyncFunction("openSocket") { (sessionId: String, socketPath: String, promise: Promise) in
      self.client.openSocket(sessionId, socketPath) { self.settle(promise, $0) }
    }

    AsyncFunction("write") { (channelId: String, data: String, promise: Promise) in
      self.client.write(channelId, Data(data.utf8)) { e in
        if let e { self.settle(promise, Result<Any?, SshError>.failure(e)) } else { promise.resolve(nil) }
      }
    }

    Function("closeChannel") { (channelId: String) in
      self.client.closeChannel(channelId)
    }

    Function("disconnect") { (sessionId: String) in
      self.client.disconnect(sessionId)
    }

    Function("startMonitoring") { (_: String) in
      self.monitor.start()
    }

    Function("stopMonitoring") {
      self.monitor.stop()
    }

    Function("setSecureScreen") { (on: Bool) in
      self.privacy.setEnabled(on)
    }

    OnDestroy {
      self.monitor.stop()
      self.privacy.setEnabled(false)
      self.client.disconnectAll()
    }
  }

  private func settle<T>(_ promise: Promise, _ result: Result<T, SshError>) {
    switch result {
    case .success(let v): promise.resolve(v)
    case .failure(let e): promise.reject(Exception(name: "SshError", description: e.message, code: e.code))
    }
  }

  private func run(_ promise: Promise, _ block: @escaping () throws -> Any?) {
    work.async {
      do {
        promise.resolve(try block())
      } catch let e as SshError {
        promise.reject(Exception(name: "SshError", description: e.message, code: e.code))
      } catch {
        promise.reject(Exception(name: "SshError", description: error.localizedDescription, code: "ERR_SSH"))
      }
    }
  }
}

/// iOS has no foreground service. While monitoring is on, a background task asks for the extra time iOS
/// grants after the app leaves the foreground (about 30 s), so a short app switch doesn't drop connections.
/// After that iOS suspends the app and the app reconnects when it returns (see docs/SPIKE.md).
final class BackgroundMonitor {
  private var active = false
  private var task = UIBackgroundTaskIdentifier.invalid
  private var observers = [NSObjectProtocol]()

  func start() {
    DispatchQueue.main.async {
      guard !self.active else { return }
      self.active = true
      let nc = NotificationCenter.default
      self.observers = [
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
          self.begin()
        },
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { _ in
          self.end()
        },
      ]
      if UIApplication.shared.applicationState == .background { self.begin() }
    }
  }

  func stop() {
    DispatchQueue.main.async {
      guard self.active else { return }
      self.active = false
      self.observers.forEach { NotificationCenter.default.removeObserver($0) }
      self.observers = []
      self.end()
    }
  }

  private func begin() {
    guard task == .invalid else { return }
    task = UIApplication.shared.beginBackgroundTask(withName: "HerdrMonitor") { [weak self] in self?.end() }
  }

  private func end() {
    guard task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
    task = .invalid
  }
}

/// Android's FLAG_SECURE blocks screenshots and blanks the recents thumbnail. iOS apps can't block
/// screenshots, so the closest equivalent is covering the window while the app is inactive, which keeps
/// terminal contents out of the app switcher snapshot.
final class PrivacyCover {
  private var enabled = false
  private var cover: UIView?
  private var observers = [NSObjectProtocol]()

  func setEnabled(_ on: Bool) {
    DispatchQueue.main.async {
      guard on != self.enabled else { return }
      self.enabled = on
      let nc = NotificationCenter.default
      if on {
        self.observers = [
          nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            self.show()
          },
          nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            self.hide()
          },
        ]
      } else {
        self.observers.forEach { nc.removeObserver($0) }
        self.observers = []
        self.hide()
      }
    }
  }

  private func show() {
    guard cover == nil, let window = Self.keyWindow() else { return }
    let v = UIView(frame: window.bounds)
    v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    v.backgroundColor = UIColor(red: 0x0f / 255.0, green: 0x11 / 255.0, blue: 0x15 / 255.0, alpha: 1)
    window.addSubview(v)
    cover = v
  }

  private func hide() {
    cover?.removeFromSuperview()
    cover = nil
  }

  private static func keyWindow() -> UIWindow? {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap { $0.windows }
      .first { $0.isKeyWindow }
  }
}
