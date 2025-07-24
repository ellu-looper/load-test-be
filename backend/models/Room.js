const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const RoomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  hasPassword: {
    type: Boolean,
    default: false
  },
  password: {
    type: String,
    select: false
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }]
});

// 비밀번호 해싱 미들웨어
RoomSchema.pre('save', async function(next) {
  if (this.isModified('password') && this.password) {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    this.hasPassword = true;
  }
  if (!this.password) {
    this.hasPassword = false;
  }
  next();
});

// 비밀번호 확인 메서드
RoomSchema.methods.checkPassword = async function(password) {
  if (!this.hasPassword) return true;
  
  // 비밀번호가 제공되지 않은 경우
  if (!password) return false;
  
  const room = await this.constructor.findById(this._id).select('+password');
  if (!room || !room.password) return false;
  
  return await bcrypt.compare(password, room.password);
};

// 로드 테스트 최적화를 위한 인덱스 설정
RoomSchema.index({ creator: 1, createdAt: -1 }); // 생성자별 룸 조회용
RoomSchema.index({ participants: 1 }); // 참가자별 룸 조회용 (가장 빈번한 쿼리)
RoomSchema.index({ createdAt: -1 }); // 최근 생성된 룸 조회용
RoomSchema.index({ name: 1 }); // 룸 이름 검색용
RoomSchema.index({ hasPassword: 1 }); // 비밀번호 유무별 필터링용

module.exports = mongoose.model('Room', RoomSchema);