const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { upload } = require('../middleware/upload');
const path = require('path');
const fs = require('fs').promises;
const redisClient = require('../utils/redisClient');
const USER_PROFILE_TTL = 24 * 60 * 60; // 24 hours
const MENTION_USERS_TTL = 10 * 60; // 10분

// 멘션용 사용자 목록 조회
exports.mentionableUsers = async (req, res) => {
  try {
    const cacheKey = 'mention:users';
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      return res.json({ success: true, users: JSON.parse(cached) });
    }
    // 전체 사용자 목록(탈퇴/비활성 제외, 이름/프로필만)
    const users = await User.find({}, 'name profileImage').lean();
    await redisClient.setEx(cacheKey, MENTION_USERS_TTL, JSON.stringify(users));
    res.json({ success: true, users });
  } catch (error) {
    res.status(500).json({ success: false, message: '사용자 목록 조회 중 오류', error: error.message });
  }
};

// 회원가입
exports.register = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 입력값 검증
    const validationErrors = [];
    
    if (!name || name.trim().length === 0) {
      validationErrors.push({
        field: 'name',
        message: '이름을 입력해주세요.'
      });
    } else if (name.length < 2) {
      validationErrors.push({
        field: 'name',
        message: '이름은 2자 이상이어야 합니다.'
      });
    }

    if (!email) {
      validationErrors.push({
        field: 'email',
        message: '이메일을 입력해주세요.'
      });
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      validationErrors.push({
        field: 'email',
        message: '올바른 이메일 형식이 아닙니다.'
      });
    }

    if (!password) {
      validationErrors.push({
        field: 'password',
        message: '비밀번호를 입력해주세요.'
      });
    } else if (password.length < 6) {
      validationErrors.push({
        field: 'password',
        message: '비밀번호는 6자 이상이어야 합니다.'
      });
    }

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: validationErrors
      });
    }

    // 사용자 중복 확인
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: '이미 가입된 이메일입니다.'
      });
    }

    // 비밀번호 암호화 및 사용자 생성
    const newUser = new User({ 
      name, 
      email, 
      password,
      profileImage: '' // 기본 프로필 이미지 없음
    });

    const salt = await bcrypt.genSalt(10);
    newUser.password = await bcrypt.hash(password, salt);
    await newUser.save();

    // mention:users 캐시 무효화
    await redisClient.del('mention:users');

    res.status(201).json({
      success: true,
      message: '회원가입이 완료되었습니다.',
      user: {
        id: newUser._id,
        name: newUser.name,
        email: newUser.email,
        profileImage: newUser.profileImage
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      message: '회원가입 처리 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 조회
exports.getProfile = async (req, res) => {
  try {
    const cacheKey = `user:profile:${req.user.id}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log('캐시 HIT', req.user.id);
      return res.json({ success: true, user: JSON.parse(cached) });
    }

      onsole.log('캐시 MISS', req.user.id);
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }
    const userProfile = {
      id: user._id,
      name: user.name,
      email: user.email,
      profileImage: user.profileImage
    };
    await redisClient.setEx(cacheKey, USER_PROFILE_TTL, JSON.stringify(userProfile));
    res.json({ success: true, user: userProfile });
  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 조회 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 닉네임 업데이트
exports.updateProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name || name.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: '이름을 입력해주세요.'
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    user.name = name.trim();
    await user.save();

    // 캐시 무효화 및 최신 정보로 갱신
    const cacheKey = `user:profile:${req.user.id}`;
    const userProfile = {
      id: user._id,
      name: user.name,
      email: user.email,
      profileImage: user.profileImage
    };
    await redisClient.setEx(cacheKey, USER_PROFILE_TTL, JSON.stringify(userProfile));

    // mention:users 캐시 무효화
    await redisClient.del('mention:users');

    res.json({
      success: true,
      message: '프로필이 업데이트되었습니다.',
      user: userProfile
    });

  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 업데이트 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 비밀번호 변경
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // 1. 필드 유효성 검사
    if (!currentPassword || !newPassword || currentPassword.trim().length === 0 || newPassword.trim().length === 0) {
      return res.status(400).json({
        success: false,
        message: '현재 비밀번호와 새 비밀번호를 모두 입력해주세요.'
      });
    }

    // 2. 사용자 조회
    const user = await User.findById(req.user.id).select('+password');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 3. 현재 비밀번호 확인
    const isMatch = await user.matchPassword(currentPassword);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: '현재 비밀번호가 일치하지 않습니다.'
      });
    }

    // 4. 새 비밀번호 저장
    user.password = newPassword;
    await user.save();

    return res.json({
      success: true,
      message: '비밀번호가 성공적으로 변경되었습니다.'
    });

  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({
      success: false,
      message: '비밀번호 변경 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 이미지 업로드
exports.uploadProfileImage = async (req, res) => {
  const AWS = require('aws-sdk');
  const s3 = new AWS.S3();
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: '이미지가 제공되지 않았습니다.'
      });
    }

    // 파일 유효성 검사
    const fileSize = req.file.size;
    const fileType = req.file.mimetype;
    const maxSize = 5 * 1024 * 1024; // 5MB

    if (fileSize > maxSize) {
      // S3에서 업로드된 파일 삭제
      if (req.file.key) {
        await s3.deleteObject({ Bucket: process.env.AWS_S3_BUCKET, Key: req.file.key }).promise();
      }
      return res.status(400).json({
        success: false,
        message: '파일 크기는 5MB를 초과할 수 없습니다.'
      });
    }

    if (!fileType.startsWith('image/')) {
      // S3에서 업로드된 파일 삭제
      if (req.file.key) {
        await s3.deleteObject({ Bucket: process.env.AWS_S3_BUCKET, Key: req.file.key }).promise();
      }
      return res.status(400).json({
        success: false,
        message: '이미지 파일만 업로드할 수 있습니다.'
      });
    }

    const user = await User.findById(req.user.id);
    if (!user) {
      // S3에서 업로드된 파일 삭제
      if (req.file.key) {
        await s3.deleteObject({ Bucket: process.env.AWS_S3_BUCKET, Key: req.file.key }).promise();
      }
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 기존 프로필 이미지가 있다면 S3에서 삭제
    if (user.profileImage && user.profileImageKey) {
      try {
        await s3.deleteObject({ Bucket: process.env.AWS_S3_BUCKET, Key: user.profileImageKey }).promise();
      } catch (error) {
        console.error('Old profile image delete error (S3):', error);
      }
    }

    // 새 이미지 S3 정보 저장
    user.profileImage = req.file.location; // S3 URL
    user.profileImageKey = req.file.key;   // S3 Key
    await user.save();

    // 캐시 무효화
    const cacheKey = `user:profile:${req.user.id}`;
    await redisClient.del(cacheKey);

    res.json({
      success: true,
      message: '프로필 이미지가 업데이트되었습니다.',
      imageUrl: user.profileImage
    });

  } catch (error) {
    console.error('Profile image upload error:', error);
    // 업로드 실패 시 S3에서 파일 삭제
    if (req.file && req.file.key) {
      try {
        const AWS = require('aws-sdk');
        const s3 = new AWS.S3();
        await s3.deleteObject({ Bucket: process.env.AWS_S3_BUCKET, Key: req.file.key }).promise();
      } catch (unlinkError) {
        console.error('S3 file delete error:', unlinkError);
      }
    }
    res.status(500).json({
      success: false,
      message: '이미지 업로드 중 오류가 발생했습니다.'
    });
  }
};

// 프로필 이미지 삭제
exports.deleteProfileImage = async (req, res) => {
  const AWS = require('aws-sdk');
  const s3 = new AWS.S3();
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    if (user.profileImage && user.profileImageKey) {
      try {
        await s3.deleteObject({ Bucket: process.env.AWS_S3_BUCKET, Key: user.profileImageKey }).promise();
      } catch (error) {
        console.error('Profile image delete error (S3):', error);
      }
      user.profileImage = '';
      user.profileImageKey = '';
      await user.save();
    }

    // 캐시 무효화
    const cacheKey = `user:profile:${req.user.id}`;
    await redisClient.del(cacheKey);

    res.json({
      success: true,
      message: '프로필 이미지가 삭제되었습니다.'
    });

  } catch (error) {
    console.error('Delete profile image error:', error);
    res.status(500).json({
      success: false,
      message: '프로필 이미지 삭제 중 오류가 발생했습니다.'
    });
  }
};

// 회원 탈퇴
exports.deleteAccount = async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: '사용자를 찾을 수 없습니다.'
      });
    }

    // 프로필 이미지가 있다면 S3에서 삭제
    if (user.profileImage && user.profileImageKey) {
      try {
        const AWS = require('aws-sdk');
        const s3 = new AWS.S3();
        await s3.deleteObject({ Bucket: process.env.AWS_S3_BUCKET, Key: user.profileImageKey }).promise();
      } catch (error) {
        console.error('Profile image delete error (S3):', error);
      }
    }

    await user.deleteOne();

    // 캐시 무효화
    const cacheKey = `user:profile:${req.user.id}`;
    await redisClient.del(cacheKey);
    // mention:users 캐시 무효화
    await redisClient.del('mention:users');

    res.json({
      success: true,
      message: '회원 탈퇴가 완료되었습니다.'
    });

  } catch (error) {
    console.error('Delete account error:', error);
    res.status(500).json({
      success: false,
      message: '회원 탈퇴 처리 중 오류가 발생했습니다.'
    });
  }
};

module.exports = exports;