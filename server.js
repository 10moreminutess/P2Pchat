// server.js - Standalone WebSocket server for local development
const { WebSocket, WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3001;
const users = new Map();
const waitingUsers = new Set();

// Create HTTP server for serving static files (optional)
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'WebSocket server running',
            users: users.size,
            waiting: waitingUsers.size,
            timestamp: new Date().toISOString()
        }));
        return;
    }
    
    // Serve the HTML file if it exists
    const filePath = path.join(__dirname, 'index.html');
    if (fs.existsSync(filePath) && req.url === '/') {
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                res.writeHead(500);
                res.end('Error loading file');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }
    
    res.writeHead(404);
    res.end('Not found');
});

// Create WebSocket server
const wss = new WebSocketServer({ 
    server,
    verifyClient: (info) => {
        console.log('New connection from:', info.origin || 'unknown origin');
        return true;
    }
});

wss.on('connection', (ws, request) => {
    const clientIP = request.headers['x-forwarded-for'] || request.connection.remoteAddress;
    console.log(`New WebSocket connection from ${clientIP}`);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleMessage(ws, message);
        } catch (error) {
            console.error('Invalid message format:', error);
            safeWSend(ws, { type: 'error', message: 'Invalid message format' });
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`WebSocket closed. Code: ${code}, Reason: ${reason}`);
        handleDisconnection(ws);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        handleDisconnection(ws);
    });

    ws.on('pong', () => {
        if (ws.userId) {
            const user = users.get(ws.userId);
            if (user) {
                user.lastSeen = Date.now();
            }
        }
    });

    // Send current user count
    broadcastUserCount();
});

function safeWSend(ws, data) {
    try {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data));
        }
    } catch (error) {
        console.error('Failed to send WebSocket message:', error);
    }
}

function handleMessage(ws, message) {
    const { type, userId } = message;
    
    console.log(`Received message: ${type} from user: ${userId || 'unknown'}`);
    
    switch (type) {
        case 'join':
            handleUserJoin(ws, message);
            break;
            
        case 'find-match':
            handleFindMatch(ws, message);
            break;
            
        case 'offer':
        case 'answer':
        case 'ice-candidate':
            handleSignalingMessage(ws, message);
            break;
            
        case 'disconnect':
            handleUserDisconnect(ws, message);
            break;
            
        default:
            console.log('Unknown message type:', type);
            safeWSend(ws, { type: 'error', message: 'Unknown message type' });
    }
}

function handleUserJoin(ws, message) {
    const { userId } = message;
    
    if (!userId) {
        safeWSend(ws, { type: 'error', message: 'User ID required' });
        return;
    }
    
    // Remove user if already exists (reconnection)
    if (users.has(userId)) {
        const existingUser = users.get(userId);
        if (existingUser.ws !== ws && existingUser.ws.readyState === WebSocket.OPEN) {
            existingUser.ws.close(1000, 'Reconnected from another session');
        }
        waitingUsers.delete(userId);
    }
    
    // Add new user
    users.set(userId, {
        ws: ws,
        status: 'idle',
        partnerId: null,
        lastSeen: Date.now(),
        joinTime: Date.now()
    });
    
    ws.userId = userId;
    
    console.log(`User ${userId} joined. Total users: ${users.size}`);
    broadcastUserCount();
    
    safeWSend(ws, {
        type: 'joined',
        userId: userId,
        message: 'Successfully connected to server'
    });
}

function handleFindMatch(ws, message) {
    const { userId } = message;
    const user = users.get(userId);
    
    if (!user) {
        safeWSend(ws, { type: 'error', message: 'User not found' });
        return;
    }
    
    // If user is already in a chat, disconnect first
    if (user.partnerId) {
        handleUserDisconnect(ws, { userId, partnerId: user.partnerId });
    }
    
    user.status = 'waiting';
    waitingUsers.add(userId);
    
    console.log(`User ${userId} looking for match. Waiting users: ${waitingUsers.size}`);
    
    // Try to find a match
    const match = findMatch(userId);
    
    if (match) {
        createMatch(userId, match);
    } else {
        safeWSend(ws, {
            type: 'waiting',
            message: 'Waiting for someone to chat with...'
        });
    }
}

function findMatch(userId) {
    for (const waitingUserId of waitingUsers) {
        if (waitingUserId !== userId) {
            const waitingUser = users.get(waitingUserId);
            if (waitingUser && waitingUser.status === 'waiting' && waitingUser.ws.readyState === WebSocket.OPEN) {
                return waitingUserId;
            }
        }
    }
    return null;
}

function createMatch(userId1, userId2) {
    const user1 = users.get(userId1);
    const user2 = users.get(userId2);
    
    if (!user1 || !user2) {
        console.error('Cannot create match: User not found');
        return;
    }
    
    // Remove from waiting list
    waitingUsers.delete(userId1);
    waitingUsers.delete(userId2);
    
    // Update user status
    user1.status = 'matched';
    user1.partnerId = userId2;
    user2.status = 'matched';
    user2.partnerId = userId1;
    
    // Randomly decide who initiates the WebRTC connection
    const user1Initiates = Math.random() < 0.5;
    
    // Notify both users
    safeWSend(user1.ws, {
        type: 'matched',
        partnerId: userId2,
        isInitiator: user1Initiates
    });
    
    safeWSend(user2.ws, {
        type: 'matched',
        partnerId: userId1,
        isInitiator: !user1Initiates
    });
    
    console.log(`✅ Matched users: ${userId1} (initiator: ${user1Initiates}) <-> ${userId2} (initiator: ${!user1Initiates})`);
}

function handleSignalingMessage(ws, message) {
    const { to, type } = message;
    
    if (!to) {
        safeWSend(ws, { type: 'error', message: 'Target user ID required' });
        return;
    }
    
    const targetUser = users.get(to);
    
    if (!targetUser || targetUser.ws.readyState !== WebSocket.OPEN) {
        safeWSend(ws, { 
            type: 'error', 
            message: 'Target user not found or not connected' 
        });
        return;
    }
    
    // Forward the signaling message
    const forwardedMessage = {
        ...message,
        from: ws.userId
    };
    
    safeWSend(targetUser.ws, forwardedMessage);
    console.log(`📡 Forwarded ${type} from ${ws.userId} to ${to}`);
}

function handleUserDisconnect(ws, message) {
    const { userId, partnerId } = message;
    const user = users.get(userId);
    
    if (!user) return;
    
    const partnerIdToNotify = partnerId || user.partnerId;
    
    // Notify partner if exists
    if (partnerIdToNotify) {
        const partner = users.get(partnerIdToNotify);
        
        if (partner) {
            partner.partnerId = null;
            partner.status = 'idle';
            
            safeWSend(partner.ws, {
                type: 'partner-disconnected',
                message: 'Your chat partner disconnected'
            });
            
            console.log(`🔌 Notified ${partnerIdToNotify} that ${userId} disconnected`);
        }
    }
    
    // Reset user status
    user.status = 'idle';
    user.partnerId = null;
    waitingUsers.delete(userId);
    
    console.log(`User ${userId} disconnected from chat`);
}

function handleDisconnection(ws) {
    if (!ws.userId) return;
    
    const userId = ws.userId;
    const user = users.get(userId);
    
    if (user) {
        // Notify partner if exists
        if (user.partnerId) {
            handleUserDisconnect(ws, { userId, partnerId: user.partnerId });
        }
        
        // Remove user
        users.delete(userId);
        waitingUsers.delete(userId);
        
        console.log(`❌ User ${userId} fully disconnected. Total users: ${users.size}`);
        broadcastUserCount();
    }
}

function broadcastUserCount() {
    const count = users.size;
    const waitingCount = waitingUsers.size;
    const message = {
        type: 'user-count',
        count: count,
        waiting: waitingCount
    };
    
    users.forEach((user) => {
        safeWSend(user.ws, message);
    });
}

function cleanupConnections() {
    const now = Date.now();
    const timeout = 300000; // 5 minutes timeout
    const disconnectedUsers = [];
    
    users.forEach((user, userId) => {
        // Check if connection is still alive
        if (user.ws.readyState !== WebSocket.OPEN) {
            disconnectedUsers.push(userId);
        } else if (now - user.lastSeen > timeout) {
            console.log(`User ${userId} timed out`);
            user.ws.close(1000, 'Connection timeout');
            disconnectedUsers.push(userId);
        } else {
            // Send ping to keep connection alive
            try {
                user.ws.ping();
            } catch (error) {
                console.error('Failed to ping user:', userId, error);
                disconnectedUsers.push(userId);
            }
        }
    });
    
    // Remove disconnected users
    disconnectedUsers.forEach(userId => {
        const user = users.get(userId);
        if (user) {
            handleDisconnection(user.ws);
        }
    });
    
    if (disconnectedUsers.length > 0) {
        console.log(`🧹 Cleaned up ${disconnectedUsers.length} disconnected users. Active: ${users.size}, Waiting: ${waitingUsers.size}`);
    }
}

// Start cleanup interval
setInterval(cleanupConnections, 60000); // Every minute

// Start the server
server.listen(PORT, () => {
    console.log(`🚀 WebSocket server running on port ${PORT}`);
    console.log(`📊 Health check available at http://localhost:${PORT}/health`);
    console.log(`🌐 WebSocket endpoint: ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down WebSocket server...');
    
    // Close all WebSocket connections
    users.forEach((user) => {
        try {
            user.ws.close(1001, 'Server shutting down');
        } catch (error) {
            console.error('Error closing WebSocket:', error);
        }
    });
    
    // Close the server
    server.close(() => {
        console.log('✅ Server closed successfully');
        process.exit(0);
    });
    
    // Force exit after 5 seconds
    setTimeout(() => {
        console.log('⚠️  Forcing server shutdown');
        process.exit(1);
    }, 5000);
});

module.exports = { server, wss };
