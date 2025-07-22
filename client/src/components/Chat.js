import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './Chat.css';
// import 'font-awesome/css/font-awesome.min.css';

const Chat = ({ username, onLogout }) => {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [users, setUsers] = useState([]);
  const [typingUsers, setTypingUsers] = useState(new Map());
  const [isTyping, setIsTyping] = useState(false);
  const messagesEndRef = useRef(null);
  const typingTimeoutRef = useRef(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const socketRef = useRef(null);
  const [userOrder, setUserOrder] = useState([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 1. Only create the socket connection once per username
  useEffect(() => {
    const socket = io('http://localhost:5000');
    socketRef.current = socket;

    if (username && window._password) {
      socket.emit('login', { username, password: window._password });
    }

    socket.on('chatHistory', (history) => setMessages(history));
    socket.on('userList', (userList) => setUsers(userList.filter(u => u.username !== username)));
    socket.on('userTyping', (data) => {
      setTypingUsers(prev => {
        const newMap = new Map(prev);
        if (data.isTyping) {
          newMap.set(data.socketId, data.username || 'Someone');
        } else {
          newMap.delete(data.socketId);
        }
        return newMap;
      });
    });
    socket.on('privateMessages', (msgs) => setMessages(msgs));
    socket.on('message', (message) => {
      if (
        message.type === 'user' &&
        ((message.sender === username && message.recipient === selectedUser?.username) ||
         (message.sender === selectedUser?.username && message.recipient === username))
      ) {
        setMessages(prev => [...prev, message]);
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [username, selectedUser]);

  // 2. Fetch all users only once per username
  useEffect(() => {
    fetch('http://localhost:5000/all-users')
      .then(res => res.json())
      .then(data => setUsers(data.filter(u => u.username !== username)))
      .catch(err => console.error('Failed to fetch users:', err));
  }, [username]);

  // 3. Fetch private messages when selectedUser changes
  useEffect(() => {
    if (socketRef.current && selectedUser) {
      socketRef.current.emit('getPrivateMessages', { withUser: selectedUser.username });
    }
  }, [selectedUser, username]);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Update user order when a message is sent or received
  useEffect(() => {
    if (messages.length && selectedUser) {
      setUserOrder(prev => {
        const filtered = prev.filter(u => u !== selectedUser.username);
        return [selectedUser.username, ...filtered];
      });
    }
  }, [messages, selectedUser]);

  // Also update order when a user is selected (even if no message yet)
  const handleSelectUser = (user) => {
    setSelectedUser(user);
    setUserOrder(prev => {
      const filtered = prev.filter(u => u !== user.username);
      return [user.username, ...filtered];
    });
  };

  // Sort users by most recently messaged or selected
  const sortedUsers = [
    ...userOrder
      .map(username => users.find(u => u.username === username))
      .filter(Boolean),
    ...users.filter(u => !userOrder.includes(u.username))
  ];

  const handleSendMessage = (e) => {
    e.preventDefault();
    if (newMessage.trim() && socketRef.current && selectedUser) {
      socketRef.current.emit('sendMessage', { content: newMessage.trim(), recipient: selectedUser.username });
      setNewMessage('');
      setIsTyping(false);
      socketRef.current.emit('typing', false);
    }
  };

  const handleTyping = (e) => {
    setNewMessage(e.target.value);
    
    if (!isTyping) {
      setIsTyping(true);
      socketRef.current?.emit('typing', true);
    }

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Set new timeout to stop typing indicator
    typingTimeoutRef.current = setTimeout(() => {
      setIsTyping(false);
      socketRef.current?.emit('typing', false);
    }, 1000);
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  };

  const getTypingIndicator = () => {
    const typingCount = typingUsers.size;
    if (typingCount === 0) return null;
    const typingNames = Array.from(typingUsers.values());
    if (typingCount === 1) {
      return <div className="typing-indicator">{typingNames[0]} is typing...</div>;
    } else {
      return <div className="typing-indicator">{typingNames.join(', ')} are typing...</div>;
    }
  };

  // For mobile: open sidebar when hamburger is clicked
  const handleHamburgerClick = () => setSidebarOpen(true);
  const handleSidebarClose = () => setSidebarOpen(false);

  return (
    <div className="chat-container">
      {/* Header */}
      <div className="chat-header">
        <div className="header-info">
        <span className="hamburger" onClick={handleHamburgerClick}>
          <i className="fa fa-bars"></i>
        </span>
          <div>
          <h2>ChatApp</h2>
          <p>Welcome, {username}!</p></div>
        </div>
        <div className="header-actions">
          {/* Hamburger for mobile */}
          
          <span className="online-status">
            <span className="status-dot"></span>
            {users.length} online
          </span>
          <button onClick={onLogout} className="logout-button">
            Logout
          </button>
        </div>
      </div>

      <div className="chat-main">
        {/* Users Sidebar (desktop) */}
        <div className="users-sidebar users-sidebar-desktop">
          <h3>All Users ({users.length})</h3>
          <div className="users-list">
            {sortedUsers.map(user => (
              <div
                key={user.username}
                className={`user-item${selectedUser?.username === user.username ? ' selected' : ''}`}
                onClick={() => {
                  setSelectedUser(user);
                  setSidebarOpen(false);
                }}
              >
                <span className="user-avatar">
                  {user.username.charAt(0).toUpperCase()}
                </span>
                <span className="user-name">{user.username}</span>
                <span className={`online-indicator${user.isOnline ? ' online' : ' offline'}`}></span>
              </div>
            ))}
          </div>
        </div>
        {/* Users Sidebar (mobile overlay) */}
        {sidebarOpen && (
          <div className="sidebar-overlay" onClick={handleSidebarClose}>
            <div className="users-sidebar users-sidebar-mobile" onClick={e => e.stopPropagation()}>
              <button className="close-sidebar" onClick={handleSidebarClose}>&times;</button>
              <h3>All Users ({users.length})</h3>
              <div className="users-list">
                {sortedUsers.map(user => (
                  <div
                    key={user.username}
                    className={`user-item${selectedUser?.username === user.username ? ' selected' : ''}`}
                    onClick={() => {
                      setSelectedUser(user);
                      setSidebarOpen(false);
                    }}
                  >
                    <span className="user-avatar">
                      {user.username.charAt(0).toUpperCase()}
                    </span>
                    <span className="user-name">{user.username}</span>
                    <span className={`online-indicator${user.isOnline ? ' online' : ' offline'}`}></span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Chat Area */}
        <div className="chat-area">
          {/* Messages */}
          <div className="messages-container">
            {selectedUser ? (
              [...messages]
                .filter(
                  (message) =>
                    message.type === 'user' &&
                    ((message.sender === username && message.recipient === selectedUser.username) ||
                     (message.sender === selectedUser.username && message.recipient === username))
                )
                .map((message, index) => {
                  const isSelf = message.sender === username;
                  return (
                    <div
                      key={message._id || index}
                      className={`message ${isSelf ? 'user-message self' : 'user-message other'}`}
                    >
                      {!isSelf && (
                        <div className="message-header">
                          {/* <span className="message-username">{message.sender}</span> */}
                          <span className="message-time">{formatTime(message.timestamp)}</span>
                        </div>
                      )}
                      {isSelf && (
                        <div className="message-header self">
                          <span className="message-time">{formatTime(message.timestamp)}</span>
                        </div>
                      )}
                      <div className="message-content">{message.content}</div>
                    </div>
                  );
                })
            ) : (
              <div className="no-chat">Select a user to start chatting</div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Typing Indicator (per chat) */}
          {getTypingIndicator()}

          {/* Message Input */}
          <form onSubmit={handleSendMessage} className="message-input-container">
            <input
              type="text"
              value={newMessage}
              onChange={handleTyping}
              placeholder={selectedUser ? `Message ${selectedUser.username}...` : 'Select a user to chat'}
              className="message-input"
              disabled={!socketRef.current || !selectedUser}
            />
            <button 
              type="submit" 
              className="send-button"
              disabled={!newMessage.trim() || !socketRef.current || !selectedUser}
            >
              Send
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default Chat; 