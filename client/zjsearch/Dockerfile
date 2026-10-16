ARG NODEJS_VERSION="24"
# 3.14, not the floating `3`: python:3 resolves to 3.15 now and markitdown
# pins `>=3.10,<3.15` (requirements.txt) -- the pip resolve dies with
# "Requires-Python >=3.10,<3.15".  Revisit when markitdown lifts the cap.
ARG PYTHON_VERSION="3.14"

# fully self-contained: upstream searxng master + this branch are cloned at
# build time (the context carries nothing). The project lands on the clone as
# make-patch.sh's zjsearch-theme.patch; client/zjsearch/patch/*.patch apply
# FIRST (engine backports targeting the upstream tree -- make-patch.sh
# excludes the directory from the export). The version is stamped by swapping
# searx/version_frozen.py's +0000 placeholder for the ZJSearch git sha (the
# grep guard fails the build if the placeholder drifts); the frozen module is
# load-bearing -- mainline version.py probes git on import when it is absent,
# and the runtime image has neither .git nor a git binary.
FROM node:${NODEJS_VERSION}-slim AS build_zjsearch_frontend

# the debian slim base ships bash/sed/coreutils; node slim PURGES
# ca-certificates after its own build -- without the bundle here git/wget
# die on TLS ("CAfile: none")
RUN \
    apt update \
    && apt install -qy \
        ca-certificates git openssl wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp

RUN \
    export WORKDIR=$(pwd) \
    && git clone -b "master" --depth=1 "https://github.com/searxng/searxng" "${WORKDIR}/BUILDTMP/SEARXNG" \
    && git clone -b "zjsearch" --depth=1 "https://github.com/hezhijie0327/ZJSearch.git" "${WORKDIR}/BUILDTMP/ZJSEARCH" \
    && export ZJSEARCH_SHA=$(cd "${WORKDIR}/BUILDTMP/ZJSEARCH" && git rev-parse --short HEAD) \
    && cd "${WORKDIR}/BUILDTMP/ZJSEARCH" \
    && bash ./client/zjsearch/make-patch.sh \
    && cd "${WORKDIR}/BUILDTMP/SEARXNG" \
    && git apply --reject ${WORKDIR}/BUILDTMP/ZJSEARCH/client/zjsearch/patch/*.patch \
    && git apply --reject "${WORKDIR}/BUILDTMP/ZJSEARCH/zjsearch-theme.patch" \
    && sed -i "s|ultrasecretkey|$(openssl rand -hex 32)|g;s|127.0.0.1|0.0.0.0|g;s|default_theme: simple|default_theme: zjsearch|g" searx/settings.yml \
    && sed -i "s|+0000\"|+${ZJSEARCH_SHA}\"|" searx/version_frozen.py \
    && grep -q "+${ZJSEARCH_SHA}\"" searx/version_frozen.py \
    && wget "https://curl.se/ca/cacert.pem"

# the frontend builds IN the patched tree -- client/zjsearch and searx keep
# their repo sibling layout, so vite's outDir lands in searx/static as usual
WORKDIR /tmp/BUILDTMP/SEARXNG/client/zjsearch

RUN \
    npm i -g corepack@latest \
    && corepack enable \
    && corepack use $(sed -n 's/.*"packageManager": "\(.*\)".*/\1/p' package.json) \
    && pnpm i \
    && pnpm run build

FROM python:${PYTHON_VERSION}-slim AS build_zjsearch

WORKDIR /app

COPY --from=build_zjsearch_frontend /tmp/BUILDTMP/SEARXNG/requirements.txt /app/requirements.txt
COPY --from=build_zjsearch_frontend /tmp/BUILDTMP/SEARXNG/searx /app/searx

ENV \
    XDG_CACHE_HOME="/app"

RUN \
    apt update \
    && apt install -qy \
        brotli \
        build-essential \
        git \
        openssl \
        cmake gfortran libopenblas-dev pkg-config \
        # indexed-zstd (a camoufox dependency) builds from source when the
        # platform/python lacks a wheel -- it needs the zstd headers
        libzstd-dev \
    && python3 -m venv /app \
    && . /app/bin/activate \
    && pip install --no-cache -r requirements.txt \
    && pip install --no-cache \
        tzdata \
    # the built-in render engine's browser bundle (zjsearch.browser):
    # XDG_CACHE_HOME pins the camoufox install into /app so the final
    # stage ships it together with the venv (the runtime ENV re-exports
    # the same path)
    && python3 -m searx.zjsearch.ai.browser.install \
    && python3 -m compileall -q searx \
    # the vite build's closeBundle pass (tools/assets.ts) already wrote
    # .gz/.br siblings for the zjsearch artifacts -- -f makes this pass
    # deterministic over them (gzip exits 1 "already exists" without it,
    # find swallows the failure and the siblings silently stay stale);
    # .wasm/.data join the filter for the PGLite engine's --best brotli
    # (WhiteNoise only serves on-disk .gz/.br siblings, per Accept-Encoding)
    && find searx/static \( -name '*.html' -o -name '*.css' -o -name '*.js' \
        -o -name '*.svg' -o -name '*.ttf' -o -name '*.eot' \
        -o -name '*.wasm' -o -name '*.data' \) \
        -type f -exec gzip -9 -k -f {} \+ -exec brotli --best -f {} \+ \
    && rm -rf /tmp/* /var/lib/apt/lists/* /var/tmp/*

# The browser's ~2GB font library is packed per SPOOF-OS group
# (fonts/groups.json: L/M/W letter combinations, each face stored once), and
# the launch pins os:"windows" (browser/engine.py) -- the fontconfig only ever
# mounts the groups the pinned OS reads, so the other OSes' EXCLUSIVE groups
# are dead weight in the image (~850 MB on this bundle).  Drop them keyed on
# groups.json itself, so upstream regroupings stay covered; a missing file or
# group fails the build loudly rather than shipping a surprise.  Image-only:
# a dev workstation's install is untouched.  A separate RUN is safe because
# the final stage COPYs /app's end state -- intermediate layers never reach it.
RUN \
    python3 -c '
import json, shutil
from pathlib import Path

for fonts in Path("/app/camoufox/browsers").glob("*/*/fonts"):
    meta = json.loads((fonts / "groups.json").read_bytes())
    keep = set(meta["readBy"]["win"])
    for name in meta["groups"]:
        if name not in keep and (fonts / name).is_dir():
            shutil.rmtree(fonts / name)
            print("zjsearch browser: trimmed font group", name)
'

FROM python:${PYTHON_VERSION}-slim AS rebased_searxng

# the built-in browser's runtime: Xvfb (zjsearch.browser.mode: virtual) and
# the Firefox/GTK library set -- the SAME base image the venv was built on,
# so nothing needs hand-copying out of a distroless assembly.  NO system
# font packages: camoufox ships its bundled font library as the identity's
# font list and its runtime fontconfig isolates the browser from the
# system's -- fonts stay at native camoufox handling.
RUN \
    apt update \
    && apt install -qy --no-install-recommends \
        xvfb \
        libgtk-3-0 \
        libdbus-glib-1-2 \
        libxt6 \
        libasound2 \
        libx11-xcb1 libxcb1 \
        libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 \
        libxkbcommon0 libgbm1 libdrm2 \
    && rm -rf /var/lib/apt/lists/*

# the runtime trust store is curl.se's fresh bundle from the frontend stage
# (replaces the debian-shipped one; /usr/lib/ssl/cert.pem symlinks here, so
# python, curl_cffi and git all verify against it)
COPY --from=build_zjsearch_frontend /tmp/BUILDTMP/SEARXNG/cacert.pem /etc/ssl/certs/ca-certificates.crt

COPY --from=build_zjsearch /app /app

COPY --from=build_zjsearch /app/searx/settings.yml /app/searx/limiter.toml /app/searx/favicons/favicons.toml /config/

FROM scratch

COPY --from=rebased_searxng / /

ENV \
    PYTHONPATH="/app" \
    SEARXNG_SETTINGS_PATH="/config/settings.yml" \
    XDG_CACHE_HOME="/app"

EXPOSE 8888/tcp

ENTRYPOINT ["/app/bin/python"]

CMD ["-m", "searx.webapp"]
