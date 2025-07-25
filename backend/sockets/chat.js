const Message = require('../models/Message');
const Room = require('../models/Room');
const User = require('../models/User');
const File = require('../models/File');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config/keys');
const redisClient = require('../utils/redisClient');
const SessionService = require('../services/sessionService');
const aiService = require('../services/aiService');
const MESSAGES_TTL = 24 * 60 * 60; // 24 hours

const RECENT_MESSAGE_CACHE = 50;
const CHAT_MESSAGE_TTL = 24 * 60 * 60; // 24 hours
// Pub/Sub removed for load testing optimization

module.exports = function(io) {
  const BATCH_SIZE = 30;  // 한 번에 로드할 메시지 수
  const LOAD_DELAY = 300; // 메시지 로드 딜레이 (ms)
  const MAX_RETRIES = 3;  // 최대 재시도 횟수
  const MESSAGE_LOAD_TIMEOUT = 10000; // 메시지 로드 타임아웃 (10초)
  const RETRY_DELAY = 2000; // 재시도 간격 (2초)
  const DUPLICATE_LOGIN_TIMEOUT = 10000; // 중복 로그인 타임아웃 (10초)

  // 로깅 유틸리티 함수
  const logDebug = (action, data) => {
    console.debug(`[Socket.IO] ${action}:`, {
      ...data,
      timestamp: new Date().toISOString()
    });
  };

  // 로드 테스트 최적화: 캐싱 + Aggregation Pipeline을 사용한 메시지 로드 함수
  const loadMessages = async (socket, roomId, before, limit = BATCH_SIZE) => {
    let timeoutId; // Declare a variable to hold the timeout ID
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => { // Assign the ID here
        reject(new Error('Message loading timed out'));
      }, MESSAGE_LOAD_TIMEOUT);
    });

    try {
      // 캐시 체크 (최근 메시지만)
      let cachedMessages = [];
      if (!before) {
        cachedMessages = await redisClient.get(`room:messages:${roomId}`) || [];
        if (cachedMessages.length > 0) {
          console.log('캐시 HIT', roomId, cachedMessages.length);
          clearTimeout(timeoutId);
          const sortedMessages = cachedMessages.length > limit
          ? cachedMessages.slice(-limit)
          : cachedMessages;
          return {
            messages: sortedMessages,
            hasMore: cachedMessages.length > limit,
            oldestTimestamp: sortedMessages[0]?.timestamp || null
          };
        }
        console.log('캐시 MISS', roomId, cachedMessages.length);
      }

      // Aggregation Pipeline을 사용하여 쿼리 최적화
      const matchStage = {
        room: roomId,
        isDeleted: false
      };
      
      if (before) {
        matchStage.timestamp = { $lt: new Date(before) };
        console.log(`[DEBUG] Loading previous messages for room ${roomId} before ${before}`);
      } else {
        console.log(`[DEBUG] Loading initial messages for room ${roomId} (no 'before' timestamp)`);
      }

      console.time(`MongoDB Aggregation for Room ${roomId} (before: ${before})`);
      // 단일 Aggregation Pipeline으로 모든 작업 처리
      const messages = await Promise.race([
        Message.aggregate([
          // 1. 기본 필터링 (인덱스 사용: room + timestamp + isDeleted)
          { $match: matchStage },
          
          // 2. 정렬 및 제한 (인덱스 사용)
          { $sort: { timestamp: -1 } },
          { $limit: limit + 1 },
          
          // 3. User 정보 조인 (프로젝션으로 필요한 필드만)
          {
            $lookup: {
              from: 'users',
              localField: 'sender',
              foreignField: '_id',
              as: 'sender',
              pipeline: [
                { $project: { name: 1, email: 1, profileImage: 1 } }
              ]
            }
          },
          
          // 4. File 정보 조인 (조건부)
          {
            $lookup: {
              from: 'files',
              localField: 'file',
              foreignField: '_id',
              as: 'file',
              pipeline: [
                { $project: { filename: 1, originalname: 1, mimetype: 1, size: 1 } }
              ]
            }
          },
          
          // 5. Readers 정보 조인 (읽음 상태)
          {
            $lookup: {
              from: 'users',
              localField: 'readers.userId',
              foreignField: '_id',
              as: 'readersData',
              pipeline: [
                { $project: { name: 1, email: 1 } }
              ]
            }
          },
          
          // 6. 배열 필드 단일 객체로 변환
          {
            $addFields: {
              sender: { $arrayElemAt: ['$sender', 0] },
              file: { $arrayElemAt: ['$file', 0] }
            }
          },
          
          // 7. 불필요한 필드 제거
          {
            $project: {
              __v: 0,
              updatedAt: 0,
              isDeleted: 0
            }
          }
        ]),
        timeoutPromise
      ]);
      console.timeEnd(`MongoDB Aggregation for Room ${roomId} (before: ${before})`);

      // timeoutPromise 가 먼저 완료되면 messages 는 Error 객체가 됨
      if (messages instanceof Error) {
        throw messages;
      }

      // Result processing
      const hasMore = messages.length > limit;
      const resultMessages = messages.slice(0, limit);
      const sortedMessages = resultMessages.sort((a, b) => 
        new Date(a.timestamp) - new Date(b.timestamp)
      );

      // 로드 테스트 최적화: 대량 읽음 상태 업데이트
      if (sortedMessages.length > 0 && socket.user) {
        const messageIds = sortedMessages.map(msg => msg._id);
        
        // bulkWrite를 사용하여 성능 최적화
        const bulkOps = messageIds.map(messageId => ({
          updateOne: {
            filter: {
              _id: messageId,
              'readers.userId': { $ne: socket.user.id }
            },
            update: {
              $push: {
                readers: {
                  userId: socket.user.id,
                  readAt: new Date()
                }
              }
            }
          }
        }));

        // 비동기로 대량 업데이트 실행 (응답 속도에 영향 없음)
        Message.bulkWrite(bulkOps, { ordered: false })
          .catch(error => {
            console.error('Bulk read status update error:', error);
          });
      }

      if (!before && messages.length > 0) {
        // Cache the most recent messages
        await redisClient.setEx(`room:messages:${roomId}`, CHAT_MESSAGE_TTL, JSON.stringify(messages.slice(0, RECENT_MESSAGE_CACHE)));
      }

      return {
        messages: sortedMessages,
        hasMore,
        oldestTimestamp: sortedMessages[0]?.timestamp || null
      };
    } catch (error) {
      if (error.message === 'Message loading timed out') {
        logDebug('message load timeout', {
          roomId,
          before,
          limit,
          timeout: MESSAGE_LOAD_TIMEOUT
        });
      } else {
        console.error('Load messages error:', {
          error: error.message,
          stack: error.stack,
          roomId,
          before,
          limit
        });
      }
      throw error;
    } finally {
        // Ensure the timeout is always cleared, regardless of success or error
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
  };

  // 재시도 로직을 포함한 메시지 로드 함수
  const loadMessagesWithRetry = async (socket, roomId, before, retryCount = 0) => {
    const retryKey = `${roomId}:${socket.user.id}`;
    
    try {
      // [Redis Migration] 재시도 횟수 체크 (Redis)
      const retryCountValue = await redisClient.get('messageLoadRetry:' + retryKey);
      if (Number(retryCountValue) >= MAX_RETRIES) {
        throw new Error('최대 재시도 횟수를 초과했습니다.');
      }

      const result = await loadMessages(socket, roomId, before);
      // [Redis Migration] 재시도 횟수 삭제 (Redis)
      await redisClient.del('messageLoadRetry:' + retryKey);
      return result;

    } catch (error) {
      // [Redis Migration] 재시도 횟수 증가 (Redis)
      const currentRetries = Number(await redisClient.get('messageLoadRetry:' + retryKey)) || 0;
      if (currentRetries < MAX_RETRIES) {
        await redisClient.set('messageLoadRetry:' + retryKey, currentRetries + 1, { ttl: 60 });
        const delay = Math.min(RETRY_DELAY * Math.pow(2, currentRetries), 10000);
        
        logDebug('retrying message load', {
          roomId,
          retryCount: currentRetries + 1,
          delay
        });

        await new Promise(resolve => setTimeout(resolve, delay));
        return loadMessagesWithRetry(socket, roomId, before, currentRetries + 1);
      }

      await redisClient.del('messageLoadRetry:' + retryKey);
      throw error;
    }
  };

  // 중복 로그인 처리 함수
  const handleDuplicateLogin = async (existingSocket, newSocket) => {
    try {
      // 기존 연결에 중복 로그인 알림
      existingSocket.emit('duplicate_login', {
        type: 'new_login_attempt',
        deviceInfo: newSocket.handshake.headers['user-agent'],
        ipAddress: newSocket.handshake.address,
        timestamp: Date.now()
      });

      // 타임아웃 설정
      return new Promise((resolve) => {
        setTimeout(async () => {
          try {
            // 기존 세션 종료
            existingSocket.emit('session_ended', {
              reason: 'duplicate_login',
              message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
            });

            // 기존 연결 종료
            existingSocket.disconnect(true);
            resolve();
          } catch (error) {
            console.error('Error during session termination:', error);
            resolve();
          }
        }, DUPLICATE_LOGIN_TIMEOUT);
      });
    } catch (error) {
      console.error('Duplicate login handling error:', error);
      throw error;
    }
  };

  // 미들웨어: 소켓 연결 시 인증 처리
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const sessionId = socket.handshake.auth.sessionId;

      if (!token || !sessionId) {
        return next(new Error('Authentication error'));
      }

      const decoded = jwt.verify(token, jwtSecret);
      if (!decoded?.user?.id) {
        return next(new Error('Invalid token'));
      }

      // [Redis Migration] 이미 연결된 사용자인지 확인 (Redis)
      const existingSocketId = await redisClient.get('connectedUser:' + decoded.user.id);
      if (existingSocketId) {
        const existingSocket = io.sockets.sockets.get(existingSocketId);
        if (existingSocket) {
          // 중복 로그인 처리
          await handleDuplicateLogin(existingSocket, socket);
        }
      }

      const validationResult = await SessionService.validateSession(decoded.user.id, sessionId);
      if (!validationResult.isValid) {
        console.error('Session validation failed:', validationResult);
        return next(new Error(validationResult.message || 'Invalid session'));
      }

      const user = await User.findById(decoded.user.id);
      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        sessionId: sessionId,
        profileImage: user.profileImage
      };

      await SessionService.updateLastActivity(decoded.user.id);
      next();

    } catch (error) {
      console.error('Socket authentication error:', error);
      
      if (error.name === 'TokenExpiredError') {
        return next(new Error('Token expired'));
      }
      
      if (error.name === 'JsonWebTokenError') {
        return next(new Error('Invalid token'));
      }
      
      next(new Error('Authentication failed'));
    }
  });
  
  io.on('connection', (socket) => {
    logDebug('socket connected', {
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name
    });

    if (socket.user) {
      // [Redis Migration] 이전 연결이 있는지 확인 (Redis)
      (async () => {
        const previousSocketId = await redisClient.get('connectedUser:' + socket.user.id);
        if (previousSocketId && previousSocketId !== socket.id) {
          const previousSocket = io.sockets.sockets.get(previousSocketId);
          if (previousSocket) {
            // 이전 연결에 중복 로그인 알림
            previousSocket.emit('duplicate_login', {
              type: 'new_login_attempt',
              deviceInfo: socket.handshake.headers['user-agent'],
              ipAddress: socket.handshake.address,
              timestamp: Date.now()
            });

            // 이전 연결 종료 처리
            setTimeout(() => {
              previousSocket.emit('session_ended', {
                reason: 'duplicate_login',
                message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
              });
              previousSocket.disconnect(true);
            }, DUPLICATE_LOGIN_TIMEOUT);
          }
        }
        // [Redis Migration] 새로운 연결 정보 저장 (Redis)
        await redisClient.set('connectedUser:' + socket.user.id, socket.id);
      })();
    }

    // 이전 메시지 로딩 처리 개선
    socket.on('fetchPreviousMessages', async ({ roomId, before }) => {
      const queueKey = `${roomId}:${socket.user.id}`;

      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // 권한 체크
        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id
        });

        if (!room) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        // [Redis Migration] 메시지 큐 중복 체크 (Redis)
        const isLoading = await redisClient.get('messageQueue:' + queueKey);
        if (isLoading) {
          logDebug('message load skipped - already loading', {
            roomId,
            userId: socket.user.id
          });
          return;
        }

        // [Redis Migration] 메시지 큐 등록 (Redis)
        await redisClient.set('messageQueue:' + queueKey, 'true', { ttl: Math.ceil(LOAD_DELAY / 1000) });
        socket.emit('messageLoadStart');

        const result = await loadMessagesWithRetry(socket, roomId, before);
        
        logDebug('previous messages loaded', {
          roomId,
          messageCount: result.messages.length,
          hasMore: result.hasMore,
          oldestTimestamp: result.oldestTimestamp
        });

        socket.emit('previousMessagesLoaded', result);

      } catch (error) {
        console.error('Fetch previous messages error:', error);
        socket.emit('error', {
          type: 'LOAD_ERROR',
          message: error.message || '이전 메시지를 불러오는 중 오류가 발생했습니다.'
        });
      } finally {
        // [Redis Migration] 메시지 큐 해제 (Redis)
        setTimeout(async () => {
          await redisClient.del('messageQueue:' + queueKey);
        }, LOAD_DELAY);
      }
    });
    
    // 채팅방 입장 처리 개선
    socket.on('joinRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // [Redis Migration] 이미 해당 방에 참여 중인지 확인 (Redis)
        const currentRoom = await redisClient.get('userRoom:' + socket.user.id);
        if (currentRoom === roomId) {
          logDebug('already in room', {
            userId: socket.user.id,
            roomId
          });
          socket.emit('joinRoomSuccess', { roomId });
          return;
        }

        // [Redis Migration] 기존 방에서 나가기 (Redis)
        if (currentRoom) {
          logDebug('leaving current room', { 
            userId: socket.user.id, 
            roomId: currentRoom 
          });
          socket.leave(currentRoom);
          await redisClient.del('userRoom:' + socket.user.id);
          
          socket.to(currentRoom).emit('userLeft', {
            userId: socket.user.id,
            name: socket.user.name
          });
        }

        // 채팅방 참가 with profileImage
        const room = await Room.findByIdAndUpdate(
          roomId,
          { $addToSet: { participants: socket.user.id } },
          { 
            new: true,
            runValidators: true 
          }
        ).populate('participants', 'name email profileImage');

        if (!room) {
          throw new Error('채팅방을 찾을 수 없습니다.');
        }

        socket.join(roomId);
        console.log(`User ${socket.user.id} (${socket.user.name}) joined Socket.IO room ${roomId}`);
        // [Redis Migration] 새로운 방 정보 저장 (Redis)
        await redisClient.set('userRoom:' + socket.user.id, roomId);

        // 입장 메시지 생성
        const joinMessage = new Message({
          room: roomId,
          content: `${socket.user.name}님이 입장하였습니다.`,
          type: 'system',
          timestamp: new Date()
        });
        
        await joinMessage.save();

        // 초기 메시지 로드
        const messageLoadResult = await loadMessages(socket, roomId);
        const { messages, hasMore, oldestTimestamp } = messageLoadResult;

        // 이벤트 발송
        socket.emit('joinRoomSuccess', {
          roomId,
          participants: room.participants,
          messages,
          hasMore,
          oldestTimestamp
        });

        io.to(roomId).emit('message', joinMessage);
        io.to(roomId).emit('participantsUpdate', room.participants);

        logDebug('user joined room', {
          userId: socket.user.id,
          roomId,
          messageCount: messages.length,
          hasMore
        });

      } catch (error) {
        console.error('Join room error:', error);
        socket.emit('joinRoomError', {
          message: error.message || '채팅방 입장에 실패했습니다.'
        });
      }
    });
    
    // 메시지 전송 처리
    socket.on('chatMessage', async (messageData) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!messageData) {
          throw new Error('메시지 데이터가 없습니다.');
        }

        const { room, type, content, fileData } = messageData;

        if (!room) {
          throw new Error('채팅방 정보가 없습니다.');
        }

        // 채팅방 권한 확인
        const chatRoom = await Room.findOne({
          _id: room,
          participants: socket.user.id
        });

        if (!chatRoom) {
          throw new Error('채팅방 접근 권한이 없습니다.');
        }

        // 세션 유효성 재확인
        const sessionValidation = await SessionService.validateSession(
          socket.user.id, 
          socket.user.sessionId
        );
        
        if (!sessionValidation.isValid) {
          throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
        }

        // AI 멘션 확인
        const aiMentions = extractAIMentions(content);
        let message;

        logDebug('message received', {
          type,
          room,
          userId: socket.user.id,
          hasFileData: !!fileData,
          hasAIMentions: aiMentions.length
        });

        // 메시지 타입별 처리
        switch (type) {
          case 'file':
            if (!fileData || !fileData._id) {
              throw new Error('파일 데이터가 올바르지 않습니다.');
            }

            const file = await File.findOne({
              _id: fileData._id,
              user: socket.user.id
            });

            if (!file) {
              throw new Error('파일을 찾을 수 없거나 접근 권한이 없습니다.');
            }

            message = new Message({
              room,
              sender: socket.user.id,
              type: 'file',
              file: file._id,
              content: content || '',
              timestamp: new Date(),
              reactions: {},
              metadata: {
                fileType: file.mimetype,
                fileSize: file.size,
                originalName: file.originalname
              }
            });
            break;

          case 'text':
            const messageContent = content?.trim() || messageData.msg?.trim();
            if (!messageContent) {
              return;
            }

            message = new Message({
              room,
              sender: socket.user.id,
              content: messageContent,
              type: 'text',
              timestamp: new Date(),
              reactions: {}
            });
            break;

          default:
            throw new Error('지원하지 않는 메시지 타입입니다.');
        }

        // 메시지 저장 및 populate를 한 번에 처리하여 성능 최적화
        const savedMessage = await message.save();
        
        // Aggregation을 사용하여 populate 최적화
        const populatedMessage = await Message.aggregate([
          { $match: { _id: savedMessage._id } },
          {
            $lookup: {
              from: 'users',
              localField: 'sender',
              foreignField: '_id',
              as: 'sender',
              pipeline: [{ $project: { name: 1, email: 1, profileImage: 1 } }]
            }
          },
          {
            $lookup: {
              from: 'files',
              localField: 'file',
              foreignField: '_id',
              as: 'file',
              pipeline: [{ $project: { filename: 1, originalname: 1, mimetype: 1, size: 1 } }]
            }
          },
          {
            $lookup: {
              from: 'users',
              localField: 'readers.userId',
              foreignField: '_id',
              as: 'readersData',
              pipeline: [{ $project: { name: 1, email: 1 } }]
            }
          },
          {
            $addFields: {
              sender: { $arrayElemAt: ['$sender', 0] },
              file: { $arrayElemAt: ['$file', 0] }
            }
          }
        ]);

        message = populatedMessage[0] || savedMessage;

        // Update Redis cache for recent messages (팀원의 캐싱 최적화 유지)
        const cacheKey = `room:messages:${room}`;
        let cached = await redisClient.get(cacheKey) || [];
        cached.push(message.toObject ? message.toObject() : message);
        if (cached.length > RECENT_MESSAGE_CACHE) cached = cached.slice(-RECENT_MESSAGE_CACHE);
        await redisClient.setEx(cacheKey, MESSAGES_TTL, JSON.stringify(cached));

        // Direct socket emission - pub/sub removed for load testing
        console.log(`Broadcasting message to room ${room}, connected sockets:`, io.sockets.adapter.rooms.get(room)?.size || 0);
        io.to(room).emit('message', message);

        // AI 멘션이 있는 경우 AI 응답 생성
        if (aiMentions.length > 0) {
          for (const ai of aiMentions) {
            const query = content.replace(new RegExp(`@${ai}\\b`, 'g'), '').trim();
            await handleAIResponse(io, room, ai, query);
          }
        }

        await SessionService.updateLastActivity(socket.user.id);

        logDebug('message processed', {
          messageId: message._id,
          type: message.type,
          room
        });

      } catch (error) {
        console.error('Message handling error:', error);
        socket.emit('error', {
          code: error.code || 'MESSAGE_ERROR',
          message: error.message || '메시지 전송 중 오류가 발생했습니다.'
        });
      }
    });

    // 채팅방 퇴장 처리
    socket.on('leaveRoom', async (roomId) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        // [Redis Migration] 실제로 해당 방에 참여 중인지 먼저 확인 (Redis)
        const currentRoom = await redisClient.get('userRoom:' + socket.user.id);
        if (!currentRoom || currentRoom !== roomId) {
          console.log(`User ${socket.user.id} is not in room ${roomId}`);
          return;
        }

        // 권한 확인
        const room = await Room.findOne({
          _id: roomId,
          participants: socket.user.id
        }).select('participants').lean();

        if (!room) {
          console.log(`Room ${roomId} not found or user has no access`);
          return;
        }

        socket.leave(roomId);
        // [Redis Migration] 방 정보 삭제 (Redis)
        await redisClient.del('userRoom:' + socket.user.id);

        // 퇴장 메시지 생성 및 저장
        const leaveMessage = await Message.create({
          room: roomId,
          content: `${socket.user.name}님이 퇴장하였습니다.`,
          type: 'system',
          timestamp: new Date()
        });

        // 참가자 목록 업데이트 - profileImage 포함
        const updatedRoom = await Room.findByIdAndUpdate(
          roomId,
          { $pull: { participants: socket.user.id } },
          { 
            new: true,
            runValidators: true
          }
        ).populate('participants', 'name email profileImage');

        // roomList 캐시 무효화
        const keys = await redisClient.keys('room:list:*');
        if (keys.length > 0) {
          await redisClient.del(keys);
        }

        if (!updatedRoom) {
          console.log(`Room ${roomId} not found during update`);
          return;
        }

        // 메시지 큐 정리
        const queueKey = `${roomId}:${socket.user.id}`;
        // messageQueues.delete(queueKey); // [Redis Migration] 기존 Map은 주석처리, Redis로 대체
        // messageLoadRetries.delete(queueKey); // [Redis Migration] 기존 Map은 주석처리, Redis로 대체

        // 이벤트 발송
        io.to(roomId).emit('message', leaveMessage);
        io.to(roomId).emit('participantsUpdate', updatedRoom.participants);

        console.log(`User ${socket.user.id} left room ${roomId} successfully`);

      } catch (error) {
        console.error('Leave room error:', error);
        socket.emit('error', {
          message: error.message || '채팅방 퇴장 중 오류가 발생했습니다.'
        });
      }
    });
    
    // 연결 해제 처리
    socket.on('disconnect', async (reason) => {
      if (!socket.user) return;

      try {
        // [Redis Migration] 해당 사용자의 현재 활성 연결인 경우에만 정리 (Redis)
        const redisSocketId = await redisClient.get('connectedUser:' + socket.user.id);
        if (redisSocketId === socket.id) {
          await redisClient.del('connectedUser:' + socket.user.id);
        }

        // [Redis Migration] 방 정보 삭제 (Redis)
        const roomId = await redisClient.get('userRoom:' + socket.user.id);
        await redisClient.del('userRoom:' + socket.user.id);

        // 메시지 큐 정리
        const userQueues = (await redisClient.keys('messageQueue:*:' + socket.user.id)) || [];
        for (const key of userQueues) {
          await redisClient.del(key);
          const retryKey = key.replace('messageQueue:', 'messageLoadRetry:');
          await redisClient.del(retryKey);
        }
    

        // 현재 방에서 자동 퇴장 처리
        if (roomId) {
          // 다른 디바이스로 인한 연결 종료가 아닌 경우에만 처리
          if (reason !== 'client namespace disconnect' && reason !== 'duplicate_login') {
            const leaveMessage = await Message.create({
              room: roomId,
              content: `${socket.user.name}님이 연결이 끊어졌습니다.`,
              type: 'system',
              timestamp: new Date()
            });

            const updatedRoom = await Room.findByIdAndUpdate(
              roomId,
              { $pull: { participants: socket.user.id } },
              { 
                new: true,
                runValidators: true 
              }
            ).populate('participants', 'name email profileImage');

            if (updatedRoom) {
              io.to(roomId).emit('message', leaveMessage);
              io.to(roomId).emit('participantsUpdate', updatedRoom.participants);
            }
          }
        }

        logDebug('user disconnected', {
          reason,
          userId: socket.user.id,
          socketId: socket.id,
          lastRoom: roomId
        });

      } catch (error) {
        console.error('Disconnect handling error:', error);
      }
    });

    // 세션 종료 또는 로그아웃 처리
    socket.on('force_login', async ({ token }) => {
      try {
        if (!socket.user) return;

        // 강제 로그아웃을 요청한 클라이언트의 세션 정보 확인
        const decoded = jwt.verify(token, jwtSecret);
        if (!decoded?.user?.id || decoded.user.id !== socket.user.id) {
          throw new Error('Invalid token');
        }

        // 세션 종료 처리
        socket.emit('session_ended', {
          reason: 'force_logout',
          message: '다른 기기에서 로그인하여 현재 세션이 종료되었습니다.'
        });

        // 연결 종료
        socket.disconnect(true);

      } catch (error) {
        console.error('Force login error:', error);
        socket.emit('error', {
          message: '세션 종료 중 오류가 발생했습니다.'
        });
      }
    });

    // 메시지 읽음 상태 처리
    socket.on('markMessagesAsRead', async ({ roomId, messageIds }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        if (!Array.isArray(messageIds) || messageIds.length === 0) {
          return;
        }

        // 읽음 상태 업데이트
        await Message.updateMany(
          {
            _id: { $in: messageIds },
            room: roomId,
            'readers.userId': { $ne: socket.user.id }
          },
          {
            $push: {
              readers: {
                userId: socket.user.id,
                readAt: new Date()
              }
            }
          }
        );
        const cacheKey = `room:messages:${roomId}`;
        let cached = await redisClient.get(cacheKey) || [];
        let cacheChanged = false;
        if (cached) {
          if (typeof cached === 'string') cached = JSON.parse(cached);
          for (const messageId of messageIds) {
            const idx = cached.findIndex(m => m._id === messageId.toString());
            if (idx !== -1) {
              if (!cached[idx].readers) cached[idx].readers = [];
              if (!cached[idx].readers.some(r => r.userId === socket.user.id)) {
                cached[idx].readers.push({ userId: socket.user.id, readAt });
                cacheChanged = true;
              }
            }
          }
          if (cacheChanged) {
            await redisClient.setEx(cacheKey, MESSAGES_TTL, JSON.stringify(cached));
          }
        }

        socket.to(roomId).emit('messagesRead', {
          userId: socket.user.id,
          messageIds
        });

      } catch (error) {
        console.error('Mark messages as read error:', error);
        socket.emit('error', {
          message: '읽음 상태 업데이트 중 오류가 발생했습니다.'
        });
      }
    });

    // 리액션 처리
    socket.on('messageReaction', async ({ messageId, reaction, type }) => {
      try {
        if (!socket.user) {
          throw new Error('Unauthorized');
        }

        const message = await Message.findById(messageId);
        if (!message) {
          throw new Error('메시지를 찾을 수 없습니다.');
        }

        // 리액션 추가/제거
        if (type === 'add') {
          await message.addReaction(reaction, socket.user.id);
        } else if (type === 'remove') {
          await message.removeReaction(reaction, socket.user.id);
        }

        // --- PATCH: Update Redis cache for strong consistency ---
        const cacheKey = `room:messages:${message.room}`;
        let cached = await redisClient.get(cacheKey) || [];
        const idx = cached.findIndex(m => m._id === message._id.toString());
        if (idx !== -1) {
          cached[idx].reactions = message.reactions;
          await redisClient.setEx(cacheKey, MESSAGES_TTL, JSON.stringify(cached));
        }
        // --- END PATCH ---

        // 업데이트된 리액션 정보 브로드캐스트
        io.to(message.room).emit('messageReactionUpdate', {
          messageId,
          reactions: message.reactions
        });

      } catch (error) {
        console.error('Message reaction error:', error);
        socket.emit('error', {
          message: error.message || '리액션 처리 중 오류가 발생했습니다.'
        });
      }
    });
  });

  // AI 멘션 추출 함수
  function extractAIMentions(content) {
    if (!content) return [];
    
    const aiTypes = ['wayneAI', 'consultingAI'];
    const mentions = new Set();
    const mentionRegex = /@(wayneAI|consultingAI)\b/g;
    let match;
    
    while ((match = mentionRegex.exec(content)) !== null) {
      if (aiTypes.includes(match[1])) {
        mentions.add(match[1]);
      }
    }
    
    return Array.from(mentions);
  }

  // AI 응답 처리 함수 개선
  async function handleAIResponse(io, room, aiName, query) {
    const messageId = `${aiName}-${Date.now()}`;
    let accumulatedContent = '';
    const timestamp = new Date();

    // [Redis Migration] 스트리밍 세션 초기화 (Redis)
    await redisClient.setEx(
      'streamingSession:' + messageId,
      600,
      JSON.stringify({
        room,
        aiType: aiName,
        content: '',
        messageId,
        timestamp,
        lastUpdate: Date.now(),
        reactions: {}
      })
    ); // 10분 TTL
    
    logDebug('AI response started', {
      messageId,
      aiType: aiName,
      room,
      query
    });

    // 초기 상태 전송
    io.to(room).emit('aiMessageStart', {
      messageId,
      aiType: aiName,
      timestamp
    });

    try {
      // AI 응답 생성 및 스트리밍
      await aiService.generateResponse(query, aiName, {
        onStart: () => {
          logDebug('AI generation started', {
            messageId,
            aiType: aiName
          });
        },
        onChunk: async (chunk) => {
          accumulatedContent += chunk.currentChunk || '';
          // [Redis Migration] 세션 업데이트 (Redis)
          const sessionRaw = await redisClient.get('streamingSession:' + messageId);
          let session = sessionRaw;
          if (session) {
            session.content = accumulatedContent;
            session.lastUpdate = Date.now();
            await redisClient.setEx('streamingSession:' + messageId, 600, JSON.stringify(session));
          }

          io.to(room).emit('aiMessageChunk', {
            messageId,
            currentChunk: chunk.currentChunk,
            fullContent: accumulatedContent,
            isCodeBlock: chunk.isCodeBlock,
            timestamp: new Date(),
            aiType: aiName,
            isComplete: false
          });
        },
        onComplete: async (finalContent) => {
          // [Redis Migration] 스트리밍 세션 정리 (Redis)
          await redisClient.del('streamingSession:' + messageId);

          // AI 메시지 저장
          const aiMessage = await Message.create({
            room,
            content: finalContent.content,
            type: 'ai',
            aiType: aiName,
            timestamp: new Date(),
            reactions: {},
            metadata: {
              query,
              generationTime: Date.now() - timestamp,
              completionTokens: finalContent.completionTokens,
              totalTokens: finalContent.totalTokens
            }
          });

          const cacheKey = `room:messages:${room}`;
          let cached = await redisClient.get(cacheKey) || [];
          cached.push(aiMessage.toObject ? aiMessage.toObject() : aiMessage);
          if (cached.length > RECENT_MESSAGE_CACHE) cached = cached.slice(-RECENT_MESSAGE_CACHE);
          await redisClient.setEx(cacheKey, MESSAGES_TTL, JSON.stringify(cached));

          // 완료 메시지 전송
          io.to(room).emit('aiMessageComplete', {
            messageId,
            _id: aiMessage._id,
            content: finalContent.content,
            aiType: aiName,
            timestamp: new Date(),
            isComplete: true,
            query,
            reactions: {}
          });

          logDebug('AI response completed', {
            messageId,
            aiType: aiName,
            contentLength: finalContent.content.length,
            generationTime: Date.now() - timestamp
          });
        },
        onError: async (error) => {
          await redisClient.del('streamingSession:' + messageId);
          console.error('AI response error:', error);
          
          io.to(room).emit('aiMessageError', {
            messageId,
            error: error.message || 'AI 응답 생성 중 오류가 발생했습니다.',
            aiType: aiName
          });

          logDebug('AI response error', {
            messageId,
            aiType: aiName,
            error: error.message
          });
        }
      });
    } catch (error) {
      await redisClient.del('streamingSession:' + messageId);
      console.error('AI service error:', error);
      
      io.to(room).emit('aiMessageError', {
        messageId,
        error: error.message || 'AI 서비스 오류가 발생했습니다.',
        aiType: aiName
      });

      logDebug('AI service error', {
        messageId,
        aiType: aiName,
        error: error.message
      });
    }
  }

  // Pub/Sub removed for load testing optimization

  return io;
};