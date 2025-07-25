const express = require('express');
const router = express.Router();
const auth = require('../../middleware/auth');
const Room = require('../../models/Room');
const User = require('../../models/User');
const { rateLimit } = require('express-rate-limit');
const redisClient = require('../../utils/redisClient');
let io;
const ROOM_LIST_TTL = 24 * 60 * 60; // 24 hours

// 속도 제한 설정
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1분
  max: 60, // IP당 최대 요청 수
  message: {
    success: false,
    error: {
      message: '너무 많은 요청이 발생했습니다. 잠시 후 다시 시도해주세요.',
      code: 'TOO_MANY_REQUESTS'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Socket.IO 초기화 함수
const initializeSocket = (socketIO) => {
  io = socketIO;
};

// Utility function to add a cache key to the set
async function addRoomListCacheKey(key) {
  try {
    await redisClient.setOps.sadd('room:list:{all}:keys', key);
  } catch (err) {
    console.error('Failed to add cache key to set:', err);
  }
}

// Utility function to invalidate all room list cache keys
async function invalidateRoomListCache() {
  try {
    const keys = await redisClient.setOps.smembers('room:list:{all}:keys');
    if (keys && keys.length > 0) {
      await redisClient.del(...keys);
      await redisClient.del('room:list:{all}:keys');
    }
  } catch (err) {
    console.error('Failed to invalidate room list cache:', err);
  }
}

// 서버 상태 확인
router.get('/health', async (req, res) => {
  try {
    const isMongoConnected = require('mongoose').connection.readyState === 1;
    const recentRoom = await Room.findOne()
      .sort({ createdAt: -1 })
      .select('createdAt')
      .lean();

    const start = process.hrtime();
    await Room.findOne().select('_id').lean();
    const [seconds, nanoseconds] = process.hrtime(start);
    const latency = Math.round((seconds * 1000) + (nanoseconds / 1000000));

    const status = {
      success: true,
      timestamp: new Date().toISOString(),
      services: {
        database: {
          connected: isMongoConnected,
          latency
        }
      },
      lastActivity: recentRoom?.createdAt
    };

    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.status(isMongoConnected ? 200 : 503).json(status);

  } catch (error) {
    console.error('Health check error:', error);
    res.status(503).json({
      success: false,
      error: {
        message: '서비스 상태 확인에 실패했습니다.',
        code: 'HEALTH_CHECK_FAILED'
      }
    });
  }
});

// 채팅방 목록 조회 (페이징 적용)
router.get('/', [limiter, auth], async (req, res) => {
  try {
    // 쿼리 파라미터 검증 (페이지네이션)
    const page = Math.max(0, parseInt(req.query.page) || 0);
    const pageSize = Math.min(Math.max(1, parseInt(req.query.pageSize) || 10), 50);
    const skip = page * pageSize;

    // 정렬 설정
    const allowedSortFields = ['createdAt', 'name', 'participantsCount'];
    const sortField = allowedSortFields.includes(req.query.sortField) 
      ? req.query.sortField 
      : 'createdAt';
    const sortOrder = ['asc', 'desc'].includes(req.query.sortOrder)
      ? req.query.sortOrder
      : 'desc';

    // 검색 필터 구성
    const filter = {};
    if (req.query.search) {
      filter.name = { $regex: req.query.search, $options: 'i' };
    }

    // 로드 테스트 최적화: 총 문서 수와 데이터를 한 번에 조회하여 쿼리 수 줄이기
    const [totalCount, rooms] = await Promise.all([
      Room.countDocuments(filter),
      Room.aggregate([
        { $match: filter },
        {
          $lookup: {
            from: 'users',
            localField: 'creator',
            foreignField: '_id',
            as: 'creator',
            pipeline: [{ $project: { name: 1, email: 1, profileImage: 1 } }]
          }
        },
        {
          $addFields: {
            creator: { $arrayElemAt: ['$creator', 0] },
            participantsCount: { $size: '$participants' }
          }
        },
        { $sort: { [sortField]: sortOrder === 'desc' ? -1 : 1 } },
        { $skip: skip },
        { $limit: pageSize },
        {
          $project: {
            name: 1,
            creator: 1,
            createdAt: 1,
            hasPassword: 1,
            participantsCount: 1
          }
        }
      ])
    ]);

    // 안전한 응답 데이터 구성 - Aggregation 결과 사용
    const safeRooms = rooms.map(room => {
      if (!room) return null;

      const creator = room.creator || { _id: 'unknown', name: '알 수 없음', email: '' };

      return {
        _id: room._id?.toString() || 'unknown',
        name: room.name || '제목 없음',
        hasPassword: !!room.hasPassword,
        creator: {
          _id: creator._id?.toString() || 'unknown',
          name: creator.name || '알 수 없음',
          email: creator.email || ''
        },
        participantsCount: room.participantsCount || 0,
        createdAt: room.createdAt || new Date(),
        isCreator: creator._id?.toString() === req.user.id,
      };
    }).filter(room => room !== null);

    // 메타데이터 계산    
    const totalPages = Math.ceil(totalCount / pageSize);
    const hasMore = skip + rooms.length < totalCount;

    const cacheKey = `room:list:${page}:${pageSize}:${sortField}:${sortOrder}:${req.query.search || ''}`;
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      console.log('캐시 HIT', cacheKey);
      res.set({
        'Cache-Control': 'private, max-age=10',
        'Last-Modified': new Date().toUTCString()
      });
      return res.json(cached);
    }

    console.log('캐시 MISS', cacheKey);
    console.log('Returning rooms:', safeRooms.length, 'total in DB:', totalCount);
    
    const response = {
      success: true,
      data: safeRooms,
      metadata: {
        total: totalCount,
        page,
        pageSize,
        totalPages,
        hasMore,
        currentCount: safeRooms.length,
        sort: {
          field: sortField,
          order: sortOrder
        }
      }
    };
    await redisClient.setEx(cacheKey, ROOM_LIST_TTL, JSON.stringify(response));
    res.set({
      'Cache-Control': 'private, max-age=10',
      'Last-Modified': new Date().toUTCString()
    });
    res.json(response);

  } catch (error) {
    console.error('방 목록 조회 에러:', error);
    const errorResponse = {
      success: false,
      error: {
        message: '채팅방 목록을 불러오는데 실패했습니다.',
        code: 'ROOMS_FETCH_ERROR'
      }
    };

    if (process.env.NODE_ENV === 'development') {
      errorResponse.error.details = error.message;
      errorResponse.error.stack = error.stack;
    }

    res.status(500).json(errorResponse);
  }
});

// 채팅방 생성
router.post('/', auth, async (req, res) => {
  try {
    const { name, password } = req.body;
    
    if (!name?.trim()) {
      return res.status(400).json({ 
        success: false,
        message: '방 이름은 필수입니다.' 
      });
    }

    const newRoom = new Room({
      name: name.trim(),
      creator: req.user.id,
      participants: [req.user.id],
      password: password
    });

    const savedRoom = await newRoom.save();
    console.log('Room saved to MongoDB:', savedRoom._id, savedRoom.name);
    
    const populatedRoom = await Room.findById(savedRoom._id)
      .populate('creator', 'name email')
      .populate('participants', 'name email');
    console.log('Room populated successfully:', populatedRoom._id);
    
    // roomList 캐시 무효화 (cluster-safe)
    await invalidateRoomListCache();
    
    // Socket.IO를 통해 새 채팅방 생성 알림
    if (io) {
      io.to('room-list').emit('roomCreated', {
        ...populatedRoom.toObject(),
        password: undefined
      });
    }
    
    res.status(201).json({
      success: true,
      data: {
        ...populatedRoom.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 생성 에러:', error);
    res.status(500).json({ 
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message 
    });
  }
});

// 특정 채팅방 조회
router.get('/:roomId', auth, async (req, res) => {
  try {
    const room = await Room.findById(req.params.roomId)
      .populate('creator', 'name email')
      .populate('participants', 'name email');

    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    res.json({
      success: true,
      data: {
        ...room.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('Room fetch error:', error);
    res.status(500).json({
      success: false,
      message: '채팅방 정보를 불러오는데 실패했습니다.'
    });
  }
});

// 채팅방 입장
router.post('/:roomId/join', auth, async (req, res) => {
  try {
    const { password } = req.body;
    const room = await Room.findById(req.params.roomId).select('+password');
    
    if (!room) {
      return res.status(404).json({
        success: false,
        message: '채팅방을 찾을 수 없습니다.'
      });
    }

    // 비밀번호 확인
    if (room.hasPassword) {
      const isPasswordValid = await room.checkPassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          message: '비밀번호가 일치하지 않습니다.'
        });
      }
    }

    // 참여자 목록에 추가
    if (!room.participants.includes(req.user.id)) {
      room.participants.push(req.user.id);
      await room.save();
      // roomList 캐시 무효화 (cluster-safe)
      await invalidateRoomListCache();
    }

    const populatedRoom = await room.populate('participants', 'name email');

    // Socket.IO를 통해 참여자 업데이트 알림
    if (io) {
      io.to(req.params.roomId).emit('roomUpdate', {
        ...populatedRoom.toObject(),
        password: undefined
      });
    }

    res.json({
      success: true,
      data: {
        ...populatedRoom.toObject(),
        password: undefined
      }
    });
  } catch (error) {
    console.error('방 입장 에러:', error);
    res.status(500).json({
      success: false,
      message: '서버 에러가 발생했습니다.',
      error: error.message
    });
  }
});

module.exports = {
  router,
  initializeSocket
};