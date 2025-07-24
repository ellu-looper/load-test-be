// backend/config/keys.js
require('dotenv').config();

// 기본 키와 솔트 (개발 환경용)
const DEFAULT_ENCRYPTION_KEY = 'a'.repeat(64); // 32바이트를 hex로 표현
const DEFAULT_PASSWORD_SALT = 'b'.repeat(32); // 16바이트를 hex로 표현

// Environment validation for load testing
function validateEnvironment() {
  const required = ['MONGO_URI', 'JWT_SECRET'];
  const missing = required.filter(key => !process.env[key]);
  
  if (missing.length > 0) {
    console.error('Missing required environment variables:', missing);
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
  }
  
  // Warn about optional variables in production
  if (process.env.NODE_ENV === 'production') {
    const optional = ['REDIS_HOST', 'REDIS_PORT', 'OPENAI_API_KEY'];
    const missingOptional = optional.filter(key => !process.env[key]);
    if (missingOptional.length > 0) {
      console.warn('Missing optional environment variables:', missingOptional);
    }
  }
}

validateEnvironment();

module.exports = {
  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  encryptionKey: process.env.ENCRYPTION_KEY || DEFAULT_ENCRYPTION_KEY,
  passwordSalt: process.env.PASSWORD_SALT || DEFAULT_PASSWORD_SALT,
  redisHost: process.env.REDIS_HOST,
  redisPort: parseInt(process.env.REDIS_PORT) || 6379,
  openaiApiKey: process.env.OPENAI_API_KEY,
  vectorDbEndpoint: process.env.VECTOR_DB_ENDPOINT,
};