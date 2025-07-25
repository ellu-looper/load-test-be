// backend/utils/redisClient.js
const Redis = require('ioredis');
const { redisHost, redisPort } = require('../config/keys');

// Redis Cluster configuration - Force cluster mode in production
const isClusterMode = process.env.REDIS_CLUSTER_NODES || process.env.NODE_ENV === 'production';
console.log('Redis cluster mode detection:', { 
  isClusterMode, 
  hasClusterNodes: !!process.env.REDIS_CLUSTER_NODES,
  nodeEnv: process.env.NODE_ENV 
});
const clusterNodes = process.env.REDIS_CLUSTER_NODES ? 
  process.env.REDIS_CLUSTER_NODES.split(',').map(node => {
    const [host, port] = node.split(':');
    return { host, port: parseInt(port) || 6379 };
  }) : [
    { host: 'redis-cluster-0.redis-cluster-headless.default.svc.cluster.local', port: 6379 },
    { host: 'redis-cluster-1.redis-cluster-headless.default.svc.cluster.local', port: 6379 },
    { host: 'redis-cluster-2.redis-cluster-headless.default.svc.cluster.local', port: 6379 }
  ];

class MockRedisClient {
  constructor() {
    this.store = new Map();
    this.isConnected = true;
    console.log('Using in-memory Redis mock (Redis server not available)');
    this.setOps = {
      sadd: async (setKey, value) => {
        let set = this.store.get(setKey);
        if (!set) {
          set = new Set();
          this.store.set(setKey, set);
        }
        set.add(value);
        return 1;
      },
      smembers: async (setKey) => {
        const set = this.store.get(setKey);
        return set ? Array.from(set) : [];
      }
    };
  }

  async connect() {
    return this;
  }

  async set(key, value, options = {}) {
    const stringValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
    this.store.set(key, { value: stringValue, expires: options.ttl ? Date.now() + (options.ttl * 1000) : null });
    return 'OK';
  }

  async get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    
    if (item.expires && Date.now() > item.expires) {
      this.store.delete(key);
      return null;
    }
    
    try {
      return JSON.parse(item.value);
    } catch {
      return item.value;
    }
  }

  async setEx(key, seconds, value) {
    return this.set(key, value, { ttl: seconds });
  }

  async del(key) {
    return this.store.delete(key) ? 1 : 0;
  }

  async expire(key, seconds) {
    const item = this.store.get(key);
    if (item) {
      item.expires = Date.now() + (seconds * 1000);
      return 1;
    }
    return 0;
  }

  async quit() {
    this.store.clear();
    console.log('Mock Redis connection closed');
  }

  async keys(pattern) {
    // 간단한 glob 패턴 매칭 (실제 Redis와 다를 수 있음)
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return Array.from(this.store.keys()).filter(key => regex.test(key));
  }
}

class RedisClient {
  constructor() {
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetries = 5;
    this.retryDelay = 5000;
    this.useMock = false;
    this.isCluster = isClusterMode;
    this.setOps = {
      sadd: async (setKey, value) => {
        if (!this.isConnected) await this.connect();
        if (this.useMock) return this.client.setOps.sadd(setKey, value);
        return this.client.sadd(setKey, value);
      },
      smembers: async (setKey) => {
        if (!this.isConnected) await this.connect();
        if (this.useMock) return this.client.setOps.smembers(setKey);
        return this.client.smembers(setKey);
      }
    };
  }

  async connect() {
    if (this.isConnected && this.client) {
      return this.client;
    }

    // For development without Redis, use mock
    if (process.env.NODE_ENV === 'development' && (!redisHost || !redisPort)) {
      console.log('Development mode: Redis configuration not found, using in-memory mock');
      this.client = new MockRedisClient();
      this.isConnected = true;
      this.useMock = true;
      return this.client;
    }

    // Production requires Redis
    if (process.env.NODE_ENV === 'production' && (!redisHost || !redisPort) && !process.env.REDIS_CLUSTER_NODES) {
      throw new Error('Redis configuration is required for production environment');
    }

    try {
      if (this.isCluster && clusterNodes.length > 1) {
        console.log('Connecting to Redis Cluster with ioredis...', clusterNodes);
        console.log('DEBUG: Creating cluster with nodes:', JSON.stringify(clusterNodes, null, 2));
        
        // ioredis cluster syntax - much better cluster support
        const startupNodes = clusterNodes.map(node => ({
          host: node.host,
          port: node.port
        }));
        
        this.client = new Redis.Cluster(startupNodes, {
          redisOptions: {
            family: 4,
            keepAlive: 30000,
            connectTimeout: 10000,
            lazyConnect: false
          },
          enableOfflineQueue: true,
          enableReadyCheck: true,
          scaleReads: 'slave',
          maxRetriesPerRequest: 3
        });
      } else {
        console.log('Connecting to Redis single instance with ioredis...');
        
        this.client = new Redis({
          host: redisHost,
          port: redisPort,
          family: 4,
          keepAlive: 30000,
          connectTimeout: 5000,
          lazyConnect: true,
          retryDelayOnFailover: 100,
          enableOfflineQueue: false,
          maxRetriesPerRequest: this.maxRetries
        });
      }

      this.client.on('connect', () => {
        console.log(`Redis ${this.isCluster ? 'Cluster' : 'Client'} Connected`);
        this.isConnected = true;
        this.connectionAttempts = 0;
      });

      this.client.on('ready', () => {
        console.log(`Redis ${this.isCluster ? 'Cluster' : 'Client'} Ready`);
      });

      this.client.on('error', (err) => {
        console.error('Redis Client Error:', err.message);
        this.isConnected = false;
        
        // Only fallback to mock in development
        if (process.env.NODE_ENV === 'development' && !this.useMock) {
          console.log('Development mode: Switching to in-memory mock Redis');
          this.client = new MockRedisClient();
          this.isConnected = true;
          this.useMock = true;
        }
      });

      if (this.isCluster) {
        this.client.on('node error', (err, node) => {
          console.error(`Redis cluster node error [${node.host}:${node.port}]:`, err.message);
        });
      }

      // ioredis connects automatically, no need for explicit connect()
      return this.client;

    } catch (error) {
      console.error('Redis connection failed:', error.message);
      
      // Only fallback to mock in development
      if (process.env.NODE_ENV === 'development') {
        console.log('Development mode: Using in-memory mock Redis instead');
        this.client = new MockRedisClient();
        this.isConnected = true;
        this.useMock = true;
        return this.client;
      } else {
        throw error;
      }
    }
  }

  async set(key, value, options = {}) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.set(key, value, options);
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      if (options.ttl) {
        return await this.client.setex(key, options.ttl, stringValue);
      }
      return await this.client.set(key, stringValue);
    } catch (error) {
      console.error('Redis set error:', error);
      throw error;
    }
  }

  async get(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.get(key);
      }

      const value = await this.client.get(key);
      if (!value) return null;

      try {
        return JSON.parse(value);
      } catch (parseError) {
        return value;
      }
    } catch (error) {
      console.error('Redis get error:', error);
      throw error;
    }
  }

  async setEx(key, seconds, value) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }

      if (this.useMock) {
        return await this.client.setex(key, seconds, value);
      }

      let stringValue;
      if (typeof value === 'object') {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }

      return await this.client.setex(key, seconds, stringValue);
    } catch (error) {
      console.error('Redis setEx error:', error);
      throw error;
    }
  }

  async del(key) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      return await this.client.del(key);
    } catch (error) {
      console.error('Redis del error:', error);
      throw error;
    }
  }

  async expire(key, seconds) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      return await this.client.expire(key, seconds);
    } catch (error) {
      console.error('Redis expire error:', error);
      throw error;
    }
  }

  async quit() {
    if (this.client) {
      try {
        await this.client.quit();
        this.isConnected = false;
        this.client = null;
        console.log('Redis connection closed successfully');
      } catch (error) {
        console.error('Redis quit error:', error);
      }
    }
  }

  async keys(pattern) {
    try {
      if (!this.isConnected) {
        await this.connect();
      }
      if (this.useMock) {
        return await this.client.keys(pattern);
      }
      return await this.client.keys(pattern);
    } catch (error) {
      console.error('Redis keys error:', error);
      throw error;
    }
  }
}

const redisClient = new RedisClient();

module.exports = redisClient;