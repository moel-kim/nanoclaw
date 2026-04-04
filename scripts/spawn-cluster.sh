#!/bin/bash
# ============================================================
# NanoClaw Cluster Spawner
# 여러 NanoClaw 인스턴스를 PM2로 동시 운영
#
# 사용법:
#   bash scripts/spawn-cluster.sh [인스턴스수] [베이스포트] [동시컨테이너수]
#
# 예시:
#   bash scripts/spawn-cluster.sh          # 기본: 3개, 포트 3001~, 컨테이너 5개
#   bash scripts/spawn-cluster.sh 5 4001 3 # 5개, 포트 4001~, 컨테이너 3개
#   bash scripts/spawn-cluster.sh 10       # 10개, 포트 3001~, 컨테이너 5개
# ============================================================

set -e

COUNT=${1:-3}
BASE_PORT=${2:-3001}
MAX_CONTAINERS=${3:-5}
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_DIR="$HOME/nanoclaw-cluster"
PM2_CONFIG="$CLUSTER_DIR/ecosystem.config.cjs"

echo "🚀 NanoClaw Cluster Spawner"
echo "   인스턴스 수: $COUNT"
echo "   포트 범위:   $BASE_PORT ~ $((BASE_PORT + COUNT - 1))"
echo "   동시 컨테이너/인스턴스: $MAX_CONTAINERS"
echo "   소스 경로:   $SOURCE_DIR"
echo "   클러스터 경로: $CLUSTER_DIR"
echo ""

# ── 사전 확인 ────────────────────────────────────────────────
if ! command -v pm2 &> /dev/null; then
  echo "❌ PM2가 설치되어 있지 않습니다."
  echo "   설치: npm install -g pm2"
  exit 1
fi

if [ ! -f "$SOURCE_DIR/dist/index.js" ]; then
  echo "❌ 빌드 파일이 없습니다. 먼저 빌드하세요:"
  echo "   cd $SOURCE_DIR && npm run build"
  exit 1
fi

# ── 클러스터 디렉터리 구조 생성 ──────────────────────────────
mkdir -p "$CLUSTER_DIR"

# 공유 store 디렉터리 (모든 인스턴스가 같은 DB 사용)
SHARED_STORE="$CLUSTER_DIR/store"
mkdir -p "$SHARED_STORE"

# 기존 DB가 없으면 소스에서 복사
if [ ! -f "$SHARED_STORE/messages.db" ] && [ -f "$SOURCE_DIR/store/messages.db" ]; then
  cp "$SOURCE_DIR/store/messages.db" "$SHARED_STORE/messages.db"
  echo "📦 DB 복사 완료: $SHARED_STORE/messages.db"
fi

# 인스턴스별 디렉터리 생성 및 심링크
echo "📁 인스턴스 디렉터리 생성 중..."
for i in $(seq 1 $COUNT); do
  INSTANCE_DIR="$CLUSTER_DIR/instance-$i"
  mkdir -p "$INSTANCE_DIR"

  # dist, node_modules는 심링크 (디스크 절약)
  [ ! -L "$INSTANCE_DIR/dist" ] && ln -sf "$SOURCE_DIR/dist" "$INSTANCE_DIR/dist"
  [ ! -L "$INSTANCE_DIR/node_modules" ] && ln -sf "$SOURCE_DIR/node_modules" "$INSTANCE_DIR/node_modules"
  [ ! -L "$INSTANCE_DIR/package.json" ] && ln -sf "$SOURCE_DIR/package.json" "$INSTANCE_DIR/package.json"

  # 인스턴스별 data, logs 디렉터리
  mkdir -p "$INSTANCE_DIR/data/sessions"
  mkdir -p "$INSTANCE_DIR/logs"

  echo "   ✓ instance-$i (포트: $((BASE_PORT + i - 1)))"
done

# ── PM2 ecosystem.config.cjs 생성 ────────────────────────────
echo ""
echo "📝 PM2 설정 생성 중..."

cat > "$PM2_CONFIG" << ECOSYSTEM_EOF
// NanoClaw Cluster — PM2 Ecosystem Config
// 생성일: $(date '+%Y-%m-%d %H:%M:%S')
// 인스턴스: $COUNT개 | 포트: $BASE_PORT~$((BASE_PORT + COUNT - 1))

module.exports = {
  apps: [
$(for i in $(seq 1 $COUNT); do
PORT=$((BASE_PORT + i - 1))
cat << APP_EOF
    {
      name: "nanoclaw-$i",
      script: "dist/index.js",
      cwd: "$CLUSTER_DIR/instance-$i",
      env: {
        NODE_ENV: "production",
        CREDENTIAL_PROXY_PORT: "$PORT",
        MAX_CONCURRENT_CONTAINERS: "$MAX_CONTAINERS",
        // 공유 DB 경로
        STORE_PATH: "$SHARED_STORE/messages.db",
      },
      // 재시작 정책
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: "10s",
      // 로그
      out_file: "$CLUSTER_DIR/instance-$i/logs/out.log",
      error_file: "$CLUSTER_DIR/instance-$i/logs/err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
APP_EOF
[ $i -lt $COUNT ] && echo ","
done)
  ],
};
ECOSYSTEM_EOF

echo "   ✓ $PM2_CONFIG"

# ── PM2 시작 ─────────────────────────────────────────────────
echo ""
echo "🚀 PM2 클러스터 시작 중..."
pm2 start "$PM2_CONFIG"
pm2 save

echo ""
echo "✅ 클러스터 시작 완료!"
echo ""
echo "📊 상태 확인:"
echo "   pm2 list"
echo "   pm2 logs nanoclaw-1"
echo "   pm2 monit"
echo ""
echo "🛑 전체 중지:"
echo "   pm2 stop all"
echo ""
echo "🔄 재시작:"
echo "   pm2 restart all"
echo ""
echo "📈 동시 컨테이너 수 변경:"
echo "   MAX_CONCURRENT_CONTAINERS=10 pm2 restart all --update-env"
