// api/websocket.js - Vercel Serverless WebSocket Handler
const { WebSocket, WebSocketServer } = require('ws');

let wss = null;
const users = new Map(); // userId -> { ws, status, partnerId }
const waitingUsers = new Set(); // Users looking for matches

// Initialize WebSocket server
function initWebSocketServer() {
    if (wss) return wss;
    
    wss = new WebSocketServer({ 
        port: process.env.WS_PORT || 3001,
        verifyClient: (info) => {
            // Allow all origins in development, restrict in production
            return true;
        }
    });

    wss.on('connection', (ws, request) => {
        console.log('New WebSocket connection');
        
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                handleMessage(ws, message);
            } catch (error) {
                console.error('Invalid message format:', error);
                ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
            }
        });

        ws.on('close', () => {
            handleDisconnection(ws);
        });

        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            handleDisconnection(ws);
        });

        // Send current user count
        broadcastUserCount();
    });

    // Cleanup inactive connections periodically
    setInterval(cleanupConnections, 30000);
    
    console.log(`WebSocket server listening on port ${process.env.WS_PORT || 3001}`);
    return wss;
}

function handleMessage(ws, message) {
    const { type, userId } = message;
    
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
            ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
    }
}

function handleUserJoin(ws, message) {
    const { userId } = message;
    
    // Remove user if already exists (reconnection)
    if (users.has(userId)) {
        const existingUser = users.get(userId);
        if (existingUser.ws !== ws) {
            existingUser.ws.close();
        }
        waitingUsers.delete(userId);
    }
    
    // Add new user
    users.set(userId, {
        ws: ws,
        status: 'idle',
        partnerId: null,
        lastSeen: Date.now()
    });
    
    ws.userId = userId;
    
    console.log(`User ${userId} joined. Total users: ${users.size}`);
    broadcastUserCount();
    
    ws.send(JSON.stringify({
        type: 'joined',
        userId: userId,
        message: 'Successfully connected to server'
    }));
}

function handleFindMatch(ws, message) {
    const { userId } = message;
    const user = users.get(userId);
    
    if (!user) {
        ws.send(JSON.stringify({ type: 'error', message: 'User not found' }));
        return;
    }
    
    // If user is already in a chat, disconnect first
    if (user.partnerId) {
        handleUserDisconnect(ws, { userId, partnerId: user.partnerId });
    }
    
    user.status = 'waiting';
    waitingUsers.add(userId);
    
    // Try to find a match
    const match = findMatch(userId);
    
    if (match) {
        createMatch(userId, match);
    } else {
        ws.send(JSON.stringify({
            type: 'waiting',
            message: 'Waiting for someone to chat with...'
        }));
    }
}

function findMatch(userId) {
    // Find another waiting user (exclude current user)
    for (const waitingUserId of waitingUsers) {
        if (waitingUserId !== userId) {
            const waitingUser = users.get(waitingUserId);
            if (waitingUser && waitingUser.status === 'waiting') {
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
    user1.ws.send(JSON.stringify({
        type: 'matched',
        partnerId: userId2,
        isInitiator: user1Initiates
    }));
    
    user2.ws.send(JSON.stringify({
        type: 'matched',
        partnerId: userId1,
        isInitiator: !user1Initiates
    }));
    
    console.log(`Matched users: ${userId1} (initiator: ${user1Initiates}) <-> ${userId2} (initiator: ${!user1Initiates})`);
}

function handleSignalingMessage(ws, message) {
    const { to, type } = message;
    const targetUser = users.get(to);
    
    if (!targetUser) {
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Target user not found' 
        }));
        return;
    }
    
    // Forward the signaling message
    const forwardedMessage = {
        ...message,
        from: ws.userId
    };
    
    try {
        targetUser.ws.send(JSON.stringify(forwardedMessage));
    } catch (error) {
        console.error('Failed to forward message:', error);
        ws.send(JSON.stringify({ 
            type: 'error', 
            message: 'Failed to deliver message' 
        }));
    }
}

function handleUserDisconnect(ws, message) {
    const { userId, partnerId } = message;
    const user = users.get(userId);
    
    if (!user) return;
    
    // Notify partner if exists
    if (partnerI
