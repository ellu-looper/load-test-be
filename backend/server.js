require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const { router: roomsRouter, initializeSocket } = require('./routes/api/rooms');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5001;

// trust proxy 설정 추가
app.set('trust proxy', 1);

// CORS 설정
const corsOptions = {
  origin: [
    'https://bootcampchat-fe.run.goorm.site',
    'https://bootcampchat-hgxbv.dev-k8s.arkain.io',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'https://localhost:3000',
    'https://localhost:3001',
    'https://localhost:3002',
    'http://0.0.0.0:3000',
    'https://0.0.0.0:3000'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type', 
    'Authorization', 
    'x-auth-token', 
    'x-session-id',
    'Cache-Control',
    'Pragma'
  ],
  exposedHeaders: ['x-auth-token', 'x-session-id']
};

// 기본 미들웨어
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// OPTIONS 요청에 대한 처리
app.options('*', cors(corsOptions));

// 정적 파일 제공
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 요청 로깅
if (process.env.NODE_ENV === 'development') {
  app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    next();
  });
}

// 기본 상태 체크
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    env: process.env.NODE_ENV
  });
});

// API 라우트 마운트
app.use('/api', routes);

// Socket.IO Redis adapter for multi-pod support
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');

// Create Redis pub/sub clients for Socket.IO adapter
const createRedisClient = () => {
  const isClusterMode = process.env.REDIS_CLUSTER_NODES || process.env.NODE_ENV === 'production';
  
  if (isClusterMode && process.env.REDIS_CLUSTER_NODES) {
    const clusterNodes = process.env.REDIS_CLUSTER_NODES.split(',').map(node => {
      const [host, port] = node.split(':');
      return { host, port: parseInt(port) || 6379 };
    });
    
    return new Redis.Cluster(clusterNodes, {
      redisOptions: {
        family: 4,
        keepAlive: 30000,
        connectTimeout: 10000
      },
      enableOfflineQueue: true,
      enableReadyCheck: true,
      scaleReads: 'slave',
      maxRetriesPerRequest: 3
    });
  } else {
    // Fallback to single Redis instance or default cluster
    const { redisHost, redisPort } = require('./config/keys');
    return new Redis({
      host: redisHost || 'redis-cluster-0.redis-cluster-headless.default.svc.cluster.local',
      port: redisPort || 6379,
      family: 4,
      keepAlive: 30000,
      connectTimeout: 5000,
      retryDelayOnFailover: 100,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 3
    });
  }
};

// Socket.IO 설정
const io = socketIO(server, { cors: corsOptions });

// Configure Redis adapter for Socket.IO clustering
try {
  const pubClient = createRedisClient();
  const subClient = pubClient.duplicate();
  
  io.adapter(createAdapter(pubClient, subClient));
  console.log('Socket.IO Redis adapter configured for multi-pod support');
} catch (error) {
  console.warn('Failed to configure Redis adapter, falling back to memory adapter:', error.message);
  console.warn('Multi-pod Socket.IO will not work properly without Redis adapter');
}

require('./sockets/chat')(io);

// Socket.IO 객체 전달
initializeSocket(io);

// 404 에러 핸들러
app.use((req, res) => {
  console.log('404 Error:', req.originalUrl);
  res.status(404).json({
    success: false,
    message: '요청하신 리소스를 찾을 수 없습니다.',
    path: req.originalUrl
  });
});

// 글로벌 에러 핸들러
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || '서버 에러가 발생했습니다.',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// MongoDB connection optimized for 30-40 pods connecting to 2 MongoDB pods (maxConns=1000 each)
const mongooseOptions = {
  maxPoolSize: 40,          // Optimal: 40 per pod * 40 pods = 1600 total (80% of 2000 MongoDB capacity)
  minPoolSize: 5,           // Keep minimum connections ready for immediate use
  maxIdleTimeMS: 30000,     // Close idle connections after 30s
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
  bufferCommands: false,
  heartbeatFrequencyMS: 10000,
  readPreference: 'secondaryPreferred' // Use secondary for reads when available
};

// 서버 시작
mongoose.connect(process.env.MONGO_URI, mongooseOptions)
  .then(() => {
    console.log('MongoDB Connected with load testing optimizations');
    console.log(`Connection pool: max=${mongooseOptions.maxPoolSize}, min=${mongooseOptions.minPoolSize}`);
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Server running on port ${PORT}`);
      console.log('Environment:', process.env.NODE_ENV);
      console.log('API Base URL:', `http://0.0.0.0:${PORT}/api`);
    });
  })
  .catch(err => {
    console.error('Server startup error:', err);
    process.exit(1);
  });

module.exports = { app, server };