package expo.modules.herdrssh

import com.jcraft.jsch.ChannelExec
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A long-lived, no-PTY exec channel whose stdout is delivered as raw bytes.
 *
 * The reader is deliberately not allowed to outrun the JS consumer without
 * bound: bytes need a permit from [pending] before they enter the queue, and a
 * permit is returned once the bridge event for those bytes has been sent. If
 * more than [MAX_PENDING_BYTES] are waiting, the stream closes with
 * "output queue overflow" instead of growing memory; this is a hard bound,
 * not backpressure on the SSH window.
 * Delivery starts only when [start] is called, after JS has installed its
 * listeners, so the first paint can never be lost before registration.
 */
class ExecStream(
  val id: String,
  val sessionId: String,
  private val channel: ChannelExec,
  private val emitBytes: (String, ByteArray) -> Unit,
  private val emitClosed: (String, String, Int?, String) -> Unit,
) {
  companion object {
    const val MAX_PENDING_BYTES = 16 * 1024 * 1024
    const val MAX_STDERR_BYTES = 64 * 1024
    private const val CHUNK = 32 * 1024
    private const val QUEUE_CHUNKS = 512
  }

  private val out: OutputStream = channel.outputStream
  private val closed = AtomicBoolean(false)
  private val started = AtomicBoolean(false)
  private val finished = AtomicBoolean(false)
  private val endOfInput = AtomicBoolean(false)
  private val pending = Semaphore(MAX_PENDING_BYTES)
  private val queue = ArrayBlockingQueue<ByteArray>(QUEUE_CHUNKS)
  private val stderr = ByteArrayOutputStream()
  private val reader = Runnable {
    try {
      val input: InputStream = channel.inputStream
      val buf = ByteArray(CHUNK)
      while (!closed.get()) {
        val n = input.read(buf)
        if (n < 0) break
        if (n == 0) continue
        if (!pending.tryAcquire(n)) {
          finish("output queue overflow")
          return@Runnable
        }
        queue.put(buf.copyOf(n))
      }
      if (!closed.get()) {
        endOfInput.set(true)
        // Sentinel: let the emitter deliver every queued byte before the close.
        queue.put(ByteArray(0))
      }
    } catch (e: InterruptedException) {
      Thread.currentThread().interrupt()
    } catch (e: Exception) {
      finish(e.message ?: "read error")
    }
  }

  private val errReader = Runnable {
    try {
      val input: InputStream = channel.errStream
      val buf = ByteArray(4096)
      while (!closed.get()) {
        val n = input.read(buf)
        if (n < 0) break
        synchronized(stderr) {
          if (stderr.size() < MAX_STDERR_BYTES) {
            stderr.write(buf, 0, minOf(n, MAX_STDERR_BYTES - stderr.size()))
          }
        }
      }
    } catch (_: Exception) {
      // stderr is diagnostic only; stdout owns protocol delivery.
    }
  }

  private val emitter = Runnable {
    try {
      while (!closed.get()) {
        val bytes = queue.take()
        if (closed.get()) break
        if (bytes.isEmpty()) {
          if (endOfInput.get() && queue.isEmpty()) {
            // Let JSch record the remote exit-status before the close event, so
            // `hc` exit 97 stays distinguishable from a transport failure.
            val deadline = System.currentTimeMillis() + 1_000
            while (!channel.isClosed && !closed.get() && System.currentTimeMillis() < deadline) {
              Thread.sleep(10)
            }
            finish("eof")
          }
          continue
        }
        emitBytes(id, bytes)
        pending.release(bytes.size)
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
    }
  }

  fun start(io: ExecutorService) {
    if (!started.compareAndSet(false, true) || closed.get()) return
    io.execute(reader)
    io.execute(errReader)
    io.execute(emitter)
  }

  fun write(bytes: ByteArray) {
    if (closed.get()) throw SshError("ERR_NO_CHANNEL", "stream is closed")
    try {
      synchronized(out) {
        out.write(bytes)
        out.flush()
      }
    } catch (e: Exception) {
      close("write failed")
      throw SshError("ERR_NO_CHANNEL", e.message ?: "stream write failed", e)
    }
  }

  fun close(reason: String) {
    finish(reason)
  }

  private fun finish(reason: String) {
    if (!finished.compareAndSet(false, true)) return
    closed.set(true)
    val code = if (channel.isClosed) channel.exitStatus else null
    val err = synchronized(stderr) { stderr.toString("UTF-8") }
    try {
      channel.disconnect()
    } catch (_: Exception) {
    }
    queue.clear()
    queue.offer(ByteArray(0))
    emitClosed(id, reason, code, err)
  }
}
