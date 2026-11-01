package expo.modules.herdrssh

import com.jcraft.jsch.ChannelDirectTCPIP
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.Proxy
import com.jcraft.jsch.Session
import com.jcraft.jsch.SocketFactory
import java.io.InputStream
import java.io.OutputStream
import java.net.Socket
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val DEFAULT_OPEN_TIMEOUT_MS = 10_000

class JumpChannelException(val reason: Int, message: String, cause: Throwable?) : Exception(message, cause)

class JumpProxy(private val jump: Session) : Proxy {
  @Volatile private var channel: ChannelDirectTCPIP? = null
  private var input: InputStream? = null
  private var output: OutputStream? = null

  override fun connect(socketFactory: SocketFactory?, host: String, port: Int, timeout: Int) {
    if (!jump.isConnected) throw JumpChannelException(0, "jump host connection is closed", null)
    val ch = try {
      jump.openChannel("direct-tcpip") as ChannelDirectTCPIP
    } catch (e: JSchException) {
      throw JumpChannelException(0, e.message ?: "jump host connection is closed", e)
    }
    ch.setHost(host)
    ch.setPort(port)
    val inStream: InputStream
    val outStream: OutputStream
    try {
      inStream = ch.inputStream
      outStream = ch.outputStream
      ch.connect(if (timeout > 0) timeout else DEFAULT_OPEN_TIMEOUT_MS)
    } catch (e: Exception) {
      val reason = ch.exitStatus
      ch.disconnect()
      throw JumpChannelException(reason, e.message ?: "channel open failed", e)
    }
    input = inStream
    output = outStream
    channel = ch
  }

  override fun getInputStream(): InputStream? = input
  override fun getOutputStream(): OutputStream? = output
  override fun getSocket(): Socket? = null

  override fun close() {
    channel?.disconnect()
    channel = null
  }

  companion object {
    fun connect(session: Session, timeoutMs: Int, scheduler: ScheduledExecutorService) {
      val done = AtomicBoolean(false)
      val fired = AtomicBoolean(false)
      val timer = scheduler.schedule({
        if (!done.get()) {
          fired.set(true)
          session.disconnect()
        }
      }, timeoutMs.toLong(), TimeUnit.MILLISECONDS)
      try {
        session.connect(timeoutMs)
      } catch (e: JSchException) {
        if (fired.get()) throw JSchException("timeout: no SSH handshake through the jump host", e)
        throw e
      } finally {
        done.set(true)
        timer.cancel(false)
      }
      if (fired.get()) throw JSchException("timeout: no SSH handshake through the jump host")
    }
  }
}
