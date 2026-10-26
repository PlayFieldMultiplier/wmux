# One user's headless wmux (daemon + `wmux web`) in a container, for a team
# server where each person gets their own instance behind a TLS reverse proxy.
#
#   docker build -t wmux-server --build-arg WMUX_VERSION=4.11.0 deploy/docker
#   docker run -d -v wmux-home:/home/wmux -p 7681:7681 \
#     -e WMUX_ALLOW_HOST=wmux.example.com wmux-server
#
# The proxy terminates TLS; inside the container `wmux web` serves plain HTTP
# on the container network only. Never publish 7681 on an untrusted network.

FROM debian:12-slim

ARG WMUX_VERSION=4.11.0
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git openssh-client less procps tini zsh bash locales \
 && sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen && locale-gen \
 && rm -rf /var/lib/apt/lists/*

# The release tarball carries its own Node, CLI, daemon and web UI.
RUN set -eu; \
    case "$TARGETARCH" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; esac; \
    name="wmux-server-${WMUX_VERSION}-linux-${arch}.tar.gz"; \
    base="https://github.com/openwong2kim/wmux/releases/download/v${WMUX_VERSION}"; \
    cd /tmp; \
    curl -fsSLO "$base/$name" -O "$base/$name.sha256"; \
    sha256sum -c "$name.sha256"; \
    mkdir -p /opt/wmux; \
    tar -xzf "$name" -C /opt/wmux --strip-components=1; \
    rm -f "$name" "$name.sha256"

COPY entrypoint.sh /usr/local/bin/wmux-entrypoint
COPY wmux.sh /usr/local/bin/wmux
RUN chmod 0755 /usr/local/bin/wmux-entrypoint /usr/local/bin/wmux \
 && useradd --create-home --shell /bin/zsh --uid 1000 wmux

USER wmux
WORKDIR /home/wmux
ENV HOME=/home/wmux \
    LANG=en_US.UTF-8 \
    SHELL=/bin/zsh \
    PATH=/home/wmux/.local/bin:/usr/local/bin:/usr/bin:/bin

# Everything the user owns lives here: ~/.wmux state, ~/.claude login, repos.
VOLUME ["/home/wmux"]
EXPOSE 7681

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/wmux-entrypoint"]
