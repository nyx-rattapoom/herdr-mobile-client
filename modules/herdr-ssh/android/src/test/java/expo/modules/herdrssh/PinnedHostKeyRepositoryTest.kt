package expo.modules.herdrssh

import com.jcraft.jsch.HostKeyRepository
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class PinnedHostKeyRepositoryTest {
  private fun blob(alg: String, tail: Byte): ByteArray {
    val name = alg.toByteArray()
    return byteArrayOf(0, 0, 0, name.size.toByte()) + name + byteArrayOf(0, 0, 0, 1, tail)
  }

  private val a = blob("ssh-ed25519", 1)
  private val b = blob("ssh-ed25519", 2)

  @Test
  fun unpinnedReportsUnknownAndCapturesKey() {
    val repo = PinnedHostKeyRepository(null)
    assertEquals(HostKeyRepository.NOT_INCLUDED, repo.check("h", a))
    assertArrayEquals(a, repo.captured)
  }

  @Test
  fun exactPinMatches() {
    assertEquals(HostKeyRepository.OK, PinnedHostKeyRepository(a.copyOf()).check("h", a))
  }

  @Test
  fun differentKeyIsChangedAndCaptured() {
    val repo = PinnedHostKeyRepository(a)
    assertEquals(HostKeyRepository.CHANGED, repo.check("h", b))
    assertArrayEquals(b, repo.captured)
  }

  @Test
  fun nullKeyIsNeverAccepted() {
    assertEquals(HostKeyRepository.NOT_INCLUDED, PinnedHostKeyRepository(a).check("h", null))
  }

  @Test
  fun capturedKeyIsACopy() {
    val repo = PinnedHostKeyRepository(null)
    val k = a.copyOf()
    repo.check("h", k)
    k[k.size - 1] = 9
    assertArrayEquals(a, repo.captured)
  }

  @Test
  fun algorithmIsReadFromBlob() {
    assertEquals("ssh-ed25519", HostKeys.algorithm(a))
    assertEquals("unknown", HostKeys.algorithm(byteArrayOf(0, 0, 0, 99, 1)))
    assertEquals("unknown", HostKeys.algorithm(byteArrayOf(1)))
  }
}
