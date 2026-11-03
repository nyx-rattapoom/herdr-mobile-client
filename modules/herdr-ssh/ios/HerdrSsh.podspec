Pod::Spec.new do |s|
  s.name           = 'HerdrSsh'
  s.version        = '0.1.0'
  s.summary        = 'SSH transport for Herdr Client (libssh2 + OpenSSL)'
  s.description    = 'SSH sessions, direct-streamlocal and direct-tcpip channels for Herdr Client. See docs/SPIKE.md.'
  s.license        = 'MIT'
  s.author         = 'Herdr Client'
  s.homepage       = 'https://github.com/nyx-rattapoom/herdr-mobile-client'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  # OpenSSL backend: libssh2 needs it for Ed25519 keys and host keys (see docs/SPIKE.md).
  s.dependency 'OpenSSL-Universal', '3.6.2000'

  s.source_files = [
    '*.swift',
    'vendor/libssh2/include/*.h',
    'vendor/libssh2/src/*.{c,h}',
    'vendor/libssh2-config/*.h',
    'shim/*.{c,h}',
  ]
  # crypto.c and agent.c #include the selected backend sources themselves.
  s.exclude_files = [
    'vendor/libssh2/src/{openssl,libgcrypt,mbedtls,wincng,os400qc3,agent_win}.c',
  ]
  s.public_header_files = ['vendor/libssh2/include/libssh2.h', 'shim/herdr_libssh2.h']
  s.preserve_paths = 'vendor/**/*'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'GCC_PREPROCESSOR_DEFINITIONS' => '$(inherited) HAVE_CONFIG_H=1 LIBSSH2_OPENSSL=1',
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_TARGET_SRCROOT)/vendor/libssh2-config" "$(PODS_TARGET_SRCROOT)/vendor/libssh2/include" "$(PODS_TARGET_SRCROOT)/vendor/libssh2/src"',
    'GCC_WARN_INHIBIT_ALL_WARNINGS' => 'YES',
  }
end
