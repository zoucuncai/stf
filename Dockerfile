#
# Copyright © 2022-2024 contains code contributed by Orange SA,
# authors: Denis Barbaron - Licensed under the Apache license 2.0
#

# ========== 构建阶段 ==========
FROM ubuntu:20.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      wget xz-utils python3 build-essential \
      libzmq3-dev libprotobuf-dev git ca-certificates && \
    cd /tmp && \
    wget -q https://nodejs.org/dist/v16.20.2/node-v16.20.2-linux-x64.tar.xz && \
    tar -xJf node-v16.20.2-linux-x64.tar.xz --strip-components 1 -C /usr/local && \
    rm -f node-*.tar.xz && \
    mkdir -p /usr/lib/jvm && \
    wget -q https://github.com/adoptium/temurin8-binaries/releases/download/jdk8u432-b06/OpenJDK8U-jdk_x64_linux_hotspot_8u432b06.tar.gz -O - | \
    tar -xz -C /usr/lib/jvm --strip-components=1 && \
    apt-get purge -y wget xz-utils && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/*

WORKDIR /build
COPY . .

RUN sed -i '/phantomjs/d' package.json && \
    npm config set registry https://registry.npmmirror.com && \
    npm install --python="/usr/bin/python3" --omit=optional --no-audit --no-fund && \
    npm pack && \
    npm prune --omit=dev

# ========== 运行阶段 ==========
FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libzmq5 libprotobuf17 graphicsmagick ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --create-home --shell /bin/bash stf

COPY --from=builder /usr/local /usr/local
COPY --from=builder /usr/lib/jvm /usr/lib/jvm
COPY --from=builder /build/devicefarmer-stf-*.tgz /tmp/
COPY --from=builder /build/node_modules /app/node_modules

RUN mkdir -p /app && \
    tar xzf /tmp/devicefarmer-stf-*.tgz --strip-components 1 -C /app && \
    rm -f /tmp/*.tgz && \
    sed -i 's/--no-deprecation//g' /app/bin/stf 2>/dev/null || true && \
    sed -i 's/--no-deprecation//g' /app/lib/cli/please.js 2>/dev/null || true && \
    sed -i '1s|.*|#!/usr/bin/env node|' /app/bin/stf 2>/dev/null || true && \
    mkdir -p /app/bundletool && \
    chown -R stf:stf /app

ENV PATH=/usr/local/bin:/app/bin:$PATH
ENV JAVA_HOME=/usr/lib/jvm
ENV PATH=$JAVA_HOME/bin:$PATH

WORKDIR /app
EXPOSE 3000
USER stf

# 【修改】直接用 node 运行，移除启动脚本
ENTRYPOINT ["/usr/local/bin/node", "lib/cli/please.js"]
