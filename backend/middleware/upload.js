// backend/middleware/upload.js
const multer = require('multer');
const crypto = require('crypto');
const multerS3 = require('multer-s3');
const AWS = require('aws-sdk');

AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION || 'ap-northeast-2',
});

const s3 = new AWS.S3();

// MIME 타입과 확장자 매핑
const ALLOWED_TYPES = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'video/mp4': ['.mp4'],
  'video/webm': ['.webm'],
  'video/quicktime': ['.mov'],
  'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'],
  'audio/ogg': ['.ogg'],
  'application/pdf': ['.pdf'],
  'application/msword': ['.doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx']
};

// 파일 타입별 크기 제한 설정
const FILE_SIZE_LIMITS = {
  image: 10 * 1024 * 1024,  // 10MB for images
  video: 50 * 1024 * 1024,  // 50MB for videos
  audio: 20 * 1024 * 1024,  // 20MB for audio
  document: 20 * 1024 * 1024 // 20MB for documents
};

const storage = multerS3({
  s3: s3,
  bucket: process.env.AWS_S3_BUCKET,
  contentType: multerS3.AUTO_CONTENT_TYPE,
  key: function (req, file, cb) {
    try {
      const originalname = Buffer.from(file.originalname, 'binary').toString('utf8');
      req.originalFileName = originalname;
      const ext = originalname.substring(originalname.lastIndexOf('.')).toLowerCase();
      const timestamp = Date.now();
      const randomString = crypto.randomBytes(8).toString('hex');
      const safeFilename = `${timestamp}_${randomString}${ext}`;
      const allowedExtensions = Object.values(ALLOWED_TYPES).flat();
      if (!allowedExtensions.includes(ext)) {
        return cb(new Error('지원하지 않는 파일 확장자입니다.'));
      }
      cb(null, safeFilename);
    } catch (error) {
      console.error('S3 filename processing error:', error);
      cb(new Error('파일명 처리 중 오류가 발생했습니다.'));
    }
  }
});

const getFileType = (mimetype) => {
  const typeMap = {
    'image': '이미지',
    'video': '동영상',
    'audio': '오디오',
    'application': '문서'
  };
  const type = mimetype.split('/')[0];
  return typeMap[type] || '파일';
};

const validateFileSize = (file) => {
  const type = file.mimetype.split('/')[0];
  const limit = FILE_SIZE_LIMITS[type] || FILE_SIZE_LIMITS.document;
  
  if (file.size > limit) {
    const limitInMB = Math.floor(limit / 1024 / 1024);
    throw new Error(`${getFileType(file.mimetype)} 파일은 ${limitInMB}MB를 초과할 수 없습니다.`);
  }
  return true;
};

const fileFilter = (req, file, cb) => {
  try {
    // 파일명을 UTF-8로 디코딩
    const originalname = Buffer.from(file.originalname, 'binary').toString('utf8');
    
    // MIME 타입 검증
    if (!ALLOWED_TYPES[file.mimetype]) {
      const fileType = getFileType(file.mimetype);
      return cb(new Error(`지원하지 않는 ${fileType} 형식입니다.`), false);
    }

    // Content-Length 헤더 검증
    const declaredSize = parseInt(req.headers['content-length']);
    if (declaredSize > 50 * 1024 * 1024) {
      return cb(new Error('파일 크기는 50MB를 초과할 수 없습니다.'), false);
    }

    // 파일명 길이 검증 (UTF-8 바이트 길이 기준)
    const filenameBytes = Buffer.from(originalname, 'utf8').length;
    if (filenameBytes > 255) {
      return cb(new Error('파일명이 너무 깁니다.'), false);
    }

    // 파일 확장자와 MIME 타입 일치 여부 확인
    const ext = originalname.substring(originalname.lastIndexOf('.')).toLowerCase();
    if (!ALLOWED_TYPES[file.mimetype].includes(ext)) {
      const fileType = getFileType(file.mimetype);
      return cb(new Error(`${fileType} 확장자가 올바르지 않습니다.`), false);
    }

    // 원본 파일명을 multer의 file 객체에 저장
    file.originalname = originalname;

    cb(null, true);
  } catch (error) {
    console.error('File filter error:', error);
    cb(error);
  }
};

// multer 인스턴스 생성
const uploadMiddleware = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
    files: 1 // 한 번에 하나의 파일만 업로드 가능
  },
  fileFilter: fileFilter
});

// 에러 핸들러 미들웨어
const errorHandler = (error, req, res, next) => {
  console.error('File upload error:', {
    error: error.message,
    stack: error.stack,
    file: req.file
  });

  // 업로드된 파일이 있다면 삭제
  if (req.file) {
    try {
      // S3에서 파일 삭제
      const Key = req.file.key; // multer-s3에서 생성된 키
      if (Key) {
        s3.deleteObject({ Bucket: process.env.AWS_S3_BUCKET, Key: Key }, (s3Err) => {
          if (s3Err) {
            console.error('Failed to delete S3 file:', s3Err);
          } else {
            console.log('S3 file deleted successfully:', Key);
          }
        });
      }
    } catch (unlinkError) {
      console.error('Failed to delete uploaded file:', unlinkError);
    }
  }

  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return res.status(413).json({
          success: false,
          message: '파일 크기는 50MB를 초과할 수 없습니다.'
        });
      case 'LIMIT_FILE_COUNT':
        return res.status(400).json({
          success: false,
          message: '한 번에 하나의 파일만 업로드할 수 있습니다.'
        });
      case 'LIMIT_UNEXPECTED_FILE':
        return res.status(400).json({
          success: false,
          message: '잘못된 형식의 파일입니다.'
        });
      default:
        return res.status(400).json({
          success: false,
          message: `파일 업로드 오류: ${error.message}`
        });
    }
  }
  
  if (error) {
    return res.status(400).json({
      success: false,
      message: error.message || '파일 업로드 중 오류가 발생했습니다.'
    });
  }
  
  next();
};

// 파일 경로 검증 함수
const isPathSafe = (filepath) => {
  try {
    // S3 파일 경로는 키 형태이므로 검증이 필요 없음
    return true;
  } catch (error) {
    console.error('Path validation error:', error);
    return false;
  }
};

module.exports = {
  upload: uploadMiddleware,
  errorHandler,
  uploadDir: null, // S3 사용으로 인해 로컬 디렉토리 경로는 사용되지 않음
  isPathSafe,
  validateFileSize,
  ALLOWED_TYPES,
  getFileType
};