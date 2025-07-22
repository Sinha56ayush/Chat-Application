const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const connectDB = require('./config/db');
const User = require('./models/User');
const Message = require('./models/Message');
const bcrypt = require('bcryptjs');

// Connect to MongoDB
connectDB();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Socket.IO connection handling
io.on('connection', async (socket) => {
  console.log('A user connected:', socket.id);

  // Handle user login
  socket.on('login', async ({ username, password }) => {
    try {
      const user = await User.findOne({ username });
      if (!user) {
        socket.emit('error', 'Invalid username or password');
        return;
      }
      const isMatch = await bcrypt.compare(password, user.password);
      if (!isMatch) {
        socket.emit('error', 'Invalid username or password');
        return;
      }
      // Update user's socket ID and online status
      user.socketId = socket.id;
      user.isOnline = true;
      user.lastSeen = new Date();
      await user.save();
      // Get chat history from database
      const messages = await Message.find().sort({ timestamp: 1 }).limit(100);
      // Send chat history to the new user
      socket.emit('chatHistory', messages);
      // Get and broadcast updated user list
      const onlineUsers = await User.find({ isOnline: true });
      io.emit('userList', onlineUsers);
      console.log(`${username} logged in`);
    } catch (error) {
      console.error('Error during login:', error);
      socket.emit('error', 'Login failed');
    }
  });

  // Handle new message (one-to-one)
  socket.on('sendMessage', async (messageData) => {
    try {
      const user = await User.findOne({ socketId: socket.id });
      if (user && messageData.recipient) {
        const message = new Message({
          type: 'user',
          sender: user.username,
          recipient: messageData.recipient,
          content: messageData.content,
          timestamp: new Date()
        });
        await message.save();
        // Find recipient's socketId
        const recipientUser = await User.findOne({ username: messageData.recipient, isOnline: true });
        if (recipientUser && recipientUser.socketId) {
          io.to(recipientUser.socketId).emit('message', message);
        }
        // Also emit to sender
        socket.emit('message', message);
      }
    } catch (error) {
      console.error('Error sending message:', error);
    }
  });

  // Fetch private messages between two users
  socket.on('getPrivateMessages', async ({ withUser }) => {
    try {
      const user = await User.findOne({ socketId: socket.id });
      if (user && withUser) {
        const messages = await Message.find({
          type: 'user',
          $or: [
            { sender: user.username, recipient: withUser },
            { sender: withUser, recipient: user.username }
          ]
        }).sort({ timestamp: 1 });
        socket.emit('privateMessages', messages);
      }
    } catch (error) {
      console.error('Error fetching private messages:', error);
    }
  });

  // Handle typing indicator
  socket.on('typing', async (isTyping) => {
    const user = await User.findOne({ socketId: socket.id });
    socket.broadcast.emit('userTyping', {
      socketId: socket.id,
      username: user ? user.username : null,
      isTyping: isTyping
    });
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    try {
      const user = await User.findOne({ socketId: socket.id });
      if (user) {
        user.isOnline = false;
        user.lastSeen = new Date();
        await user.save();
        // Get and broadcast updated user list
        const onlineUsers = await User.find({ isOnline: true });
        io.emit('userList', onlineUsers);
        console.log(`${user.username} disconnected`);
      }
    } catch (error) {
      console.error('Error during disconnect:', error);
    }
  });
});

// Basic route for testing
app.get('/', (req, res) => {
  res.json({ message: 'Chat server is running!' });
});

// Get online users
app.get('/users', async (req, res) => {
  try {
    const users = await User.find({ isOnline: true });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get chat history
app.get('/messages', async (req, res) => {
  try {
    const messages = await Message.find().sort({ timestamp: -1 }).limit(100);
    res.json(messages.reverse());
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Get all users (for sidebar)
app.get('/all-users', async (req, res) => {
  try {
    const users = await User.find({}, 'username isOnline socketId');
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch all users' });
  }
});

// Signup endpoint
app.post('/signup', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  try {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(409).json({ error: 'Username already exists.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword, socketId: '', isOnline: false });
    await user.save();
    res.status(201).json({ message: 'User created successfully.' });
  } catch (error) {
    res.status(500).json({ error: 'Signup failed.' });
  }
});

// Login endpoint
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  try {
    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    res.status(200).json({ message: 'Login successful.' });
  } catch (error) {
    res.status(500).json({ error: 'Login failed.' });
  }
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Chat server is ready for connections!`);
  console.log(`MongoDB database: ChatApp`);
}); 