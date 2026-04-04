#
# Copyright © 2022-2024 contains code contributed by Orange SA,
# authors: Denis Barbaron - Licensed under the Apache license 2.0
#

# ========== 构建阶段 ==========
FROM ubuntu:20.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

ARG APT_MIRROR="http://mirrors.tuna.tsinghua.edu.cn/ubuntu"
ARG NPM_REGISTRY="https://registry.npmmirror.com"
ARG NODE_VERSION="18.20.5"
ARG NODE_DIST="https://nodejs.org/dist"

RUN sed -i "s|http://archive.ubuntu.com/ubuntu|${APT_MIRROR}|g" /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      wget xz-utils python3 build-essential \
      libzmq3-dev libprotobuf-dev git ca-certificates \
      openjdk-8-jdk-headless && \
    cd /tmp && \
    wget -nv --timeout=30 --tries=3 "${NODE_DIST}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" && \
    tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" --strip-components 1 -C /usr/local && \
    rm -f node-*.tar.xz && \
    apt-get purge -y wget xz-utils && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/*

#测试
WORKDIR /build
COPY . .

RUN sed -i '/phantomjs/d' package.json && \
    npm config set registry "${NPM_REGISTRY}" && \
    npm install --python="/usr/bin/python3" --omit=optional --no-audit --no-fund --ignore-scripts && \
    if [ -d "res/bower_components" ] && [ -n "$(ls -A res/bower_components 2>/dev/null)" ]; then \
      echo "Using local res/bower_components (skip bower install)"; \
      ./node_modules/.bin/gulp build || true; \
    else \
      ./node_modules/.bin/bower install --allow-root || true; \
      ./node_modules/.bin/gulp build || true; \
    fi && \
    npm pack && \
    npm prune --omit=dev

# ========== 运行阶段 ==========
FROM ubuntu:20.04

ENV DEBIAN_FRONTEND=noninteractive

ARG APT_MIRROR="http://mirrors.tuna.tsinghua.edu.cn/ubuntu"
ARG PIP_INDEX_URL="https://pypi.tuna.tsinghua.edu.cn/simple"

RUN sed -i "s|http://archive.ubuntu.com/ubuntu|${APT_MIRROR}|g" /etc/apt/sources.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends \
      libzmq5 libprotobuf17 graphicsmagick ca-certificates \
      python3 python3-pip adb \
      openjdk-8-jre-headless && \
    ln -sf /usr/bin/python3 /usr/bin/python && \
    python3 -m pip install --no-cache-dir -i "${PIP_INDEX_URL}" \
      uiautomator2 pillow requests && \
    python3 -c "import uiautomator2,requests; from PIL import Image; print('python_deps_ok')" && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --create-home --shell /bin/bash stf

COPY --from=builder /usr/local /usr/local
COPY --from=builder /build/devicefarmer-stf-*.tgz /tmp/
COPY --from=builder --chown=stf:stf /build/node_modules /app/node_modules

RUN mkdir -p /app && \
    tar xzf /tmp/devicefarmer-stf-*.tgz \
      --strip-components 1 \
      --owner=stf --group=stf \
      -C /app && \
    rm -f /tmp/*.tgz && \
    sed -i 's/--no-deprecation//g' /app/bin/stf 2>/dev/null || true && \
    sed -i 's/--no-deprecation//g' /app/lib/cli/please.js 2>/dev/null || true && \
    sed -i '1s|.*|#!/usr/bin/env node|' /app/bin/stf 2>/dev/null || true && \
    mkdir -p /app/bundletool && \
    chown stf:stf /app /app/bundletool

ENV PATH=/usr/local/bin:/app/bin:$PATH
ENV JAVA_HOME=/usr/lib/jvm/java-8-openjdk-amd64
ENV PATH=$JAVA_HOME/bin:$PATH

WORKDIR /app
EXPOSE 3000
USER stf

# 【修改】直接用 node 运行，移除启动脚本
ENTRYPOINT ["/usr/local/bin/node", "lib/cli/please.js"]
