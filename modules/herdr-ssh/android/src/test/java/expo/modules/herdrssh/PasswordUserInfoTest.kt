package expo.modules.herdrssh

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class PasswordUserInfoTest {
  private fun ask(ui: PasswordUserInfo, prompt: String, echo: Boolean = false) =
    ui.promptKeyboardInteractive("dest", "", "", arrayOf(prompt), booleanArrayOf(echo))

  @Test
  fun answersAHiddenPasswordPromptOnce() {
    val ui = PasswordUserInfo("s3cret")
    assertArrayEquals(arrayOf("s3cret"), ask(ui, "Password: "))
    assertNull(ask(ui, "Password: "))
  }

  @Test
  fun neverSendsThePasswordToOtherPrompts() {
    val ui = PasswordUserInfo("s3cret")
    assertNull(ask(ui, "Verification code: "))
    assertNull(ask(ui, "One-time password (OTP)?", echo = true))
    assertNull(ui.promptKeyboardInteractive("d", "", "", arrayOf("Password:", "Code:"), booleanArrayOf(false, false)))
    assertArrayEquals(arrayOf("s3cret"), ask(ui, "herdr@host's password:"))
  }

  @Test
  fun neverRetriesOrAcceptsHostKeysViaPrompts() {
    val ui = PasswordUserInfo("s3cret")
    assertFalse(ui.promptPassword("Password for x"))
    assertFalse(ui.promptYesNo("Are you sure you want to continue connecting?"))
  }
}
