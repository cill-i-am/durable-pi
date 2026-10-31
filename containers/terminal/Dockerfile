FROM docker.io/cloudflare/sandbox:0.12.14@sha256:b8175e89ae5efd83987ffd5056f57c28c390fd5706d42ef70fb669e275248e7b
COPY --chmod=755 pi-shell /usr/local/bin/pi-shell
COPY --chmod=755 pi-video.py /usr/local/bin/pi-video.py
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /workspace

COPY check-video.py /tmp/check-video.py
RUN /usr/bin/python3 /tmp/check-video.py && rm /tmp/check-video.py
