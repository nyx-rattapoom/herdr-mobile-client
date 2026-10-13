package expo.modules.herdrssh

import android.util.Base64
import android.view.WindowManager
import com.jcraft.jsch.ChannelDirectStreamLocal
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchChangedHostKeyException
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.JSchUnknownHostKeyException
import com.jcraft.jsch.KeyPair
import com.jcraft.jsch.Session
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.InputStreamReader
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

private const val CONNECT_TIMEOUT_MS = 15_000
private const val CHANNEL_TIMEOUT_MS = 10_000
private const val DEFAULT_EXEC_TIMEOUT_MS = 120_000

// SSH_MSG_CHANNEL_OPEN_FAILURE reason codes (RFC 4254 §5.1).
private const val OPEN_ADMINISTRATIVELY_PROHIBITED = 1
private const val OPEN_CONNECT_FAILED = 2

class SshError(code: String, message: String, cause: Throwable? = null) :
  CodedException(code, message, cause)

private class StreamChannel(val channel: ChannelDirectStreamLocal, val out: OutputStream)

class HerdrSshModule : Module() {
  private val io = Executors.newCachedThreadPool()
  private val sessions = ConcurrentHashMap<String, Session>()
  private val channels = ConcurrentHashMap<String, StreamChannel>()

  override fun definition() = ModuleDefinition {
    Name("HerdrSsh")

    Events("onChannelData", "onChannelClose")

    // Completes key exchange without any credentials configured and returns the server's
    // host key. Authentication is never attempted.
    AsyncFunction("probeHostKey") { host: String, port: Int, promise: Promise ->
      run(promise) {
        val repo = PinnedHostKeyRepository(null)
        val session = newSession(host, port, "probe", repo)
        try {
          session.connect(CONNECT_TIMEOUT_MS)
          session.disconnect()
          throw SshError("ERR_PROBE", "server accepted the probe without host key verification")
        } catch (e: JSchUnknownHostKeyException) {
          val key = repo.captured ?: throw SshError("ERR_PROBE", "no host key received", e)
          hostKeyInfo(key)
        } catch (e: JSchException) {
          throw mapConnectError(e)
        } finally {
          session.disconnect()
        }
      }
    }

    // Generates an Ed25519 key pair on the device. The private key is returned in OpenSSH
    // format for the app to keep in Keystore-backed storage; it never leaves the device.
    AsyncFunction("generateEd25519") { comment: String, promise: Promise ->
      run(promise) { Keys.generateEd25519(comment) }
    }

    // Connects only if the server presents exactly the pinned key. Credentials are configured
    // here but JSch uses them only after the host key check passes. With both a key and a
    // password, public-key auth is tried first and the password is the fallback.
    AsyncFunction("connect") { host: String, port: Int, username: String, auth: Map<String, Any?>, pinnedKey: String, promise: Promise ->
      run(promise) {
        val pinned = decodeKey(pinnedKey)
        val password = (auth["password"] as? String)?.takeIf { it.isNotEmpty() }
        val privateKey = (auth["privateKey"] as? String)?.takeIf { it.isNotEmpty() }
        if (password == null && privateKey == null) throw SshError("ERR_ARGS", "no credentials")
        val repo = PinnedHostKeyRepository(pinned)
        val jsch = JSch()
        if (privateKey != null) {
          try {
            jsch.addIdentity("herdr-client", privateKey.toByteArray(Charsets.UTF_8), null, null)
          } catch (e: JSchException) {
            throw SshError("ERR_ARGS", "stored private key is unreadable", e)
          }
        }
        val session = newSession(jsch, host, port, username, repo)
        session.setConfig(
          "PreferredAuthentications",
          listOfNotNull(privateKey?.let { "publickey" }, password?.let { "password,keyboard-interactive" }).joinToString(","),
        )
        if (password != null) {
          session.userInfo = PasswordUserInfo(password)
          session.setPassword(password)
        }
        try {
          session.connect(CONNECT_TIMEOUT_MS)
        } catch (e: JSchException) {
          session.disconnect()
          throw mapConnectError(e, repo)
        }
        val id = UUID.randomUUID().toString()
        sessions[id] = session
        id
      }
    }

    // Runs a command with a hard deadline (see Exec.run).
    AsyncFunction("exec") { sessionId: String, command: String, timeoutMs: Int?, promise: Promise ->
      run(promise) {
        Exec.run(requireSession(sessionId), command, (timeoutMs ?: DEFAULT_EXEC_TIMEOUT_MS).toLong(), io)
      }
    }

    AsyncFunction("openSocket") { sessionId: String, socketPath: String, promise: Promise ->
      run(promise) {
        val session = requireSession(sessionId)
        val channel = session.openChannel("direct-streamlocal@openssh.com") as ChannelDirectStreamLocal
        channel.socketPath = socketPath
        val input = channel.inputStream
        try {
          channel.connect(CHANNEL_TIMEOUT_MS)
        } catch (e: JSchException) {
          channel.disconnect()
          throw when (channel.exitStatus) {
            OPEN_ADMINISTRATIVELY_PROHIBITED -> SshError(
              "ERR_FORWARDING_PROHIBITED",
              "sshd refused Unix-socket forwarding (AllowStreamLocalForwarding)", e)
            OPEN_CONNECT_FAILED -> SshError(
              "ERR_SOCKET_UNAVAILABLE", "nothing is listening on $socketPath", e)
            else -> SshError("ERR_CHANNEL", e.message ?: "channel open failed", e)
          }
        }
        val id = UUID.randomUUID().toString()
        channels[id] = StreamChannel(channel, channel.outputStream)
        io.execute {
          var reason = "eof"
          try {
            val reader = InputStreamReader(input, Charsets.UTF_8)
            val buf = CharArray(8192)
            while (true) {
              val n = reader.read(buf)
              if (n < 0) break
              sendEvent("onChannelData", mapOf("channelId" to id, "data" to String(buf, 0, n)))
            }
          } catch (e: Exception) {
            reason = e.message ?: "read error"
          } finally {
            channels.remove(id)
            channel.disconnect()
            sendEvent("onChannelClose", mapOf("channelId" to id, "reason" to reason))
          }
        }
        id
      }
    }

    AsyncFunction("write") { channelId: String, data: String, promise: Promise ->
      run(promise) {
        val ch = channels[channelId] ?: throw SshError("ERR_NO_CHANNEL", "channel is closed")
        synchronized(ch) {
          ch.out.write(data.toByteArray(Charsets.UTF_8))
          ch.out.flush()
        }
        null
      }
    }

    Function("closeChannel") { channelId: String ->
      channels.remove(channelId)?.channel?.disconnect()
    }

    Function("disconnect") { sessionId: String ->
      sessions.remove(sessionId)?.disconnect()
    }

    Function("startMonitoring") { text: String ->
      appContext.reactContext?.let { MonitorService.start(it, text) }
    }

    // FLAG_SECURE: keeps app content out of screenshots, screen recording and the recents preview.
    Function("setSecureScreen") { on: Boolean ->
      val activity = appContext.currentActivity ?: return@Function null
      activity.runOnUiThread {
        if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      null
    }

    Function("stopMonitoring") {
      appContext.reactContext?.let { MonitorService.stop(it) }
    }

    OnDestroy {
      appContext.reactContext?.let { MonitorService.stop(it) }
      channels.values.forEach { it.channel.disconnect() }
      sessions.values.forEach { it.disconnect() }
      io.shutdownNow()
    }
  }

  private fun run(promise: Promise, block: () -> Any?) {
    io.execute {
      try {
        promise.resolve(block())
      } catch (e: CodedException) {
        promise.reject(e)
      } catch (e: Exception) {
        promise.reject(SshError("ERR_SSH", e.message ?: e.javaClass.simpleName, e))
      }
    }
  }

  private fun newSession(host: String, port: Int, user: String, repo: PinnedHostKeyRepository): Session =
    newSession(JSch(), host, port, user, repo)

  private fun newSession(jsch: JSch, host: String, port: Int, user: String, repo: PinnedHostKeyRepository): Session {
    jsch.hostKeyRepository = repo
    val session = jsch.getSession(user, host, port)
    session.setConfig("StrictHostKeyChecking", "yes")
    session.setConfig("HashKnownHosts", "no")
    // Detect dead links (e.g. after network changes) instead of hanging on a silent socket.
    session.setServerAliveInterval(15_000)
    session.setServerAliveCountMax(3)
    return session
  }

  private fun requireSession(id: String): Session {
    val s = sessions[id] ?: throw SshError("ERR_NO_SESSION", "not connected")
    if (!s.isConnected) {
      sessions.remove(id)
      throw SshError("ERR_NO_SESSION", "connection lost")
    }
    return s
  }

  private fun mapConnectError(e: JSchException, repo: PinnedHostKeyRepository? = null): CodedException {
    if (e is JSchChangedHostKeyException) {
      val got = repo?.captured?.let { hostKeyInfo(it)["fingerprint"] } ?: "unknown"
      return SshError("ERR_HOSTKEY_MISMATCH", "host key does not match the pinned key (server sent $got)", e)
    }
    if (e is JSchUnknownHostKeyException) {
      return SshError("ERR_HOSTKEY_MISMATCH", "host key not pinned", e)
    }
    val msg = e.message ?: ""
    return when {
      msg.startsWith("Auth fail") || msg.startsWith("Auth cancel") ||
        msg.contains("Too many authentication failures") ->
        SshError("ERR_AUTH", "authentication failed", e)
      msg.contains("timeout", ignoreCase = true) -> SshError("ERR_TIMEOUT", "connection timed out", e)
      else -> SshError("ERR_CONNECT", msg.ifEmpty { "connection failed" }, e)
    }
  }



  private fun decodeKey(b64: String): ByteArray =
    try {
      Base64.decode(b64, Base64.NO_WRAP).also { require(it.isNotEmpty()) }
    } catch (e: IllegalArgumentException) {
      throw SshError("ERR_ARGS", "invalid pinned key", e)
    }

  private fun hostKeyInfo(key: ByteArray): Map<String, String> = mapOf(
    "algorithm" to HostKeys.algorithm(key),
    "key" to Base64.encodeToString(key, Base64.NO_WRAP),
    "fingerprint" to HostKeys.fingerprintSha256(key),
  )
}
