package expo.modules.herdrssh

import com.jcraft.jsch.JSch
import com.jcraft.jsch.KeyPair
import java.io.ByteArrayOutputStream

object Keys {
  /** Returns `privateKey` (OpenSSH v1 PEM, unencrypted), `publicKey` (authorized_keys line) and the key blob. */
  fun generateEd25519(comment: String): Map<String, String> {
    val kp = KeyPair.genKeyPair(JSch(), KeyPair.ED25519)
    try {
      val prv = ByteArrayOutputStream().also { kp.writeOpenSSHv1PrivateKey(it, null) }.toString("US-ASCII")
      val pub = ByteArrayOutputStream().also { kp.writePublicKey(it, sanitizeComment(comment)) }.toString("US-ASCII").trim()
      return mapOf("privateKey" to prv, "publicKey" to pub)
    } finally {
      kp.dispose()
    }
  }

  /** authorized_keys comments are free text, but keep them to one printable line. */
  fun sanitizeComment(c: String): String = c.replace(Regex("[^\\x21-\\x7e ]"), "").trim().take(64).ifEmpty { "herdr-client" }
}
