const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
// Try /data first (Suga volume), fall back to local
const PERSIST_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const DATA_FILE = path.join(PERSIST_DIR, 'server-data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');
const CHAT_FILE = path.join(__dirname, 'basic-chatting.html');

// ===== Data Store =====
let data = {
  accounts: {},       // { name_lower: { name, pass, createdAt } }
  friends: {},        // { name_lower: { friendId: { name, addedAt } } }
  friendRequests: {}, // { name_lower: [{ id, name, ts }] }
  messages: [],       // [{ fromId, fromName, toId, text, ts }]
  groups: {},         // { groupId: { name, ownerId, members: { id: { name, role } }, createdAt } }
  groupMessages: {},  // { groupId: [{ fromId, fromName, text, ts }] }
  groupInvites: {},   // { name_lower: [{ groupId, groupName, fromId, fromName, ts }] }
  moments: [],        // [{ id, authorId, authorName, authorAvatar, text, image, ts, likes: [], comments: [] }]
  avatars: {}         // { name_lower: { type, value } }
};

// In-memory session tracking
const clients = new Map(); // ws -> { id, name, nameLower }
const onlineUsers = new Map(); // nameLower -> { id, name, avatar, ws }

// ===== Persistence =====
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      data = { ...data, ...loaded };
      console.log(`[Data] Loaded ${Object.keys(data.accounts).length} accounts`);
    }
  } catch (e) {
    console.error('[Data] Load error:', e.message);
  }
}

function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Data] Save error:', e.message);
  }
}

// Auto-save every 30 seconds
setInterval(saveData, 30000);

// ===== Helpers =====
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) { hash = ((hash << 5) - hash) + str.charCodeAt(i); hash |= 0; }
  return 'h' + Math.abs(hash).toString(36);
}

function sendJSON(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcastTo(ws, obj) {
  sendJSON(ws, obj);
}

// ===== Message Handlers =====
function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  const { type } = msg;

  switch (type) {
    case 'register': handleRegister(ws, msg); break;
    case 'login': handleLogin(ws, msg); break;
    case 'join': handleJoin(ws, msg); break;
    case 'leave': handleLeave(ws); break;
    case 'heartbeat': handleHeartbeat(ws); break;
    case 'avatar_update': handleAvatarUpdate(ws, msg); break;
    case 'friend_request': handleFriendRequest(ws, msg); break;
    case 'friend_accept': handleFriendAccept(ws, msg); break;
    case 'friend_reject': handleFriendReject(ws, msg); break;
    case 'friend_removed': handleFriendRemove(ws, msg); break;
    case 'chat': handleChat(ws, msg); break;
    case 'group_create': handleGroupCreate(ws, msg); break;
    case 'group_chat': handleGroupChat(ws, msg); break;
    case 'group_invite': handleGroupInvite(ws, msg); break;
    case 'group_accept': handleGroupAccept(ws, msg); break;
    case 'group_leave': handleGroupLeave(ws, msg); break;
    case 'moment_post': handleMomentPost(ws, msg); break;
    case 'moment_like': handleMomentLike(ws, msg); break;
    case 'moment_comment': handleMomentComment(ws, msg); break;
    case 'change_password': handleChangePassword(ws, msg); break;
    case 'delete_account': handleDeleteAccount(ws, msg); break;
    case 'request_users': handleRequestUsers(ws); break;
    default: break;
  }
}

// ===== Auth =====
function handleRegister(ws, msg) {
  const { name, pass } = msg;
  if (!name || !pass) { sendJSON(ws, { type: 'register_result', ok: false, error: '参数不完整' }); return; }
  const nameLower = name.toLowerCase();
  if (data.accounts[nameLower]) { sendJSON(ws, { type: 'register_result', ok: false, error: '该用户名已被注册' }); return; }
  if (name.length < 2) { sendJSON(ws, { type: 'register_result', ok: false, error: '用户名至少2个字符' }); return; }
  if (pass.length < 4) { sendJSON(ws, { type: 'register_result', ok: false, error: '密码至少4位' }); return; }

  data.accounts[nameLower] = { name, pass: simpleHash(pass), createdAt: Date.now() };
  saveData();
  sendJSON(ws, { type: 'register_result', ok: true });
  console.log(`[Auth] Registered: ${name}`);
}

function handleLogin(ws, msg) {
  const { name, pass } = msg;
  if (!name || !pass) { sendJSON(ws, { type: 'login_result', ok: false, error: '参数不完整' }); return; }
  const nameLower = name.toLowerCase();
  const acct = data.accounts[nameLower];
  if (!acct) { sendJSON(ws, { type: 'login_result', ok: false, error: '用户不存在' }); return; }
  if (acct.pass !== simpleHash(pass)) { sendJSON(ws, { type: 'login_result', ok: false, error: '密码错误' }); return; }

  // Check if already logged in
  if (onlineUsers.has(nameLower)) {
    sendJSON(ws, { type: 'login_result', ok: false, error: '该账号已在其他设备登录' });
    return;
  }

  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
  const avatar = data.avatars[nameLower] || null;

  clients.set(ws, { id, name: acct.name, nameLower });
  onlineUsers.set(nameLower, { id, name: acct.name, avatar, ws });

  // Load user data
  const userFriends = data.friends[nameLower] || {};
  const userFriendRequests = data.friendRequests[nameLower] || [];
  const userGroups = {};
  for (const gid in data.groups) {
    if (data.groups[gid].members[id]) userGroups[gid] = data.groups[gid];
  }
  const userGroupInvites = data.groupInvites[nameLower] || [];

  sendJSON(ws, {
    type: 'login_result', ok: true, id, name: acct.name, avatar,
    friends: userFriends,
    friendRequests: userFriendRequests,
    groups: userGroups,
    groupInvites: userGroupInvites,
    messages: data.messages,
    groupMessages: data.groupMessages,
    moments: data.moments,
    avatars: data.avatars
  });

  // Notify others
  broadcastOnlineUsers(nameLower);
  console.log(`[Auth] Logged in: ${name} (${id})`);
}

function handleChangePassword(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { oldPass, newPass } = msg;
  const acct = data.accounts[client.nameLower];
  if (!acct || acct.pass !== simpleHash(oldPass)) {
    sendJSON(ws, { type: 'change_password_result', ok: false, error: '当前密码错误' });
    return;
  }
  if (newPass.length < 4) {
    sendJSON(ws, { type: 'change_password_result', ok: false, error: '新密码至少4位' });
    return;
  }
  acct.pass = simpleHash(newPass);
  saveData();
  sendJSON(ws, { type: 'change_password_result', ok: true });
}

function handleDeleteAccount(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { pass } = msg;
  const acct = data.accounts[client.nameLower];
  if (!acct || acct.pass !== simpleHash(pass)) {
    sendJSON(ws, { type: 'delete_account_result', ok: false, error: '密码错误' });
    return;
  }

  const nameLower = client.nameLower;

  // Remove from all friend lists
  for (const fl in data.friends) {
    delete data.friends[fl][nameLower];
  }
  // Remove from all groups
  for (const gid in data.groups) {
    delete data.groups[gid].members[nameLower];
    if (Object.keys(data.groups[gid].members).length === 0) {
      delete data.groups[gid];
      delete data.groupMessages[gid];
    }
  }

  delete data.accounts[nameLower];
  delete data.friends[nameLower];
  delete data.friendRequests[nameLower];
  delete data.groupInvites[nameLower];
  delete data.avatars[nameLower];

  onlineUsers.delete(nameLower);
  clients.delete(ws);
  saveData();

  sendJSON(ws, { type: 'delete_account_result', ok: true });
  broadcastOnlineUsers();
  console.log(`[Auth] Account deleted: ${client.name}`);
}

// ===== Online Status =====
function handleJoin(ws, msg) {
  // Already handled by login
}

function handleHeartbeat(ws) {
  const client = clients.get(ws);
  if (!client) return;
  const user = onlineUsers.get(client.nameLower);
  if (user) {
    broadcastOnlineUsers(client.nameLower);
  }
}

function handleLeave(ws) {
  disconnectClient(ws);
}

function handleRequestUsers(ws) {
  broadcastOnlineUsers();
}

function disconnectClient(ws) {
  const client = clients.get(ws);
  if (!client) return;
  onlineUsers.delete(client.nameLower);
  clients.delete(ws);
  broadcastOnlineUsers();
  console.log(`[Conn] Disconnected: ${client.name}`);
}

function broadcastOnlineUsers(excludeNameLower) {
  const users = [];
  for (const [nameLower, u] of onlineUsers) {
    users.push({ id: u.id, name: u.name, online: true, avatar: u.avatar });
  }

  const msg = { type: 'online_users', users };
  for (const [nameLower, u] of onlineUsers) {
    sendJSON(u.ws, msg);
  }
}

// ===== Avatar =====
function handleAvatarUpdate(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  data.avatars[client.nameLower] = msg.avatar || null;
  const user = onlineUsers.get(client.nameLower);
  if (user) user.avatar = msg.avatar;
  saveData();
  broadcastOnlineUsers();
}

// ===== Friends =====
function handleFriendRequest(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { targetName } = msg;
  if (!targetName) return;

  const targetLower = targetName.toLowerCase();
  if (targetLower === client.nameLower) {
    sendJSON(ws, { type: 'friend_request_result', ok: false, error: '不能添加自己' });
    return;
  }
  if (!data.accounts[targetLower]) {
    sendJSON(ws, { type: 'friend_request_result', ok: false, error: '用户不存在' });
    return;
  }
  const myFriends = data.friends[client.nameLower] || {};
  if (myFriends[targetLower]) {
    sendJSON(ws, { type: 'friend_request_result', ok: false, error: '已经是好友' });
    return;
  }

  if (!data.friendRequests[targetLower]) data.friendRequests[targetLower] = [];
  const existing = data.friendRequests[targetLower].find(r => r.nameLower === client.nameLower);
  if (existing) {
    sendJSON(ws, { type: 'friend_request_result', ok: false, error: '已发送过请求' });
    return;
  }

  data.friendRequests[targetLower].push({
    id: client.id,
    name: client.name,
    nameLower: client.nameLower,
    ts: Date.now()
  });
  saveData();

  sendJSON(ws, { type: 'friend_request_result', ok: true });

  // Notify target if online
  const target = onlineUsers.get(targetLower);
  if (target) {
    sendJSON(target.ws, {
      type: 'friend_requests_updated',
      requests: data.friendRequests[targetLower] || []
    });
  }
}

function handleFriendAccept(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { fromNameLower } = msg;
  if (!fromNameLower) return;

  const reqs = data.friendRequests[client.nameLower] || [];
  const req = reqs.find(r => r.nameLower === fromNameLower);
  if (!req) return;

  // Add to both friend lists
  if (!data.friends[client.nameLower]) data.friends[client.nameLower] = {};
  if (!data.friends[fromNameLower]) data.friends[fromNameLower] = {};
  data.friends[client.nameLower][fromNameLower] = { name: req.name, addedAt: Date.now() };
  data.friends[fromNameLower][client.nameLower] = { name: client.name, addedAt: Date.now() };

  // Remove request
  data.friendRequests[client.nameLower] = reqs.filter(r => r.nameLower !== fromNameLower);
  saveData();

  sendJSON(ws, {
    type: 'friends_updated',
    friends: data.friends[client.nameLower] || {},
    friendRequests: data.friendRequests[client.nameLower] || []
  });

  const other = onlineUsers.get(fromNameLower);
  if (other) {
    sendJSON(other.ws, {
      type: 'friends_updated',
      friends: data.friends[fromNameLower] || {},
      friendRequests: data.friendRequests[fromNameLower] || []
    });
    sendJSON(other.ws, { type: 'toast', text: req.name + ' 接受了你的好友请求' });
  }
}

function handleFriendReject(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { fromNameLower } = msg;
  if (!fromNameLower) return;

  data.friendRequests[client.nameLower] = (data.friendRequests[client.nameLower] || []).filter(r => r.nameLower !== fromNameLower);
  saveData();

  sendJSON(ws, {
    type: 'friend_requests_updated',
    requests: data.friendRequests[client.nameLower] || []
  });
}

function handleFriendRemove(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { friendNameLower } = msg;
  if (!friendNameLower) return;

  if (data.friends[client.nameLower]) delete data.friends[client.nameLower][friendNameLower];
  if (data.friends[friendNameLower]) delete data.friends[friendNameLower][client.nameLower];
  saveData();

  sendJSON(ws, {
    type: 'friends_updated',
    friends: data.friends[client.nameLower] || {},
    friendRequests: data.friendRequests[client.nameLower] || []
  });

  const other = onlineUsers.get(friendNameLower);
  if (other) {
    sendJSON(other.ws, {
      type: 'friends_updated',
      friends: data.friends[friendNameLower] || {},
      friendRequests: data.friendRequests[friendNameLower] || []
    });
  }
}

// ===== Chat =====
function handleChat(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { toId, text, toNameLower } = msg;
  if (!toId || !text) return;

  const chatMsg = { fromId: client.id, fromName: client.name, toId, text, ts: Date.now() };
  data.messages.push(chatMsg);
  if (data.messages.length > 1000) data.messages = data.messages.slice(-1000);
  saveData();

  // Send to recipient if online
  const target = toNameLower ? onlineUsers.get(toNameLower) : null;
  if (target) {
    sendJSON(target.ws, { type: 'chat', fromId: client.id, fromName: client.name, text, ts: chatMsg.ts });
  }
  // Echo back to sender
  sendJSON(ws, { type: 'chat_sent', msg: chatMsg });
}

// ===== Groups =====
function handleGroupCreate(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { name, memberIds } = msg;
  if (!name || !memberIds || memberIds.length === 0) {
    sendJSON(ws, { type: 'group_create_result', ok: false, error: '参数不完整' });
    return;
  }

  const groupId = 'g_' + Date.now().toString(36) + Math.random().toString(36).substr(2, 4);
  const members = {};
  members[client.nameLower] = { id: client.id, name: client.name, role: 'owner' };

  const invitedLower = [];
  for (const fid of memberIds) {
    // Find friend by id
    const myFriends = data.friends[client.nameLower] || {};
    for (const fl in myFriends) {
      // We need to know the nameLower. Let's use the accounts to find it.
    }
    // For now, we'll use a different approach - pass nameLower pairs
    invitedLower.push(fid);
  }

  data.groups[groupId] = { name, ownerId: client.id, ownerName: client.name, members, createdAt: Date.now() };
  data.groupMessages[groupId] = [];

  // Send invites to selected friends
  for (const fl of invitedLower) {
    if (!data.groupInvites[fl]) data.groupInvites[fl] = [];
    data.groupInvites[fl].push({
      groupId, groupName: name, fromId: client.id, fromName: client.name, ts: Date.now()
    });
    const target = onlineUsers.get(fl);
    if (target) {
      sendJSON(target.ws, {
        type: 'group_invites_updated',
        groupInvites: data.groupInvites[fl] || []
      });
    }
  }

  saveData();

  sendJSON(ws, {
    type: 'group_create_result', ok: true, groupId,
    group: { name, ownerId: client.id, members, createdAt: Date.now() }
  });
}

function handleGroupChat(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { groupId, text } = msg;
  if (!groupId || !text) return;

  const group = data.groups[groupId];
  if (!group) return;
  if (!group.members[client.nameLower]) return;

  const chatMsg = { fromId: client.id, fromName: client.name, text, ts: Date.now() };
  if (!data.groupMessages[groupId]) data.groupMessages[groupId] = [];
  data.groupMessages[groupId].push(chatMsg);
  if (data.groupMessages[groupId].length > 500) data.groupMessages[groupId] = data.groupMessages[groupId].slice(-500);
  saveData();

  // Broadcast to all group members
  for (const ml in group.members) {
    const target = onlineUsers.get(ml);
    if (target && ml !== client.nameLower) {
      sendJSON(target.ws, { type: 'group_chat', groupId, fromId: client.id, fromName: client.name, text, ts: chatMsg.ts });
    }
  }
  // Echo to sender
  sendJSON(ws, { type: 'group_chat_sent', groupId, msg: chatMsg });
}

function handleGroupInvite(ws, msg) {
  // Deprecated: group_create now handles invites
}

function handleGroupAccept(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { groupId } = msg;
  if (!groupId) return;

  const invites = data.groupInvites[client.nameLower] || [];
  const inv = invites.find(i => i.groupId === groupId);
  if (!inv) return;

  const group = data.groups[groupId];
  if (!group) return;

  group.members[client.nameLower] = { id: client.id, name: client.name, role: 'member' };
  data.groupInvites[client.nameLower] = invites.filter(i => i.groupId !== groupId);
  saveData();

  sendJSON(ws, {
    type: 'groups_updated',
    groups: filterUserGroups(client.nameLower),
    groupInvites: data.groupInvites[client.nameLower] || []
  });

  // Notify group members
  for (const ml in group.members) {
    const target = onlineUsers.get(ml);
    if (target && ml !== client.nameLower) {
      sendJSON(target.ws, {
        type: 'groups_updated',
        groups: filterUserGroups(ml),
        groupInvites: data.groupInvites[ml] || []
      });
    }
  }
}

function handleGroupLeave(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { groupId } = msg;
  if (!groupId) return;

  const group = data.groups[groupId];
  if (!group) return;
  if (!group.members[client.nameLower]) return;

  delete group.members[client.nameLower];
  if (Object.keys(group.members).length === 0) {
    delete data.groups[groupId];
    delete data.groupMessages[groupId];
  }
  saveData();

  sendJSON(ws, {
    type: 'groups_updated',
    groups: filterUserGroups(client.nameLower),
    groupInvites: data.groupInvites[client.nameLower] || []
  });

  for (const ml in group.members) {
    const target = onlineUsers.get(ml);
    if (target) {
      sendJSON(target.ws, {
        type: 'groups_updated',
        groups: filterUserGroups(ml),
        groupInvites: data.groupInvites[ml] || []
      });
    }
  }
}

function filterUserGroups(nameLower) {
  const result = {};
  for (const gid in data.groups) {
    if (data.groups[gid].members[nameLower]) {
      result[gid] = data.groups[gid];
    }
  }
  return result;
}

// ===== Moments =====
function handleMomentPost(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { text, image } = msg;
  if (!text && !image) return;

  const moment = {
    id: 'm_' + Date.now().toString(36),
    authorId: client.id,
    authorName: client.name,
    authorNameLower: client.nameLower,
    authorAvatar: data.avatars[client.nameLower] || null,
    text: text || '',
    image: image || null,
    ts: Date.now(),
    likes: [],
    comments: []
  };

  data.moments.push(moment);
  if (data.moments.length > 200) data.moments = data.moments.slice(-200);
  saveData();

  // Broadcast to all friends
  broadcastMomentUpdate(client.nameLower);
  sendJSON(ws, { type: 'moment_posted', moment });
}

function handleMomentLike(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { momentId } = msg;
  if (!momentId) return;

  const moment = data.moments.find(m => m.id === momentId);
  if (!moment) return;

  const idx = moment.likes.indexOf(client.nameLower);
  if (idx >= 0) moment.likes.splice(idx, 1);
  else moment.likes.push(client.nameLower);
  saveData();

  broadcastMomentUpdate();
}

function handleMomentComment(ws, msg) {
  const client = clients.get(ws);
  if (!client) return;
  const { momentId, text } = msg;
  if (!momentId || !text) return;

  const moment = data.moments.find(m => m.id === momentId);
  if (!moment) return;

  moment.comments.push({
    authorName: client.name,
    authorNameLower: client.nameLower,
    text,
    ts: Date.now()
  });
  saveData();

  broadcastMomentUpdate();
}

function broadcastMomentUpdate() {
  const msg = { type: 'moments_updated', moments: data.moments };
  for (const [nameLower, u] of onlineUsers) {
    sendJSON(u.ws, msg);
  }
}

// ===== Server =====
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading page'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/chat' || req.url === '/basic-chatting.html' || req.url === '/app') {
    fs.readFile(CHAT_FILE, (err, data) => {
      if (err) { res.writeHead(500); res.end('Error loading page'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/manifest.json') {
    fs.readFile(path.join(__dirname, 'manifest.json'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/sw.js') {
    fs.readFile(path.join(__dirname, 'sw.js'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(data);
    });
  } else if (req.url === '/icon-192.png') {
    fs.readFile(path.join(__dirname, 'icon-192.png'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
  } else if (req.url === '/icon-512.png') {
    fs.readFile(path.join(__dirname, 'icon-512.png'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(data);
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

const wss = new WebSocket.Server({ server });
server.listen(PORT, () => {
  console.log(`[Server] Basic Chatting on http://0.0.0.0:${PORT}`);
});

wss.on('connection', (ws) => {
  console.log('[Conn] New connection');

  ws.on('message', (raw) => {
    handleMessage(ws, raw.toString());
  });

  ws.on('close', () => {
    disconnectClient(ws);
  });

  ws.on('error', (err) => {
    console.error('[Conn] Error:', err.message);
    disconnectClient(ws);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  saveData();
  console.log('[Server] Shutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveData();
  console.log('[Server] Shutting down...');
  process.exit(0);
});

loadData();