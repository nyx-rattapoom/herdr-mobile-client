package expo.modules.herdrssh

import com.jcraft.jsch.ChannelDirectStreamLocal
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchChangedHostKeyException
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.JSchUnknownHostKeyException
import com.jcraft.jsch.Session
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

class JumpIntegrationTest {
  private val target = System.getenv("HERDR_TEST_SSH").orEmpty()

  private data class Target(val user: String, val pw: String, val host: String, val port: Int)

  private fun target(): Target {
    assumeTrue("set HERDR_TEST_SSH to run", target.isNotEmpty())
    val (cred, hp) = target.split("@", limit = 2)
    val (user, pw) = cred.split(":", limit = 2)
    val (host, port) = hp.split(":", limit = 2)
    return Target(user, pw, host, port.toInt())
  }

  private fun session(user: String, host: String, port: Int, repo: PinnedHostKeyRepository, via: Session? = null): Session {
    val jsch = JSch()
    jsch.hostKeyRepository = repo
    return jsch.getSession(user, host, port).apply {
      setConfig("StrictHostKeyChecking", "yes")
      if (via != null) setProxy(JumpProxy(via))
    }
  }

  private fun probe(user: String, host: String, port: Int, via: Session? = null): ByteArray {
    val repo = PinnedHostKeyRepository(null)
    try {
      session(user, host, port, repo, via).connect(10_000)
    } catch (_: JSchUnknownHostKeyException) {
    }
    return repo.captured ?: throw AssertionError("no host key captured")
  }

  private fun jumpHost(t: Target): Session =
    session(t.user, t.host, t.port, PinnedHostKeyRepository(probe(t.user, t.host, t.port))).apply {
      setPassword(t.pw)
      setConfig("PreferredAuthentications", "password")
      connect(10_000)
    }

  @Test
  fun probesAndConnectsThroughTheJumpHost() {
    val t = target()
    val jump = jumpHost(t)
    try {
      val innerKey = probe(t.user, "127.0.0.1", 22, jump)
      assertArrayEquals(probe(t.user, t.host, t.port), innerKey)

      val inner = session(t.user, "127.0.0.1", 22, PinnedHostKeyRepository(innerKey), jump).apply {
        setPassword(t.pw)
        setConfig("PreferredAuthentications", "password")
        connect(10_000)
      }
      try {
        val ch = inner.openChannel("direct-streamlocal@openssh.com") as ChannelDirectStreamLocal
        ch.socketPath = "/home/${t.user}/.config/herdr/herdr.sock"
        val input = ch.inputStream
        ch.connect(10_000)
        ch.outputStream.apply { write("{\"id\":\"j1\",\"method\":\"ping\",\"params\":{}}\n".toByteArray()); flush() }
        val line = input.bufferedReader().readLine()
        assertTrue(line, line.contains("\"id\":\"j1\"") && line.contains("pong"))
        ch.disconnect()
      } finally {
        inner.disconnect()
      }
      assertTrue("jump session survives the inner disconnect", jump.isConnected)
    } finally {
      jump.disconnect()
    }
  }

  @Test
  fun wrongInnerPinFailsBeforeAuth() {
    val t = target()
    val jump = jumpHost(t)
    try {
      val wrong = probe(t.user, "127.0.0.1", 22, jump).also { it[it.size - 1] = (it.last() + 1).toByte() }
      try {
        session(t.user, "127.0.0.1", 22, PinnedHostKeyRepository(wrong), jump).connect(10_000)
        throw AssertionError("connected with a wrong pin")
      } catch (_: JSchChangedHostKeyException) {
      }
    } finally {
      jump.disconnect()
    }
  }

  @Test
  fun unreachableTargetReportsConnectFailed() {
    val t = target()
    val jump = jumpHost(t)
    try {
      try {
        session(t.user, "127.0.0.1", 1, PinnedHostKeyRepository(null), jump).connect(10_000)
        throw AssertionError("connected to a closed port")
      } catch (e: JSchException) {
        val cause = generateSequence<Throwable>(e) { it.cause }.filterIsInstance<JumpChannelException>().first()
        assertEquals(2, cause.reason)
      }
    } finally {
      jump.disconnect()
    }
  }

  @Test
  fun silentTargetTimesOutAndKeepsTheJumpHost() {
    val t = target()
    val jump = jumpHost(t)
    val port = 2999
    val listener = jump.openChannel("exec") as com.jcraft.jsch.ChannelExec
    listener.setCommand(
      "perl -MIO::Socket::INET -e '\$s=IO::Socket::INET->new(LocalAddr=>q(127.0.0.1),LocalPort=>$port,Listen=>1,ReuseAddr=>1) or die; \$c=\$s->accept; sleep 30'",
    )
    listener.connect(10_000)
    Thread.sleep(500)
    val scheduler = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
    try {
      val inner = session(t.user, "127.0.0.1", port, PinnedHostKeyRepository(null), jump)
      val t0 = System.currentTimeMillis()
      try {
        JumpProxy.connect(inner, 2_000, scheduler)
        throw AssertionError("handshake with a silent target succeeded")
      } catch (e: JSchException) {
        assertTrue(e.message, e.message!!.startsWith("timeout"))
      }
      assertTrue("took too long", System.currentTimeMillis() - t0 < 6_000)
      assertTrue("jump session survives", jump.isConnected)
    } finally {
      scheduler.shutdownNow()
      listener.disconnect()
      jump.disconnect()
    }
  }
}
