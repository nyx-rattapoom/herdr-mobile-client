package expo.modules.herdrssh

import com.jcraft.jsch.JSch
import com.jcraft.jsch.KeyPair
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class KeysTest {
  @Test
  fun generatesLoadableOpenSshEd25519Key() {
    val k = Keys.generateEd25519("phone@herdr-client")
    val prv = k.getValue("privateKey")
    val pub = k.getValue("publicKey")
    assertTrue(prv.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"))
    val parts = pub.split(" ")
    assertEquals("ssh-ed25519", parts[0])
    assertEquals("phone@herdr-client", parts[2])

    val jsch = JSch()
    jsch.addIdentity("k", prv.toByteArray(), null, null)
    val loaded = KeyPair.load(jsch, prv.toByteArray(), null)
    assertEquals(parts[1], java.util.Base64.getEncoder().encodeToString(loaded.publicKeyBlob))
  }

  @Test
  fun keysAreUnique() {
    assertNotEquals(Keys.generateEd25519("a")["publicKey"], Keys.generateEd25519("a")["publicKey"])
  }

  @Test
  fun commentIsSanitised() {
    assertEquals("evilcomment", Keys.sanitizeComment("evil\ncomment"))
    assertEquals("herdr-client", Keys.sanitizeComment("\n\t"))
    assertEquals(64, Keys.sanitizeComment("x".repeat(100)).length)
  }
}
