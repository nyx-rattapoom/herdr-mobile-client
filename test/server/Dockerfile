# Test SSH servers for exercising the app from the Android emulator (host reachable as 10.0.2.2).
# Test-only credentials. Build args:
#   INSTALL_HERDR=1|0   install and start Herdr (0 = exercise the install flow)
#   STREAMLOCAL=yes|no  sshd AllowStreamLocalForwarding (no = exercise the forwarding-disabled error)
#   INSTALL_OPENCODE=1|0 install opencode (a real agent Herdr detects) + its Herdr integration
FROM debian:bookworm-slim
ARG INSTALL_HERDR=1
ARG STREAMLOCAL=yes
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server curl ca-certificates tmux procps git \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd
RUN useradd -m -s /bin/bash herdr && echo 'herdr:herdr-test' | chpasswd
USER herdr
RUN if [ "$INSTALL_HERDR" = 1 ]; then curl -fsSL https://herdr.dev/install.sh | sh; fi
ARG INSTALL_OPENCODE=0
# Free opencode Zen model: no API key or account needed. Prompts are sent to opencode.ai.
ARG OPENCODE_MODEL=opencode/big-pickle
RUN if [ "$INSTALL_OPENCODE" = 1 ]; then curl -fsSL https://opencode.ai/install | bash \
      && mkdir -p ~/.config/opencode \
      && printf '{"$schema":"https://opencode.ai/config.json","model":"%s","autoupdate":false}\n' "$OPENCODE_MODEL" > ~/.config/opencode/opencode.json \
      && ~/.local/bin/herdr integration install opencode \
      && cd ~ && ~/.opencode/bin/opencode debug config >/dev/null; fi
# ^ warm-up: opencode's first start installs plugin deps (~2-3 min). Until its TUI is up, Herdr already
#   lists it as an idle agent, and agent.prompt input typed into it is silently lost.
USER root
RUN printf 'PasswordAuthentication yes\nPubkeyAuthentication yes\nAllowStreamLocalForwarding %s\n' "$STREAMLOCAL" > /etc/ssh/sshd_config.d/test.conf
COPY fake-agent /usr/local/bin/fake-agent
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /usr/local/bin/fake-agent
EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
