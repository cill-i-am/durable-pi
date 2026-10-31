FROM docker.io/library/node:24.21.0-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 ffmpeg tmux \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /workspace
COPY --from=docker.io/cloudflare/sandbox:1.0.3@sha256:fc1740c3cba26461f0ab1771287c84018ab2cca43a70ebb823087c85d780aaec /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN printf 'set -g status off\nset -g history-limit 1000\n' > /etc/tmux.conf
COPY --chmod=755 pi-shell /usr/local/bin/pi-shell
COPY --chmod=755 pi-video.py /usr/local/bin/pi-video.py
COPY check-video.py /tmp/check-video.py
RUN /usr/bin/python3 /tmp/check-video.py && rm /tmp/check-video.py
WORKDIR /workspace
CMD ["sleep", "infinity"]
