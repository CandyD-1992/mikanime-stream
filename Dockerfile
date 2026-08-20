# 完全自包含镜像：Node.js 运行时与生产依赖以单文件 tar.gz 随包分发（vendor/）
# 构建时不需要 npm install、不需要 node 基础镜像，只需一个 glibc 基础镜像。
#
# 国内网络拉不动 Docker Hub 时，可换镜像源构建，例如：
#   docker build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/debian:bookworm-slim -t mikanime-stream .

ARG BASE_IMAGE=debian:bookworm-slim
FROM ${BASE_IMAGE}

# 内置 Node.js 运行时（单文件压缩包，解压后显式恢复可执行权限）。
# 同时复制 amd64/arm64 两个包，构建时按容器实际架构（uname -m）选择，
# 避免部分构建器不注入 TARGETARCH 导致 ARM 机器装错 x86 运行时。
COPY vendor/node-amd64.tar.gz /tmp/node-amd64.tar.gz
COPY vendor/node-arm64.tar.gz /tmp/node-arm64.tar.gz
RUN case "$(uname -m)" in \
      aarch64|arm64) NODE_TAR=node-arm64.tar.gz ;; \
      *) NODE_TAR=node-amd64.tar.gz ;; \
    esac \
    && mkdir -p /opt/node \
    && tar -xzf /tmp/$NODE_TAR -C /opt/node \
    && chmod +x /opt/node/bin/node \
    && rm -f /tmp/node-*.tar.gz

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
