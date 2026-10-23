package expo.modules.herdrssh

import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.UserInfo
import java.nio.ByteBuffer
import java.security.MessageDigest
import android.util.Base64

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
  fun fingerprintSha256(blob: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(blob)
    return "SHA256:" + Base64.encodeToString(digest, Base64.NO_WRAP or Base64.NO_PADDING)
  }

  fun algorithm(blob: ByteArray): String {
    if (blob.size < 4) return "unknown"
    val len = ByteBuffer.wrap(blob, 0, 4).int
    if (len <= 0 || len > blob.size - 4) return "unknown"
    return String(blob, 4, len, Charsets.US_ASCII)
  }
}

class PasswordUserInfo(private val password: String) : UserInfo, com.jcraft.jsch.UIKeyboardInteractive {
  private var interactivePrompts = 0

  override fun getPassphrase(): String? = null
  override fun getPassword(): String = password
  override fun promptPassword(message: String?): Boolean = false
  override fun promptPassphrase(message: String?): Boolean = false
  override fun promptYesNo(message: String?): Boolean = false
  override fun showMessage(message: String?) {}

  override fun promptKeyboardInteractive(
    destination: String?, name: String?, instruction: String?, prompt: Array<out String>?, echo: BooleanArray?,
  ): Array<String>? {
    val p = prompt ?: return null
    if (p.size != 1 || echo?.getOrNull(0) == true || !isPasswordPrompt(p[0]) || interactivePrompts++ > 0) return null
    return arrayOf(password)
  }

  companion object {
    fun isPasswordPrompt(prompt: String?): Boolean = prompt?.contains("password", ignoreCase = true) == true
  }
}
