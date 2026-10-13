package expo.modules.herdrssh

import com.jcraft.jsch.ChannelDirectStreamLocal
import com.jcraft.jsch.ChannelExec
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

  private fun exec(s: Session, cmd: String): String {
    val ch = s.openChannel("exec") as ChannelExec
    ch.setCommand(cmd)
    val out = ch.inputStream
    ch.connect(10_000)
    val text = out.bufferedReader().readText()
    ch.disconnect()
    return text
  }

  @Test
  fun deviceKeyAuthenticatesWithoutPassword() {
    val (user, pw, host, port) = parts()
    val hostKey = probe(user, host, port)
    val k = Keys.generateEd25519("herdr-client-test")
    val pub = k.getValue("publicKey")
    val marker = pub.split(" ")[1]
    // Install the key using a password session.
    val admin = session(user, host, port, PinnedHostKeyRepository(hostKey)).apply {
      setPassword(pw)
      setConfig("PreferredAuthentications", "password")
      connect(10_000)
    }
    try {
      exec(admin, "mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '$pub' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys")
      val jsch = JSch()
      jsch.addIdentity("device", k.getValue("privateKey").toByteArray(), null, null)
      jsch.hostKeyRepository = PinnedHostKeyRepository(hostKey)
      val s = jsch.getSession(user, host, port.toInt()).apply {
        setConfig("StrictHostKeyChecking", "yes")
        setConfig("PreferredAuthentications", "publickey")
      }
      s.connect(10_000)
      assertTrue(exec(s, "echo key-ok").contains("key-ok"))
      s.disconnect()
    } finally {
      // Base64 may contain '/', so match it as a fixed string.
      exec(admin, "grep -vF '$marker' ~/.ssh/authorized_keys > ~/.ssh/ak.tmp; mv ~/.ssh/ak.tmp ~/.ssh/authorized_keys")
      admin.disconnect()
    }
  }

  @Test
  fun execTimesOutAndClosesTheChannel() {
    val (user, pw, host, port) = parts()
    val s = session(user, host, port, PinnedHostKeyRepository(probe(user, host, port))).apply {
      setPassword(pw)
      setConfig("PreferredAuthentications", "password")
      connect(10_000)
    }
    val io = java.util.concurrent.Executors.newCachedThreadPool()
    try {
      val ok = Exec.run(s, "echo hi; echo err >&2; exit 3", 10_000, io)
      assertTrue(ok.toString(), ok["stdout"] == "hi\n" && ok["stderr"] == "err\n" && ok["exitCode"] == 3)
      val t0 = System.currentTimeMillis()
      try {
        Exec.run(s, "sleep 30", 1_500, io)
        throw AssertionError("expected timeout")
      } catch (e: SshError) {
        assertTrue(e.message, e.code == "ERR_TIMEOUT")
      }
      assertTrue("took too long", System.currentTimeMillis() - t0 < 5_000)
      // The session is still usable afterwards.
      assertTrue(Exec.run(s, "echo again", 10_000, io)["stdout"] == "again\n")
    } finally {
      io.shutdownNow()
      s.disconnect()
    }
  }
}
