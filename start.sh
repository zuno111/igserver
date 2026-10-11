#!/usr/bin/env bash
# igServer 원클릭 실행 (Mac / Linux / 라즈베리파이)
cd "$(dirname "$0")"

echo "============================================"
echo "  igServer - STUDIO ig 공통 서버"
echo "============================================"

# 빌드된 단독 실행파일이 있으면 Node 없이 바로 실행
if [ -x "./igserver" ]; then
  echo "[실행파일] 단독 실행파일로 시작 (Node 불필요)"
  echo "  관리 대시보드: http://localhost:${PORT:-8787}/admin/"
  exec ./igserver
fi
if [ -x "./dist/igserver" ]; then
  echo "[실행파일] dist/ 단독 실행파일로 시작 (Node 불필요)"
  echo "  관리 대시보드: http://localhost:${PORT:-8787}/admin/"
  cd dist && exec ./igserver
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[안내] Node.js 가 설치되어 있지 않습니다."
  echo "       라즈베리파이: sudo apt install -y nodejs npm"
  echo "       또는 https://nodejs.org 에서 설치하세요."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "[1/2] 최초 1회 구성요소 설치 중..."
  npm install --no-audit --no-fund || { echo "[오류] 설치 실패"; exit 1; }
fi

echo "[2/2] 서버 시작"
echo "  관리 대시보드: http://localhost:${PORT:-8787}/admin/"
echo "  (종료: Ctrl+C)"
exec node src/index.js
