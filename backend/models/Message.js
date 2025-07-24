const mongoose = require('mongoose');

const MessageSchema = new mongoose.Schema({
  room: { 
    type: String, 
    required: [true, '채팅방 ID는 필수입니다.'],
    index: true
  },
  content: { 
    type: String,
    required: function() {
      return this.type !== 'file';
    },
    trim: true,
    maxlength: [10000, '메시지는 10000자를 초과할 수 없습니다.']
  },
  sender: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    index: true 
  },
  type: { 
    type: String, 
    enum: ['text', 'system', 'ai', 'file'], 
    default: 'text',
    index: true
  },
  file: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'File',
    required: function() {
      return this.type === 'file';
    }
  },
  aiType: {
    type: String,
    enum: ['wayneAI', 'consultingAI'],
    required: function() { 
      return this.type === 'ai'; 
    }
  },
  mentions: [{ 
    type: String,
    trim: true
  }],
  timestamp: { 
    type: Date, 
    default: Date.now,
    index: true 
  },
  readers: [{
    userId: { 
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    readAt: { 
      type: Date,
      default: Date.now,
      required: true
    }
  }],
  reactions: {
    type: Map,
    of: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    default: new Map()
  },
  metadata: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: new Map()
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true,
  toJSON: { 
    virtuals: true,
    getters: true 
  },
  toObject: { 
    virtuals: true,
    getters: true 
  }
});

// 로드 테스트 성능 최적화를 위한 복합 인덱스 설정
// 메시지 로딩 쿼리용 기본 인덱스 (가장 빈번한 작업)
MessageSchema.index({ room: 1, timestamp: -1, isDeleted: 1 });

// 읽음 상태 쿼리용 인덱스 (실시간 작업에서 빈번함)
MessageSchema.index({ room: 1, 'readers.userId': 1 });

// 발신자 기반 쿼리용 인덱스 (룸 필터링 포함)
MessageSchema.index({ sender: 1, room: 1, timestamp: -1 });

// AI 메시지 쿼리용 인덱스
MessageSchema.index({ room: 1, type: 1, aiType: 1 });

// 파일 메시지 쿼리용 인덱스
MessageSchema.index({ room: 1, type: 1, file: 1 });

// 멘션 쿼리용 인덱스
MessageSchema.index({ room: 1, mentions: 1 });

// 리액션용 희소 인덱스 (리액션이 있는 메시지만)
MessageSchema.index({ 'reactions': 1 }, { sparse: true });

// 메시지 정리용 TTL 인덱스 (선택사항 - 매우 높은 부하 시나리오용)
// MessageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 2592000 }); // 30일

// 읽음 처리 Static 메소드 개선
MessageSchema.statics.markAsRead = async function(messageIds, userId) {
  if (!messageIds?.length || !userId) return;

  const bulkOps = messageIds.map(messageId => ({
    updateOne: {
      filter: {
        _id: messageId,
        isDeleted: false,
        'readers.userId': { $ne: userId }
      },
      update: {
        $push: {
          readers: {
            userId: new mongoose.Types.ObjectId(userId),
            readAt: new Date()
          }
        }
      }
    }
  }));

  try {
    const result = await this.bulkWrite(bulkOps, { ordered: false });
    return result.modifiedCount;
  } catch (error) {
    console.error('Mark as read error:', {
      error,
      messageIds,
      userId
    });
    throw error;
  }
};

// 리액션 처리 메소드 개선
MessageSchema.methods.addReaction = async function(emoji, userId) {
  try {
    if (!this.reactions) {
      this.reactions = new Map();
    }

    const userReactions = this.reactions.get(emoji) || [];
    if (!userReactions.includes(userId)) {
      userReactions.push(userId);
      this.reactions.set(emoji, userReactions);
      await this.save();
    }
    
    return this.reactions.get(emoji);
  } catch (error) {
    console.error('Add reaction error:', {
      error,
      messageId: this._id,
      emoji,
      userId
    });
    throw error;
  }
};

MessageSchema.methods.removeReaction = async function(emoji, userId) {
  try {
    if (!this.reactions || !this.reactions.has(emoji)) return;

    const userReactions = this.reactions.get(emoji) || [];
    const updatedReactions = userReactions.filter(id => 
      id.toString() !== userId.toString()
    );
    
    if (updatedReactions.length === 0) {
      this.reactions.delete(emoji);
    } else {
      this.reactions.set(emoji, updatedReactions);
    }
    
    await this.save();
    return this.reactions.get(emoji);
  } catch (error) {
    console.error('Remove reaction error:', {
      error,
      messageId: this._id,
      emoji,
      userId
    });
    throw error;
  }
};

// 메시지 소프트 삭제 메소드 추가
MessageSchema.methods.softDelete = async function() {
  this.isDeleted = true;
  await this.save();
};

// 메시지 삭제 전 후크 개선
MessageSchema.pre('remove', async function(next) {
  try {
    if (this.type === 'file' && this.file) {
      const File = mongoose.model('File');
      await File.findByIdAndDelete(this.file);
    }
    next();
  } catch (error) {
    console.error('Message pre-remove error:', {
      error,
      messageId: this._id,
      type: this.type
    });
    next(error);
  }
});

// 메시지 저장 전 후크 개선
MessageSchema.pre('save', function(next) {
  try {
    if (this.content && this.type !== 'file') {
      this.content = this.content.trim();
    }

    if (this.mentions?.length) {
      this.mentions = [...new Set(this.mentions)];
    }

    next();
  } catch (error) {
    console.error('Message pre-save error:', {
      error,
      messageId: this._id
    });
    next(error);
  }
});

// JSON 변환 메소드 개선
MessageSchema.methods.toJSON = function() {
  try {
    const obj = this.toObject();
    
    // 불필요한 필드 제거
    delete obj.__v;
    delete obj.updatedAt;
    delete obj.isDeleted;
    
    // reactions Map을 일반 객체로 변환
    if (obj.reactions) {
      obj.reactions = Object.fromEntries(obj.reactions);
    }

    return obj;
  } catch (error) {
    console.error('Message toJSON error:', {
      error,
      messageId: this._id
    });
    return {};
  }
};

const Message = mongoose.model('Message', MessageSchema);
module.exports = Message;