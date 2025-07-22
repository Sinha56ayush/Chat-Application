const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['user', 'system'],
    required: true
  },
  sender: {
    type: String,
    required: function() {
      return this.type === 'user';
    }
  },
  recipient: {
    type: String,
    required: function() {
      return this.type === 'user';
    }
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Message', messageSchema); 