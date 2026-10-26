# igServer 온라인 배포용 이미지 (Render/Railway/Fly 등 어디서든 동일하게 뜬다).
# pg·ws·bcryptjs·express 는 순수 JS라 네이티브 빌드 없이 설치된다.
# better-sqlite3 는 선택 의존성 — 빌드 못 해도 무시하고 진행(온라인은 postgres 사용).
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund || npm install --omit=dev --omit=optional --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 8787
CMD ["node", "src/index.js"]
