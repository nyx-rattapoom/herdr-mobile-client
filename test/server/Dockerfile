# Test SSH server running Herdr, for exercising the app from the Android emulator
# (emulator reaches the host as 10.0.2.2:2222). Test-only credentials.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server curl ca-certificates tmux procps git \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
RUN useradd -m -s /bin/bash herdr && echo 'herdr:herdr-test' | chpasswd
USER herdr
RUN curl -fsSL https://herdr.dev/install.sh | sh
USER root
RUN printf 'PasswordAuthentication yes\nAllowStreamLocalForwarding yes\n' > /etc/ssh/sshd_config.d/test.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
