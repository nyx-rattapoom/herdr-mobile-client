package expo.modules.herdrssh

import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.Session
import expo.modules.kotlin.exception.CodedException
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

object Exec {
  const val OUTPUT_LIMIT = 1 shl 20
  const val MAX_TIMEOUT_MS = 600_000L
  private const val CONNECT_TIMEOUT_MS = 10_000

  /**
   * Runs `command` on an exec channel with a hard deadline. Both streams are drained
   * concurrently; on timeout or error the channel is closed and the readers cancelled.
   */
  fun run(session: Session, command: String, timeoutMs: Long, io: ExecutorService): Map<String, Any> {
    val deadline = timeoutMs.coerceIn(1_000, MAX_TIMEOUT_MS)
    val channel = session.openChannel("exec") as ChannelExec
    var outFuture: Future<String>? = null
    var errFuture: Future<String>? = null
    try {
      channel.setCommand(command)
      val stdout = channel.inputStream
      val stderr = channel.errStream
      // Within the deadline: on a link that stopped answering, opening the channel is what hangs.
      channel.connect(minOf(deadline, CONNECT_TIMEOUT_MS.toLong()).toInt())
      outFuture = io.submit<String> { readLimited(stdout) }
      errFuture = io.submit<String> { readLimited(stderr) }
      val start = System.nanoTime()
      fun left() = deadline - TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start)
      val out = outFuture.get(left().coerceAtLeast(1), TimeUnit.MILLISECONDS)
      val err = errFuture.get(left().coerceAtLeast(1), TimeUnit.MILLISECONDS)
      while (!channel.isClosed) {
        if (left() <= 0) throw TimeoutException()
        Thread.sleep(20)
      }
      return mapOf("stdout" to out, "stderr" to err, "exitCode" to channel.exitStatus)
    } catch (e: TimeoutException) {
      throw SshError("ERR_TIMEOUT", "command did not finish within ${deadline / 1000} s", e)
    } catch (e: ExecutionException) {
      throw (e.cause as? CodedException) ?: SshError("ERR_EXEC", e.cause?.message ?: "exec failed", e)
    } finally {
      channel.disconnect()
      outFuture?.cancel(true)
      errFuture?.cancel(true)
    }
  }

  private fun readLimited(stream: InputStream): String {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (true) {
      val n = stream.read(buf)
      if (n < 0) break
      if (out.size() + n > OUTPUT_LIMIT) throw SshError("ERR_EXEC", "command output too large")
      out.write(buf, 0, n)
    }
    return out.toString("UTF-8")
  }
}
