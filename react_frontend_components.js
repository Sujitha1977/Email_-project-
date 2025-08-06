// middleware/auth.js
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Authenticate HTTP requests
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Access token required' });
    }
    
    // Verify Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Authenticate Socket.io connections
const authenticateSocket = async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    
    if (!token) {
      return next(new Error('Authentication token required'));
    }
    
    // Verify Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);
    const user = await User.findOne({ uid: decodedToken.uid });
    
    if (!user) {
      return next(new Error('User not found'));
    }
    
    socket.userId = user.uid;
    socket.userInfo = {
      uid: user.uid,
      name: user.name,
      email: user.email,
      avatar: user.avatar
    };
    
    next();
  } catch (error) {
    next(new Error('Authentication failed'));
  }
};

module.exports = { authenticateToken, authenticateSocket };

// client/src/App.js
import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged } from 'firebase/auth';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { SocketProvider } from './contexts/SocketContext';
import LoginPage from './components/LoginPage';
import Dashboard from './components/Dashboard';
import CodeEditor from './components/CodeEditor';
import LoadingSpinner from './components/LoadingSpinner';
import './App.css';

// Firebase configuration
const firebaseConfig = {
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY,
  authDomain: process.env.REACT_APP_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.REACT_APP_FIREBASE_PROJECT_ID,
  storageBucket: process.env.REACT_APP_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.REACT_APP_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.REACT_APP_FIREBASE_APP_ID
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingSpinner />;
  }

  return (
    <Router>
      <Routes>
        <Route 
          path="/login" 
          element={!user ? <LoginPage /> : <Navigate to="/dashboard" />} 
        />
        <Route 
          path="/dashboard" 
          element={user ? <Dashboard /> : <Navigate to="/login" />} 
        />
        <Route 
          path="/room/:roomId" 
          element={user ? <CodeEditor /> : <Navigate to="/login" />} 
        />
        <Route 
          path="/" 
          element={<Navigate to={user ? "/dashboard" : "/login"} />} 
        />
      </Routes>
    </Router>
  );
}

function App() {
  return (
    <AuthProvider auth={auth}>
      <SocketProvider>
        <div className="App">
          <AppContent />
        </div>
      </SocketProvider>
    </AuthProvider>
  );
}

export default App;

// client/src/contexts/AuthContext.js
import React, { createContext, useContext, useState, useEffect } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children, auth }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        try {
          // Get ID token and verify with backend
          const idToken = await firebaseUser.getIdToken();
          const response = await fetch('/api/auth/verify-token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ idToken }),
          });

          if (response.ok) {
            const { user: userData } = await response.json();
            setUser({
              ...userData,
              idToken,
              firebase: firebaseUser
            });
          }
        } catch (error) {
          console.error('Error verifying token:', error);
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    return unsubscribe;
  }, [auth]);

  const logout = async () => {
    try {
      await signOut(auth);
      setUser(null);
    } catch (error) {
      console.error('Logout error:', error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout, auth }}>
      {children}
    </AuthContext.Provider>
  );
};

// client/src/contexts/SocketContext.js
import React, { createContext, useContext, useEffect, useState } from 'react';
import io from 'socket.io-client';
import { useAuth } from './AuthContext';

const SocketContext = createContext();

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within SocketProvider');
  }
  return context;
};

export const SocketProvider = ({ children }) => {
  const [socket, setSocket] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const { user } = useAuth();

  useEffect(() => {
    if (user && user.idToken) {
      const newSocket = io(process.env.REACT_APP_SERVER_URL || 'http://localhost:3001', {
        auth: {
          token: user.idToken
        },
        transports: ['websocket', 'polling']
      });

      newSocket.on('connect', () => {
        console.log('Connected to server');
        setIsConnected(true);
      });

      newSocket.on('disconnect', () => {
        console.log('Disconnected from server');
        setIsConnected(false);
      });

      newSocket.on('error', (error) => {
        console.error('Socket error:', error);
      });

      setSocket(newSocket);

      return () => {
        newSocket.close();
      };
    } else {
      if (socket) {
        socket.close();
        setSocket(null);
        setIsConnected(false);
      }
    }
  }, [user]);

  return (
    <SocketContext.Provider value={{ socket, isConnected }}>
      {children}
    </SocketContext.Provider>
  );
};

// client/src/components/CodeEditor.js
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSocket } from '../contexts/SocketContext';
import { useAuth } from '../contexts/AuthContext';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { java } from '@codemirror/lang-java';
import { cpp } from '@codemirror/lang-cpp';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import Sidebar from './Sidebar';
import Toolbar from './Toolbar';
import StatusBar from './StatusBar';
import Chat from './Chat';
import './CodeEditor.css';

const languageExtensions = {
  javascript: javascript(),
  python: python(),
  java: java(),
  cpp: cpp(),
  html: html(),
  css: css(),
  json: json(),
  markdown: markdown()
};

const CodeEditor = () => {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { socket, isConnected } = useSocket();
  const { user } = useAuth();
  
  const [code, setCode] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [participants, setParticipants] = useState([]);
  const [cursors, setCursors] = useState({});
  const [chatMessages, setChatMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [roomInfo, setRoomInfo] = useState(null);
  
  const editorRef = useRef(null);
  const lastOperation = useRef(null);

  // Join room on component mount
  useEffect(() => {
    if (socket && roomId) {
      socket.emit('join-room', { roomId, language });
      
      // Listen for room state
      socket.on('room-state', (state) => {
        setCode(state.content);
        setLanguage(state.language);
        setParticipants(state.participants);
        setIsLoading(false);
      });

      // Listen for code changes
      socket.on('code-change', (data) => {
        if (data.operation.userId !== user.uid) {
          setCode(data.content);
        }
      });

      // Listen for user events
      socket.on('user-joined', (data) => {
        setParticipants(data.participants);
        setChatMessages(prev => [...prev, {
          id: Date.now(),
          type: 'system',
          message: `${data.user.name} joined the session`,
          timestamp: new Date()
        }]);
      });

      socket.on('user-left', (data) => {
        setParticipants(data.participants);
        setChatMessages(prev => [...prev, {
          id: Date.now(),
          type: 'system',
          message: `${data.user.name} left the session`,
          timestamp: new Date()
        }]);
      });

      // Listen for cursor updates
      socket.on('cursor-update', (data) => {
        setCursors(prev => ({
          ...prev,
          [data.userId]: {
            user: data.user,
            cursor: data.cursor,
            selection: data.selection
          }
        }));
      });

      // Listen for language changes
      socket.on('language-change', (data) => {
        setLanguage(data.language);
      });

      // Listen for chat messages
      socket.on('chat-message', (message) => {
        setChatMessages(prev => [...prev, message]);
      });

      // Cleanup listeners
      return () => {
        socket.off('room-state');
        socket.off('code-change');
        socket.off('user-joined');
        socket.off('user-left');
        socket.off('cursor-update');
        socket.off('language-change');
        socket.off('chat-message');
      };
    }
  }, [socket, roomId, language, user.uid]);

  // Handle code changes
  const handleCodeChange = useCallback((value, viewUpdate) => {
    if (socket && viewUpdate.docChanged) {
      const changes = viewUpdate.changes;
      
      changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        const operation = {
          type: inserted.length > 0 ? 'insert' : 'delete',
          position: fromA,
          text: inserted.toString(),
          length: toA - fromA
        };

        socket.emit('code-change', {
          roomId,
          operation,
          content: value
        });
      });
    }
    
    setCode(value);
  }, [socket, roomId]);

  // Handle cursor changes
  const handleCursorChange = useCallback((state) => {
    if (socket) {
      const cursor = {
        line: state.selection.main.head,
        ch: 0 // SimpleBachelor implementation
      };
      
      socket.emit('cursor-update', {
        roomId,
        cursor,
        selection: state.selection.ranges
      });
    }
  }, [socket, roomId]);

  // Handle language change
  const handleLanguageChange = (newLanguage) => {
    if (socket) {
      socket.emit('language-change', { roomId, language: newLanguage });
    }
  };

  // Handle chat message
  const handleSendMessage = (message) => {
    if (socket) {
      socket.emit('chat-message', { roomId, message });
    }
  };

  // Download code
  const handleDownload = () => {
    const extensions = {
      javascript: 'js',
      python: 'py',
      java: 'java',
      cpp: 'cpp',
      html: 'html',
      css: 'css',
      json: 'json',
      markdown: 'md'
    };

    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code.${extensions[language] || 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Leave room
  const handleLeaveRoom = () => {
    navigate('/dashboard');
  };

  if (isLoading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Joining room...</p>
      </div>
    );
  }

  return (
    <div className="code-editor-container">
      <div className="editor-header">
        <div className="header-left">
          <button 
            className="leave-button"
            onClick={handleLeaveRoom}
            title="Leave Room"
          >
            ← Back to Dashboard
          </button>
          <h2>Room: {roomId}</h2>
          <div className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
            <span className="status-dot"></span>
            {isConnected ? 'Connected' : 'Disconnected'}
          </div>
        </div>
        <div className="header-right">
          <span className="participant-count">
            {participants.length} participant{participants.length !== 1 ? 's' : ''}
          </span>
        </div>
      </div>

      <div className="editor-content">
        <Sidebar
          language={language}
          onLanguageChange={handleLanguageChange}
          participants={participants}
          currentUser={user}
        />

        <div className="editor-main">
          <Toolbar
            onDownload={handleDownload}
            onClear={() => setCode('')}
            language={language}
          />

          <div className="editor-wrapper">
            <CodeMirror
              ref={editorRef}
              value={code}
              height="100%"
              extensions={[
                languageExtensions[language] || languageExtensions.javascript,
                EditorView.theme({
                  '&': { height: '100%' },
                  '.cm-scroller': { fontFamily: 'Monaco, Consolas, monospace' },
                  '.cm-focused': { outline: 'none' }
                })
              ]}
              theme={oneDark}
              onChange={handleCodeChange}
              onUpdate={(viewUpdate) => {
                if (viewUpdate.selectionSet) {
                  handleCursorChange(viewUpdate.state);
                }
              }}
              basicSetup={{
                lineNumbers: true,
                foldGutter: true,
                dropCursor: false,
                allowMultipleSelections: false,
                indentOnInput: true,
                bracketMatching: true,
                closeBrackets: true,
                autocompletion: true,
                highlightSelectionMatches: false
              }}
            />
            
            {/* Render remote cursors */}
            <div className="remote-cursors">
              {Object.entries(cursors).map(([userId, cursorData]) => (
                <div
                  key={userId}
                  className="remote-cursor"
                  style={{
                    backgroundColor: cursorData.user.color || '#58a6ff',
                    // Position would be calculated based on cursor.line and cursor.ch
                  }}
                  title={cursorData.user.name}
                />
              ))}
            </div>
          </div>

          <StatusBar
            language={language}
            lines={code.split('\n').length}
            characters={code.length}
            participants={participants.length}
            isConnected={isConnected}
          />
        </div>

        <Chat
          messages={chatMessages}
          onSendMessage={handleSendMessage}
          currentUser={user}
        />
      </div>
    </div>
  );
};

export default CodeEditor;

// client/src/components/Dashboard.js
import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import CreateRoomModal from './CreateRoomModal';
import './Dashboard.css';

const Dashboard = () => {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState([]);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchRooms();
  }, []);

  const fetchRooms = async () => {
    try {
      const response = await fetch('/api/rooms', {
        headers: {
          'Authorization': `Bearer ${user.idToken}`
        }
      });

      if (response.ok) {
        const { rooms } = await response.json();
        setRooms(rooms);
      }
    } catch (error) {
      console.error('Error fetching rooms:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleJoinRoom = (roomId) => {
    navigate(`/room/${roomId}`);
  };

  const handleCreateRoom = async (roomData) => {
    try {
      const response = await fetch('/api/rooms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user.idToken}`
        },
        body: JSON.stringify(roomData)
      });

      if (response.ok) {
        const { room } = await response.json();
        navigate(`/room/${room.roomId}`);
      }
    } catch (error) {
      console.error('Error creating room:', error);
    }
  };

  const handleQuickJoin = () => {
    const roomId = prompt('Enter Room ID:');
    if (roomId) {
      handleJoinRoom(roomId.toUpperCase());
    }
  };

  if (loading) {
    return (
      <div className="loading-container">
        <div className="spinner"></div>
        <p>Loading your rooms...</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <div className="header-left">
          <h1>🚀 CodeSync Dashboard</h1>
          <p>Welcome back, {user.name}!</p>
        </div>
        <div className="header-right">
          <div className="user-info">
            <img 
              src={user.avatar || `https://ui-avatars.com/api/?name=${user.name}&background=58a6ff&color=fff`}
              alt={user.name}
              className="user-avatar"
            />
            <span>{user.name}</span>
          </div>
          <button className="logout-button" onClick={logout}>
            Logout
          </button>
        </div>
      </div>

      <div className="dashboard-content">
        <div className="actions-section">
          <button 
            className="create-room-btn primary"
            onClick={() => setShowCreateModal(true)}
          >
            ✨ Create New Room
          </button>
          <button 
            className="join-room-btn secondary"
            onClick={handleQuickJoin}
          >
            🔗 Join Room
          </button>
        </div>

        <div className="rooms-section">
          <h2>Your Rooms</h2>
          
          {rooms.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📁</div>
              <h3>No rooms yet</h3>
              <p>Create your first collaborative coding room!</p>
              <button 
                className="create-first-room"
                onClick={() => setShowCreateModal(true)}
              >
                Create Room
              </button>
            </div>
          ) : (
            <div className="rooms-grid">
              {rooms.map(room => (
                <div key={room._id} className="room-card">
                  <div className="room-header">
                    <h3>{room.name}</h3>
                    <span className={`language-badge ${room.language}`}>
                      {room.language}
                    </span>
                  </div>
                  
                  <p className="room-description">
                    {room.description || 'No description'}
                  </p>
                  
                  <div className="room-meta">
                    <span className="room-id">ID: {room.roomId}</span>
                    <span className="participant-count">
                      {room.participants.length} member{room.participants.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                  
                  <div className="room-footer">
                    <span className="last-modified">
                      {new Date(room.lastModified).toLocaleDateString()}
                    </span>
                    <button 
                      className="join-button"
                      onClick={() => handleJoinRoom(room.roomId)}
                    >
                      Join Room →
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <CreateRoomModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreateRoom}
        />
      )}
    </div>
  );
};

export default Dashboard;

// Dockerfile
FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY client/package*.json ./client/

# Install dependencies
RUN npm install
RUN cd client && npm install

# Copy source code
COPY . .

# Build client
RUN cd client && npm run build

# Create logs directory
RUN mkdir -p logs

# Expose ports
EXPOSE 3001 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3001/api/health || exit 1

# Start server
CMD ["npm", "start"]

// docker-compose.yml (YAML format shown as comment)
/*
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3001:3001"
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - MONGODB_URI=mongodb://mongo:27017/collaborative_editor
      - CLIENT_URL=http://localhost:3000
    depends_on:
      - mongo
      - redis
    volumes:
      - ./logs:/app/logs

  mongo:
    image: mongo:5.0
    ports:
      - "27017:27017"
    volumes:
      - mongo_data:/data/db
    environment:
      - MONGO_INITDB_DATABASE=collaborative_editor

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data

volumes:
  mongo_data:
  redis_data:
*/

// .env.example
/*
NODE_ENV=development
PORT=3001
CLIENT_URL=http://localhost:3000

# MongoDB
MONGODB_URI=mongodb://localhost:27017/collaborative_editor

# Firebase Admin SDK
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_PRIVATE_KEY_ID=your-private-key-id
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYOUR_PRIVATE_KEY\n-----END PRIVATE KEY-----\n"
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project-id.iam.gserviceaccount.com
FIREBASE_CLIENT_ID=your-client-id

# React App Firebase Config (for client)
REACT_APP_FIREBASE_API_KEY=your-api-key
REACT_APP_FIREBASE_AUTH_DOMAIN=your-project-id.firebaseapp.com
REACT_APP_FIREBASE_PROJECT_ID=your-project-id
REACT_APP_FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com
REACT_APP_FIREBASE_MESSAGING_SENDER_ID=your-sender-id
REACT_APP_FIREBASE_APP_ID=your-app-id

# Server URL for client
REACT_APP_SERVER_URL=http://localhost:3001
*/