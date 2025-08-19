// api/signaling.js - Server-Sent Events signaling for Vercel
let users = new Map();
let waitingUsers = new Set();
let connections = new Map(); // userId -> response object

// Store in memory (in production, you'd use Redis or similar)
const storage = {
  users: new Map(),
  waiting: new Set(),
  matches: new Map() // userId -> partnerId
};

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { method, url } = req;
  const urlParts = url.split('?');
  const path = urlParts[0];
  const params = new URLSearchParams(urlParts[1] || '');

  if (method === 'GET' && path === '/api/signaling') {
    // Server-Sent Events endpoint
    const userId = params.get('userId');
    
    if (!userId) {
      res.status(400).json({ error: 'userId required' });
      return;
    }

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    // Store connection
    storage.users.set(userId, {
      response: res,
      status: 'idle',
      partnerId: null,
      lastSeen: Date.now()
    });
    
    // Send initial message
    sendSSE(res, 'connected', { userId, message: 'Connected to signaling server' });
    sendUserCount();
    
    // Handle client disconnect
    req.on('close', () => {
      handleUserDisconnect(userId);
    });
    
    // Keep connection alive
    const keepAlive = setInterval(() => {
      try {
        sendSSE(res, 'ping', { timestamp: Date.now() });
      } catch (error) {
        clearInterval(keepAlive);
      }
    }, 30000);
    
    req.on('close', () => {
      clearInterval(keepAlive);
    });
    
    return; // Keep connection open
  }

  if (method === 'POST') {
    const body = await getBody(req);
    const data = JSON.parse(body);
    
    switch (path) {
      case '/api/signaling/find-match':
        return handleFindMatch(req, res, data);
        
      case '/api/signaling/signal':
        return handleSignalMessage(req, res, data);
        
      case '/api/signaling/disconnect':
        return handleDisconnect(req, res, data);
        
      default:
        res.status(404).json({ error: 'Endpoint not found' });
    }
  } else if (method === 'GET' && path === '/api/signaling/status') {
    // Health check endpoint
    res.status(200).json({
      status: 'online',
      users: storage.users.size,
      waiting: storage.waiting.size,
      timestamp: new Date().toISOString(),
      server: 'real'
    });
  } else {
    res.status(405).json({ error: 'Method not allowed' });
  }
}

function sendSSE(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (error) {
    console.error('Failed to send SSE:', error);
  }
}

function sendToUser(userId, event, data) {
  const user = storage.users.get(userId);
  if (user && user.response) {
    sendSSE(user.response, event, data);
  }
}

function sendUserCount() {
  const count = storage.users.size;
  const data = { count, waiting: storage.waiting.size };
  
  storage.users.forEach((user, userId) => {
    sendToUser(userId, 'user-count', data);
  });
}

async function handleFindMatch(req, res, data) {
  const { userId } = data;
  const user = storage.users.get(userId);
  
  if (!user) {
    res.status(400).json({ error: 'User not found - please refresh the page' });
    return;
  }
  
  // If already matched, disconnect first
  if (user.partnerId) {
    handleUserDisconnectInternal(userId);
  }
  
  user.status = 'waiting';
  storage.waiting.add(userId);
  
  // Try to find a match
  const match = findMatch(userId);
  
  if (match) {
    createMatch(userId, match);
    res.status(200).json({ matched: true, partnerId: match });
  } else {
    sendToUser(userId, 'waiting', { message: 'Waiting for match...' });
    res.status(200).json({ waiting: true });
  }
}

function findMatch(userId) {
  for (const waitingUserId of storage.waiting) {
    if (waitingUserId !== userId) {
      const waitingUser = storage.users.get(waitingUserId);
      if (waitingUser && waitingUser.status === 'waiting') {
        return waitingUserId;
      }
    }
  }
  return null;
}

function createMatch(userId1, userId2) {
  const user1 = storage.users.get(userId1);
  const user2 = storage.users.get(userId2);
  
  if (!user1 || !user2) return;
  
  // Remove from waiting
  storage.waiting.delete(userId1);
  storage.waiting.delete(userId2);
  
  // Update status
  user1.status = 'matched';
  user1.partnerId = userId2;
  user2.status = 'matched';
  user2.partnerId = userId1;
  
  // Decide initiator (randomly)
  const user1Initiates = Math.random() < 0.5;
  
  // Notify users
  sendToUser(userId1, 'matched', {
    partnerId: userId2,
    isInitiator: user1Initiates
  });
  
  sendToUser(userId2, 'matched', {
    partnerId: userId1,
    isInitiator: !user1Initiates
  });
  
  console.log(`✅ Matched: ${userId1} <-> ${userId2}`);
  sendUserCount();
}

async function handleSignalMessage(req, res, data) {
  const { from, to, type, offer, answer, candidate } = data;
  
  const targetUser = storage.users.get(to);
  if (!targetUser) {
    res.status(400).json({ error: 'Target user not found' });
    return;
  }
  
  // Forward the WebRTC signal
  sendToUser(to, 'signal', {
    from,
    type,
    offer,
    answer,
    candidate
  });
  
  console.log(`📡 Forwarded ${type} from ${from} to ${to}`);
  res.status(200).json({ sent: true });
}

async function handleDisconnect(req, res, data) {
  const { userId } = data;
  handleUserDisconnectInternal(userId);
  res.status(200).json({ disconnected: true });
}

function handleUserDisconnectInternal(userId) {
  const user = storage.users.get(userId);
  if (!user) return;
  
  // Notify partner
  if (user.partnerId) {
    const partner = storage.users.get(user.partnerId);
    if (partner) {
      partner.partnerId = null;
      partner.status = 'idle';
      sendToUser(user.partnerId, 'partner-disconnected', {
        message: 'Partner disconnected'
      });
    }
  }
  
  // Clean up
  user.status = 'idle';
  user.partnerId = null;
  storage.waiting.delete(userId);
  
  console.log(`🔌 User ${userId} disconnected from partner`);
  sendUserCount();
}

function handleUserDisconnect(userId) {
  handleUserDisconnectInternal(userId);
  storage.users.delete(userId);
  sendUserCount();
  console.log(`👋 User ${userId} left completely`);
}

// Clean up inactive connections every 5 minutes
setInterval(() => {
  const now = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutes
  
  for (const [userId, user] of storage.users.entries()) {
    if (now - user.lastSeen > timeout) {
      console.log(`🧹 Cleaning up inactive user: ${userId}`);
      handleUserDisconnect(userId);
    }
  }
}, 60000); // Check every minute

async function getBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
  });
}
