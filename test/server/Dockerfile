# Test SSH servers for exercising the app from the Android emulator (host reachable as 10.0.2.2).
# Test-only credentials. Build args:
#   INSTALL_HERDR=1|0   install and start Herdr (0 = exercise the install flow)
#   STREAMLOCAL=yes|no  sshd AllowStreamLocalForwarding (no = exercise the forwarding-disabled error)
FROM debian:bookworm-slim
ARG INSTALL_HERDR=1
ARG STREAMLOCAL=yes
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server curl ca-certificates tmux procps git \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
RUN useradd -m -s /bin/bash herdr && echo 'herdr:herdr-test' | chpasswd
USER herdr
RUN if [ "$INSTALL_HERDR" = 1 ]; then curl -fsSL https://herdr.dev/install.sh | sh; fi
USER root
RUN printf 'PasswordAuthentication yes\nPubkeyAuthentication yes\nAllowStreamLocalForwarding %s\n' "$STREAMLOCAL" > /etc/ssh/sshd_config.d/test.conf
COPY fake-agent /usr/local/bin/fake-agent
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/fake-agent
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
