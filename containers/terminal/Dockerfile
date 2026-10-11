FROM docker.io/cloudflare/sandbox:0.12.10@sha256:35c932d3e5b35f28d350800cf00551cac46dfe28274afb54e16325b8d8f560d1
RUN apt-get update && apt-get install -y --no-install-recommends python3-minimal \
    && rm -rf /var/lib/apt/lists/* && mkdir -p /workspace
