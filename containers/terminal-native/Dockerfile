FROM docker.io/library/node:24.22.0-trixie-slim@sha256:7f486cabe892bff8fef04c0f7da8dba84a560be3e4e2740b7a86afc57ebec315
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 ffmpeg tmux \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /workspace
COPY --from=docker.io/cloudflare/sandbox:1.0.1@sha256:e796e813de8213fb062bba279ddeddbf61277389a2cc7b3e4620075a9188843b /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
RUN printf 'set -g status off\nset -g history-limit 1000\n' > /etc/tmux.conf
COPY --chmod=755 pi-shell /usr/local/bin/pi-shell
COPY --chmod=755 pi-video.py /usr/local/bin/pi-video.py
COPY check-video.py /tmp/check-video.py
RUN /usr/bin/python3 /tmp/check-video.py && rm /tmp/check-video.py
WORKDIR /workspace
CMD ["sleep", "infinity"]
