# 鲸翼企业版服务端镜像：一个容器、一个端口（8730），数据放在 /data。
# 构建：docker build -t whalewing-enterprise .
FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY admin/package.json admin/
COPY plugin/package.json plugin/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
# esbuild 的安装脚本被跳过了，这里补上它的二进制文件，再构建管理端网页、准备服务端发布目录。
RUN node node_modules/esbuild/install.js && npm run build && node scripts/pack.mjs --stage

FROM node:24-alpine
ENV NODE_ENV=production WWE_DATA=/data WWE_HOST=0.0.0.0 WWE_PORT=8730
WORKDIR /app
COPY --from=build /src/.artifacts/pack/server/ ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8730
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8730/api/v1/hello >/dev/null || exit 1
CMD ["node", "bin/whalewing-enterprise-server.js"]
