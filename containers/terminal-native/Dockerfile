FROM docker.io/library/node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446
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
