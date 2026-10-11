#!/usr/bin/env bash
# 클러스터 검증: 게이트웨이 1 + 워커 2를 띄우고 자동 등록/프록시를 확인한 뒤 종료.
# 사용: bash test/cluster.sh
set +e
cd "$(dirname "$0")/.."
TMP="$(mktemp -d)"
echo "임시 데이터: $TMP"

MODE=gateway PORT=8787 node src/index.js > "$TMP/gw.log" 2>&1 & GW=$!
MODE=worker PORT=8801 DATA_DIR="$TMP/wA" SELF_URL=http://localhost:8801 GATEWAY_URL=http://localhost:8787 NODE_LABEL=workerA node src/index.js > "$TMP/wA.log" 2>&1 & WA=$!
MODE=worker PORT=8802 DATA_DIR="$TMP/wB" SELF_URL=http://localhost:8802 GATEWAY_URL=http://localhost:8787 NODE_LABEL=workerB node src/index.js > "$TMP/wB.log" 2>&1 & WB=$!

sleep 8
PASS=0; FAIL=0
check() { if echo "$2" | grep -q "$3"; then echo "  ✓ $1"; PASS=$((PASS+1)); else echo "  ✗ $1 → $2"; FAIL=$((FAIL+1)); fi; }

check "워커A 직접 기동" "$(curl -s -m2 http://localhost:8801/healthz)" '"ok":true'
check "워커B 직접 기동" "$(curl -s -m2 http://localhost:8802/healthz)" '"ok":true'
check "워커 2대 자동 등록" "$(curl -s -m2 http://localhost:8787/cluster/nodes)" '"total":2'
check "게이트웨이 프록시 헬스" "$(curl -s -m2 http://localhost:8787/healthz)" 'ok'
check "게이트웨이 프록시 로그인" "$(curl -s -m2 -X POST http://localhost:8787/admin/api/login -H 'Content-Type: application/json' --data-binary '{"email":"admin@studio-ig.local","password":"admin1234"}')" 'token'

kill $GW $WA $WB 2>/dev/null
wait 2>/dev/null
rm -rf "$TMP"
echo ""
echo "클러스터 결과: $PASS 통과 / $FAIL 실패"
exit $FAIL
