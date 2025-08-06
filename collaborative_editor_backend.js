// package.json
{
  "name": "collaborative-code-editor",
  "version": "1.0.0",
  "description": "Real-time collaborative code editor with React and Socket.io",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "client": "cd client && npm start",
    "build": "cd client && npm run build",
    "docker:build": "docker build -t code-editor .",
    "docker:run": "docker run -p 3001:3001 -p 3000:3000 code-editor"
  },
  "dependencies": {
    "express": "^4.18.2",
    "socket.io": "^4.7.2",
    "mongoose": "^7.5.0",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "firebase-admin": "^11.10.1",
    "bcryptjs": "^2.4.3",
    "jsonwebtoken": "^9.0.2",
    "helmet": "^7.0.0",
    "rate-limiter-flexible": "^2.4.2",
    "winston": "^3.10.0"
  },
  "devDependencies": {
    "nodemon": "^3.0.1"
  }
}

// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('rate-limiter-flexible');
const winston = require('winston');
require('dotenv').config();

const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const { authenticateSocket } = require('./middleware/auth');
const Room = require('./models/Room');
const User = require('./models/User');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Configure Socket.io with CORS
const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Rate limiting
const rateLimiter = new rateLimit.RateLimiterMemory({
  keyGenerator: (req) => req.ip,
  points: 100, // 100 requests
  duration: 60, // per 60 seconds
});

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || "http://localhost:3000",
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.static('client/build'));

// Rate limiting middleware
app.use(async (req, res, next) => {
  try {
    await rateLimiter.consume(req.ip);
    next();
  } catch (rejRes) {
    res.status(429).json({ error: 'Too many requests' });
  }
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/collaborative_editor', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => logger.info('Connected to MongoDB'))
.catch((err) => logger.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Store active rooms and users
const activeRooms = new Map();
const userSockets = new Map();

// Operational Transform functions
class OperationalTransform {
  static transform(op1, op2) {
    // Simple character-based operational transform
    if (op1.type === 'insert' && op2.type === 'insert') {
      if (op1.position <= op2.position) {
        return [op1, { ...op2, position: op2.position + op1.text.length }];
      } else {
        return [{ ...op1, position: op1.position + op2.text.length }, op2];
      }
    }
    
    if (op1.type === 'delete' && op2.type === 'delete') {
      if (op1.position + op1.length <= op2.position) {
        return [op1, { ...op2, position: op2.position - op1.length }];
      } else if (op2.position + op2.length <= op1.position) {
        return [{ ...op1, position: op1.position - op2.length }, op2];
      }
    }
    
    if (op1.type === 'insert' && op2.type === 'delete') {
      if (op1.position <= op2.position) {
        return [op1, { ...op2, position: op2.position + op1.text.length }];
      } else if (op1.position >= op2.position + op2.length) {
        return [{ ...op1, position: op1.position - op2.length }, op2];
      }
    }
    
    if (op1.type === 'delete' && op2.type === 'insert') {
      if (op2.position <= op1.position) {
        return [{ ...op1, position: op1.position + op2.text.length }, op2];
      } else if (op2.position >= op1.position + op1.length) {
        return [op1, { ...op2, position: op2.position - op1.length }];
      }
    }
    
    return [op1, op2];
  }
  
  static applyOperation(content, operation) {
    if (operation.type === 'insert') {
      return content.slice(0, operation.position) + 
             operation.text + 
             content.slice(operation.position);
    } else if (operation.type === 'delete') {
      return content.slice(0, operation.position) + 
             content.slice(operation.position + operation.length);
    }
    return content;
  }
}

// Socket.io connection handling
io.use(authenticateSocket);

io.on('connection', (socket) => {
  const userId = socket.userId;
  const userInfo = socket.userInfo;
  
  logger.info(`User connected: ${userInfo.name} (${userId})`);
  userSockets.set(userId, socket);
  
  // Join room
  socket.on('join-room', async (data) => {
    try {
      const { roomId, language = 'javascript' } = data;
      
      // Get or create room
      let room = await Room.findOne({ roomId });
      if (!room) {
        room = new Room({
          roomId,
          name: `Room ${roomId}`,
          language,
          content: getDefaultContent(language),
          createdBy: userId,
          participants: [userId]
        });
        await room.save();
      } else if (!room.participants.includes(userId)) {
        room.participants.push(userId);
        await room.save();
      }
      
      // Join socket room
      socket.join(roomId);
      socket.currentRoom = roomId;
      
      // Initialize or update room state
      if (!activeRooms.has(roomId)) {
        activeRooms.set(roomId, {
          participants: new Map(),
          content: room.content,
          language: room.language,
          operations: []
        });
      }
      
      const roomState = activeRooms.get(roomId);
      roomState.participants.set(userId, {
        ...userInfo,
        socketId: socket.id,
        cursor: { line: 1, ch: 0 },
        selection: null
      });
      
      // Send current room state to user
      socket.emit('room-state', {
        content: roomState.content,
        language: roomState.language,
        participants: Array.from(roomState.participants.values())
      });
      
      // Notify others about new user
      socket.to(roomId).emit('user-joined', {
        user: userInfo,
        participants: Array.from(roomState.participants.values())
      });
      
      logger.info(`User ${userInfo.name} joined room ${roomId}`);
      
    } catch (error) {
      logger.error('Error joining room:', error);
      socket.emit('error', { message: 'Failed to join room' });
    }
  });
  
  // Handle code changes
  socket.on('code-change', async (data) => {
    try {
      const { roomId, operation, content } = data;
      const roomState = activeRooms.get(roomId);
      
      if (!roomState) {
        socket.emit('error', { message: 'Room not found' });
        return;
      }
      
      // Apply operational transform
      const transformedOperation = { ...operation, userId, timestamp: Date.now() };
      
      // Transform against pending operations
      for (const pendingOp of roomState.operations) {
        if (pendingOp.userId !== userId) {
          [transformedOperation] = OperationalTransform.transform(transformedOperation, pendingOp);
        }
      }
      
      // Apply operation to room content
      roomState.content = OperationalTransform.applyOperation(roomState.content, transformedOperation);
      roomState.operations.push(transformedOperation);
      
      // Clean old operations (keep last 100)
      if (roomState.operations.length > 100) {
        roomState.operations = roomState.operations.slice(-100);
      }
      
      // Broadcast to other users in room
      socket.to(roomId).emit('code-change', {
        operation: transformedOperation,
        content: roomState.content
      });
      
      // Auto-save to database every 30 seconds
      if (!roomState.lastSave || Date.now() - roomState.lastSave > 30000) {
        await Room.updateOne(
          { roomId },
          { content: roomState.content, lastModified: new Date() }
        );
        roomState.lastSave = Date.now();
      }
      
    } catch (error) {
      logger.error('Error handling code change:', error);
      socket.emit('error', { message: 'Failed to process code change' });
    }
  });
  
  // Handle cursor updates
  socket.on('cursor-update', (data) => {
    const { roomId, cursor, selection } = data;
    const roomState = activeRooms.get(roomId);
    
    if (roomState && roomState.participants.has(userId)) {
      const participant = roomState.participants.get(userId);
      participant.cursor = cursor;
      participant.selection = selection;
      
      // Broadcast cursor position to others
      socket.to(roomId).emit('cursor-update', {
        userId,
        user: userInfo,
        cursor,
        selection
      });
    }
  });
  
  // Handle language changes
  socket.on('language-change', async (data) => {
    try {
      const { roomId, language } = data;
      const roomState = activeRooms.get(roomId);
      
      if (roomState) {
        roomState.language = language;
        
        // Update database
        await Room.updateOne({ roomId }, { language });
        
        // Broadcast to all users in room
        io.to(roomId).emit('language-change', { language });
        
        logger.info(`Language changed to ${language} in room ${roomId}`);
      }
    } catch (error) {
      logger.error('Error changing language:', error);
    }
  });
  
  // Handle chat messages
  socket.on('chat-message', (data) => {
    const { roomId, message } = data;
    const roomState = activeRooms.get(roomId);
    
    if (roomState) {
      const chatMessage = {
        id: generateId(),
        user: userInfo,
        message,
        timestamp: new Date()
      };
      
      // Broadcast to all users in room
      io.to(roomId).emit('chat-message', chatMessage);
      
      logger.info(`Chat message from ${userInfo.name} in room ${roomId}: ${message}`);
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    logger.info(`User disconnected: ${userInfo.name} (${userId})`);
    userSockets.delete(userId);
    
    if (socket.currentRoom) {
      const roomState = activeRooms.get(socket.currentRoom);
      if (roomState) {
        roomState.participants.delete(userId);
        
        // Notify others about user leaving
        socket.to(socket.currentRoom).emit('user-left', {
          userId,
          user: userInfo,
          participants: Array.from(roomState.participants.values())
        });
        
        // Clean up empty rooms
        if (roomState.participants.size === 0) {
          activeRooms.delete(socket.currentRoom);
          logger.info(`Room ${socket.currentRoom} cleaned up`);
        }
      }
    }
  });
  
  // Handle errors
  socket.on('error', (error) => {
    logger.error('Socket error:', error);
  });
});

// Helper functions
function getDefaultContent(language) {
  const defaultContents = {
    javascript: `// Welcome to the collaborative editor!
console.log("Hello, World!");

function fibonacci(n) {
    if (n <= 1) return n;
    return fibonacci(n - 1) + fibonacci(n - 2);
}

console.log(fibonacci(10));`,
    
    python: `# Welcome to the collaborative editor!
print("Hello, World!")

def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

print(fibonacci(10))`,
    
    java: `// Welcome to the collaborative editor!
public class Main {
    public static void main(String[] args) {
        System.out.println("Hello, World!");
        System.out.println(fibonacci(10));
    }
    
    public static int fibonacci(int n) {
        if (n <= 1) return n;
        return fibonacci(n - 1) + fibonacci(n - 2);
    }
}`,
    
    html: `<!DOCTYPE html>
<html>
<head>
    <title>Collaborative HTML</title>
</head>
<body>
    <h1>Hello, World!</h1>
    <p>Welcome to the collaborative editor!</p>
</body>
</html>`
  };
  
  return defaultContents[language] || defaultContents.javascript;
}

function generateId() {
  return Math.random().toString(36).substring(2, 15) + 
         Math.random().toString(36).substring(2, 15);
}

// Start server
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  logger.info(`Server running on port ${PORT}`);
});

module.exports = { app, server, io };

// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  uid: { // Firebase UID
    type: String,
    required: true,
    unique: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  avatar: {
    type: String,
    default: null
  },
  preferences: {
    theme: { type: String, default: 'dark' },
    fontSize: { type: Number, default: 14 },
    tabSize: { type: Number, default: 2 },
    wordWrap: { type: Boolean, default: true }
  },
  rooms: [{
    roomId: String,
    lastAccessed: { type: Date, default: Date.now }
  }],
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Index for better performance
userSchema.index({ uid: 1 });
userSchema.index({ email: 1 });

module.exports = mongoose.model('User', userSchema);

// models/Room.js
const mongoose = require('mongoose');

const roomSchema = new mongoose.Schema({
  roomId: {
    type: String,
    required: true,
    unique: true
  },
  name: {
    type: String,
    required: true
  },
  description: {
    type: String,
    default: ''
  },
  language: {
    type: String,
    default: 'javascript',
    enum: ['javascript', 'python', 'java', 'cpp', 'html', 'css', 'json', 'markdown']
  },
  content: {
    type: String,
    default: ''
  },
  createdBy: {
    type: String,
    required: true
  },
  participants: [{
    type: String
  }],
  isPublic: {
    type: Boolean,
    default: false
  },
  maxParticipants: {
    type: Number,
    default: 10
  },
  settings: {
    readOnly: { type: Boolean, default: false },
    allowChat: { type: Boolean, default: true },
    autoSave: { type: Boolean, default: true }
  },
  lastModified: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Indexes
roomSchema.index({ roomId: 1 });
roomSchema.index({ createdBy: 1 });
roomSchema.index({ participants: 1 });
roomSchema.index({ isPublic: 1 });

module.exports = mongoose.model('Room', roomSchema);

// routes/auth.js
const express = require('express');
const admin = require('firebase-admin');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Initialize Firebase Admin
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token"
};

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

// Verify Firebase token and create/update user
router.post('/verify-token', async (req, res) => {
  try {
    const { idToken } = req.body;
    
    if (!idToken) {
      return res.status(400).json({ error: 'ID token is required' });
    }
    
    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const { uid, email, name, picture } = decodedToken;
    
    // Find or create user
    let user = await User.findOne({ uid });
    if (!user) {
      user = new User({
        uid,
        email,
        name: name || email.split('@')[0],
        avatar: picture
      });
      await user.save();
    } else {
      // Update last login
      user.lastLogin = new Date();
      await user.save();
    }
    
    res.json({
      success: true,
      user: {
        uid: user.uid,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        preferences: user.preferences
      }
    });
    
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Get user profile
router.get('/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.user.uid });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      user: {
        uid: user.uid,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        preferences: user.preferences,
        rooms: user.rooms
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user preferences
router.put('/preferences', authenticateToken, async (req, res) => {
  try {
    const { preferences } = req.body;
    
    await User.updateOne(
      { uid: req.user.uid },
      { preferences }
    );
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

// routes/rooms.js
const express = require('express');
const Room = require('../models/Room');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Get user's rooms
router.get('/', authenticateToken, async (req, res) => {
  try {
    const rooms = await Room.find({
      $or: [
        { createdBy: req.user.uid },
        { participants: req.user.uid },
        { isPublic: true }
      ]
    })
    .select('roomId name description language createdBy participants isPublic lastModified')
    .sort({ lastModified: -1 })
    .limit(50);
    
    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new room
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, description, language = 'javascript', isPublic = false } = req.body;
    
    const roomId = generateRoomId();
    const room = new Room({
      roomId,
      name,
      description,
      language,
      createdBy: req.user.uid,
      participants: [req.user.uid],
      isPublic,
      content: getDefaultContent(language)
    });
    
    await room.save();
    
    res.json({ room });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get room details
router.get('/:roomId', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await Room.findOne({ roomId });
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    // Check if user has access
    if (!room.isPublic && 
        !room.participants.includes(req.user.uid) && 
        room.createdBy !== req.user.uid) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    res.json({ room });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update room
router.put('/:roomId', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const updates = req.body;
    
    const room = await Room.findOne({ roomId });
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    // Check if user is the owner
    if (room.createdBy !== req.user.uid) {
      return res.status(403).json({ error: 'Only room owner can update settings' });
    }
    
    await Room.updateOne({ roomId }, updates);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete room
router.delete('/:roomId', authenticateToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const room = await Room.findOne({ roomId });
    
    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }
    
    // Check if user is the owner
    if (room.createdBy !== req.user.uid) {
      return res.status(403).json({ error: 'Only room owner can delete room' });
    }
    
    await Room.deleteOne({ roomId });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper functions
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getDefaultContent(language) {
  const defaultContents = {
    javascript: `// Welcome to the collaborative editor!\nconsole.log("Hello, World!");`,
    python: `# Welcome to the collaborative editor!\nprint("Hello, World!")`,
    java: `// Welcome to the collaborative editor!\npublic class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}`,
    html: `<!DOCTYPE html>\n<html>\n<head>\n    <title>Collaborative HTML</title>\n</head>\n<body>\n    <h1>Hello, World!</h1>\n</body>\n</html>`
  };
  return defaultContents[language] || defaultContents.javascript;
}

module.exports = router;