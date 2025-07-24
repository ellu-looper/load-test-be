# 로드 테스트 최적화 멀티스테이지 빌드
FROM node:18-alpine AS base

# 성능 최적화를 위한 환경 설정
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=1024"
ENV UV_THREADPOOL_SIZE=16

# 패키지 매니저 설정 (성능 최적화)
RUN npm config set fetch-retries 3
RUN npm config set fetch-retry-factor 2
RUN npm config set fetch-retry-mintimeout 10000
RUN npm config set fetch-retry-maxtimeout 60000

# 시스템 최적화
RUN apk add --no-cache \
    tini \
    && rm -rf /var/cache/apk/*

WORKDIR /app

# 의존성 설치 단계 (캐싱 최적화)
FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production --no-audit --no-fund \
    && npm cache clean --force

# 프로덕션 빌드 단계
FROM base AS production

# 보안을 위한 non-root 사용자 생성
RUN addgroup -g 1001 -S nodejs \
    && adduser -S nodejs -u 1001

# 애플리케이션 코드 복사
COPY --chown=nodejs:nodejs . .
COPY --from=deps --chown=nodejs:nodejs /app/node_modules ./node_modules

# uploads 디렉토리 생성 및 권한 설정
RUN mkdir -p uploads \
    && chown -R nodejs:nodejs uploads \
    && chmod 755 uploads

# 로그 디렉토리 생성 (선택사항)
RUN mkdir -p logs \
    && chown -R nodejs:nodejs logs

# 불필요한 파일 제거 (이미지 사이즈 최적화)
RUN rm -rf \
    .git \
    .gitignore \
    README.md \
    Dockerfile \
    .dockerignore \
    tests \
    *.log

USER nodejs

# 헬스체크 추가
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:5000/health', (res) => { \
        process.exit(res.statusCode === 200 ? 0 : 1) \
    }).on('error', () => process.exit(1))"

EXPOSE 5000

# Tini를 사용하여 시그널 처리 최적화
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]