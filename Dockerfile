# 完全自包含镜像：Node.js 运行时与生产依赖以单文件 tar.gz 随包分发（vendor/）
# 构建时不需要 npm install、不需要 node 基础镜像，只需一个 glibc 基础镜像。
#
# 国内网络拉不动 Docker Hub 时，可换镜像源构建，例如：
#   docker build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim -t mikanime-stream .

ARG BASE_IMAGE=debian:bookworm-slim
FROM ${BASE_IMAGE}

# 目标架构（x86_64 = amd64，ARM 型号 = arm64；Container Manager 构建时会自动传入）
ARG TARGETARCH=amd64

# 内置 Node.js 运行时（单文件压缩包，解压后显式恢复可执行权限）
COPY vendor/node-${TARGETARCH}.tar.gz /tmp/node.tar.gz
RUN mkdir -p /opt/node \
    && tar -xzf /tmp/node.tar.gz -C /opt/node \
    && chmod +x /opt/node/bin/node \
    && rm /tmp/node.tar.gz

# 项目源码
COPY . /app/

# 内置生产依赖（单文件压缩包，解压到 /app/node_modules）
COPY vendor/deps.tar.gz /tmp/deps.tar.gz
RUN mkdir -p /app/node_modules \
    && tar -xzf /tmp/deps.tar.gz -C /app/node_modules \
    && rm /tmp/deps.tar.gz \
    && test -d /app/node_modules/express \
    && test -d /app/node_modules/cheerio \
    && test -d /app/node_modules/ws \
    && test -d /app/node_modules/bencode

WORKDIR /app
ENV PATH=/opt/node/bin:$PATH
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.mjs"]
