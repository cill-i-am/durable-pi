FROM docker.io/cloudflare/sandbox:0.12.10@sha256:35c932d3e5b35f28d350800cf00551cac46dfe28274afb54e16325b8d8f560d1
COPY --chmod=755 pi-shell /usr/local/bin/pi-shell
COPY --chmod=755 pi-video.py /usr/local/bin/pi-video.py
RUN apt-get update && apt-get install -y --no-install-recommends python3 ffmpeg \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /workspace

COPY check-video.py /tmp/check-video.py
RUN /usr/bin/python3 /tmp/check-video.py && rm /tmp/check-video.py
