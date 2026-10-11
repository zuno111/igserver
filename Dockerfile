# igServer 컨테이너. 어디서나(Fly.io/Render/VPS/라즈베리파이) 동일하게 실행.
FROM node:20-bookworm-slim

WORKDIR /app

# better-sqlite3 네이티브 빌드 도구 (prebuilt 없을 때 대비)
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV PORT=8787 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8787
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
