package expo.modules.herdrssh

import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.UserInfo
import java.nio.ByteBuffer
import java.security.MessageDigest
import android.util.Base64

/**
 * Accepts exactly one pinned host key blob. With no pin, every key is reported as unknown so
 * JSch aborts right after key exchange, before any authentication. The presented key is
 * captured either way so the caller can show its fingerprint.
 */
class PinnedHostKeyRepository(private val pinned: ByteArray?) : HostKeyRepository {
  @Volatile
  var captured: ByteArray? = null
    private set

  override fun check(host: String?, key: ByteArray?): Int {
    captured = key?.copyOf()
    return when {
      pinned == null || key == null -> HostKeyRepository.NOT_INCLUDED
      MessageDigest.isEqual(pinned, key) -> HostKeyRepository.OK
      else -> HostKeyRepository.CHANGED
    }
  }

  override fun add(hostkey: HostKey?, ui: UserInfo?) {}
  override fun remove(host: String?, type: String?) {}
  override fun remove(host: String?, type: String?, key: ByteArray?) {}
  override fun getKnownHostsRepositoryID(): String = "herdr-client-pins"
  override fun getHostKey(): Array<HostKey> = emptyArray()
  override fun getHostKey(host: String?, type: String?): Array<HostKey> = emptyArray()
}

object HostKeys {
  /** OpenSSH-style fingerprint: unpadded base64 of SHA-256 over the public key blob. */
  fun fingerprintSha256(blob: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(blob)
    return "SHA256:" + Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)
  }

  /** The key blob starts with an SSH string naming its algorithm. */
  fun algorithm(blob: ByteArray): String {
    if (blob.size < 4) return "unknown"
    val len = ByteBuffer.wrap(blob, 0, 4).int
    if (len <= 0 || len > blob.size - 4) return "unknown"
    return String(blob, 4, len, Charsets.US_ASCII)
  }
}

/**
 * Answers JSch's password prompts (password and keyboard-interactive) with one secret, once per
 * method: a wrong password must not be retried until sshd's MaxAuthTries disconnects us.
 */
class PasswordUserInfo(private val password: String) : UserInfo, com.jcraft.jsch.UIKeyboardInteractive {
  private var interactivePrompts = 0

  override fun getPassphrase(): String? = null
  override fun getPassword(): String = password
  // JSch sends session.setPassword first and only prompts to retry after a failure.
  override fun promptPassword(message: String?): Boolean = false
  override fun promptPassphrase(message: String?): Boolean = false
  // Host key decisions are made by PinnedHostKeyRepository, never by prompts.
  override fun promptYesNo(message: String?): Boolean = false
  override fun showMessage(message: String?) {}

  override fun promptKeyboardInteractive(
    destination: String?, name: String?, instruction: String?, prompt: Array<out String>?, echo: BooleanArray?,
  ): Array<String>? {
    val p = prompt ?: return null
    if (p.size != 1 || echo?.getOrNull(0) == true || interactivePrompts++ > 0) return null
    return arrayOf(password)
  }
}
