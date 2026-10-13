package expo.modules.herdrssh

import com.jcraft.jsch.ChannelDirectStreamLocal
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchChangedHostKeyException
import com.jcraft.jsch.JSchUnknownHostKeyException
import com.jcraft.jsch.Session
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Runs against the Docker test server: HERDR_TEST_SSH=herdr:herdr-test@127.0.0.1:2222.
 * Exercises the same JSch configuration the module uses.
 */
class StreamLocalIntegrationTest {
  private val target = System.getenv("HERDR_TEST_SSH").orEmpty()

  private fun parts(): List<String> {
    assumeTrue("set HERDR_TEST_SSH to run", target.isNotEmpty())
    val (cred, hp) = target.split("@", limit = 2)
    val (user, pw) = cred.split(":", limit = 2)
    val (host, port) = hp.split(":", limit = 2)
    return listOf(user, pw, host, port)
  }

  private fun session(user: String, host: String, port: String, repo: PinnedHostKeyRepository): Session {
    val jsch = JSch()
    jsch.hostKeyRepository = repo
    return jsch.getSession(user, host, port.toInt()).apply { setConfig("StrictHostKeyChecking", "yes") }
  }

  private fun probe(user: String, host: String, port: String): ByteArray {
    val repo = PinnedHostKeyRepository(null)
    try {
      session(user, host, port, repo).connect(10_000)
    } catch (_: JSchUnknownHostKeyException) {
    }
    return repo.captured ?: throw AssertionError("no host key captured")
  }

  @Test
  fun wrongPinFailsBeforeAuth() {
    val (user, _, host, port) = parts()
    val wrong = probe(user, host, port).copyOf().also { it[it.size - 1] = (it.last() + 1).toByte() }
    val s = session(user, host, port, PinnedHostKeyRepository(wrong))
    // No password configured: reaching auth would fail differently ("Auth fail").
    try {
      s.connect(10_000)
      throw AssertionError("connected with a wrong pin")
    } catch (_: JSchChangedHostKeyException) {
    }
  }

  @Test
  fun pinnedConnectPingsHerdrOverStreamLocal() {
    val (user, pw, host, port) = parts()
    val s = session(user, host, port, PinnedHostKeyRepository(probe(user, host, port)))
    s.setPassword(pw)
    s.setConfig("PreferredAuthentications", "password")
    s.connect(10_000)
    try {
      val ch = s.openChannel("direct-streamlocal@openssh.com") as ChannelDirectStreamLocal
      ch.socketPath = "/home/$user/.config/herdr/herdr.sock"
      val input = ch.inputStream
      ch.connect(10_000)
      ch.outputStream.apply { write("{\"id\":\"t1\",\"method\":\"ping\",\"params\":{}}\n".toByteArray()); flush() }
      val line = input.bufferedReader().readLine()
      assertTrue(line, line.contains("\"id\":\"t1\"") && line.contains("pong"))
      ch.disconnect()
    } finally {
      s.disconnect()
    }
  }
}
