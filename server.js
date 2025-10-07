// server.js
// Signaling + static server for WatchParty (production-ready for Render)
// Usage: npm install && npm start
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// serve static frontend from /public
app.use(express.static(path.join(__dirname, 'public')));

// simple health check for Render
app.get('/health', (req, res) => res.status(200).send('ok'));

// Rooms structure: Map<roomId, { participants: Map(id -> {id,name,isHost,ws}) , hostId }>
const rooms = new Map();

function safeSend(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
}

function broadcastToRoom(roomId, msg, exceptId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  for (const [id, client] of room.participants) {
    if (id === exceptId) continue;
    if (client.ws && client.ws.readyState === WebSocket.OPEN) {
      safeSend(client.ws, msg);
    }
  }
}

function getParticipantsArray(roomId) {
  const room = rooms.get(roomId);
  if (!room) return [];
  return Array.from(room.participants.values()).map(p => ({ id: p.id, name: p.name, isHost: p.isHost }));
}

wss.on('connection', (ws, req) => {
  ws.id = uuidv4();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const { type, room } = msg;

    // JOIN
    if (type === 'join') {
      const { name, isHost } = msg;
      if (!room || !name) return safeSend(ws, { type: 'error', error: 'room and name required' });

      ws.room = room;
      ws.name = name;
      ws.isHost = !!isHost;

      if (!rooms.has(room)) rooms.set(room, { participants: new Map(), hostId: null });
      const r = rooms.get(room);

      if (ws.isHost) r.hostId = ws.id; // explicit host claim
      r.participants.set(ws.id, { id: ws.id, name, isHost: !!isHost, ws });

      // prepare participants list and hostId for the joining socket
      const participants = getParticipantsArray(room);
      safeSend(ws, { type: 'joined', id: ws.id, participants, hostId: r.hostId });

      // notify others
      broadcastToRoom(room, { type: 'new-participant', id: ws.id, name, isHost: !!isHost }, ws.id);
      return;
    }

    // OFFER / ANSWER / ICE forwarding
    if (type === 'offer' || type === 'answer' || type === 'ice') {
      const { to } = msg;
      if (!room || !to) return;
      const r = rooms.get(room);
      if (!r) return;
      const target = r.participants.get(to);
      if (target && target.ws && target.ws.readyState === WebSocket.OPEN) {
        // include from id
        safeSend(target.ws, { ...msg, from: ws.id });
      }
      return;
    }

    // CHAT: broadcast to room
    if (type === 'chat') {
      const { text } = msg;
      if (!room || !text) return;
      const payload = { type: 'chat', fromId: ws.id, fromName: ws.name, text, ts: Date.now() };
      broadcastToRoom(room, payload);
      return;
    }

    // control-request: viewer -> host
    if (type === 'control-request') {
      if (!room) return;
      const r = rooms.get(room);
      if (!r) return;
      const hostId = r.hostId;
      if (!hostId) {
        return safeSend(ws, { type: 'control-error', error: 'no host in room' });
      }
      const host = r.participants.get(hostId);
      if (host && host.ws && host.ws.readyState === WebSocket.OPEN) {
        safeSend(host.ws, { type: 'control-request', from: ws.id, fromName: ws.name, action: msg.action });
      }
      return;
    }

    // control: authoritative from host -> broadcast
    if (type === 'control') {
      if (!room) return;
      broadcastToRoom(room, { type:'control', from: ws.id, action: msg.action }, ws.id);
      return;
    }

    // host-request: viewer asks to become host
    if (type === 'host-request') {
      if (!room) return;
      const r = rooms.get(room);
      if (!r) return safeSend(ws, { type: 'error', error: 'room not found' });

      const hostId = r.hostId;
      if (!hostId) {
        // no host -> auto assign
        r.hostId = ws.id;
        for (const [, p] of r.participants) p.isHost = (p.id === ws.id);
        broadcastToRoom(room, { type: 'host-changed', hostId: ws.id });
        return;
      }
      const host = r.participants.get(hostId);
      if (host && host.ws && host.ws.readyState === WebSocket.OPEN) {
        safeSend(host.ws, { type: 'host-request', from: ws.id, name: ws.name });
      }
      return;
    }

    // host-request-response: host approves/denies
    if (type === 'host-request-response') {
      const { approved, targetId } = msg;
      if (!room || !targetId) return;
      const r = rooms.get(room); if (!r) return;
      if (approved) {
        r.hostId = targetId;
        for (const [, p] of r.participants) p.isHost = (p.id === targetId);
        broadcastToRoom(room, { type: 'host-changed', hostId: targetId });
        const target = r.participants.get(targetId);
        if (target) safeSend(target.ws, { type: 'host-granted', targetId });
      } else {
        const target = r.participants.get(targetId);
        if (target) safeSend(target.ws, { type: 'host-denied', targetId });
      }
      return;
    }

    // set-host (explicit admin)
    if (type === 'set-host') {
      const { newHostId } = msg;
      if (!room || !newHostId) return;
      const r = rooms.get(room); if (!r) return;
      r.hostId = newHostId;
      for (const [, p] of r.participants) p.isHost = (p.id === newHostId);
      broadcastToRoom(room, { type: 'host-changed', hostId: newHostId });
      return;
    }

    // list participants
    if (type === 'list') {
      if (!room) return;
      const r = rooms.get(room); if (!r) return;
      const participants = getParticipantsArray(room);
      safeSend(ws, { type: 'list', participants, hostId: r.hostId });
      return;
    }

    // unknown type -> ignore silently
  });

  ws.on('close', () => {
    try {
      const roomId = ws.room;
      if (!roomId) return;
      const r = rooms.get(roomId);
      if (!r) return;
      r.participants.delete(ws.id);

      // notify others somebody left
      broadcastToRoom(roomId, { type: 'participant-left', id: ws.id });

      // if they were host, pick a new host if possible
      if (r.hostId === ws.id) {
        r.hostId = null;
        // pick first participant as new host (if any)
        const first = r.participants.values().next();
        if (!first.done) {
          const newHost = first.value;
          r.hostId = newHost.id;
          for (const [, p] of r.participants) p.isHost = (p.id === newHost.id);
          broadcastToRoom(roomId, { type: 'host-changed', hostId: newHost.id });
        } else {
          // room empty -> delete
          rooms.delete(roomId);
          return;
        }
        // notify that previous host left
        broadcastToRoom(roomId, { type: 'host-left' });
      }

      // cleanup empty room
      if (r.participants.size === 0) rooms.delete(roomId);
    } catch (e) {
      console.error('error in close handler', e);
    }
  });
});

// heartbeat to detect dead sockets
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping(() => {});
  });
}, 30000);

// start server
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
server.listen(PORT, () => {
  console.log(`Signaling + static server listening on port ${PORT}`);
});

// graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received: shutting down');
  clearInterval(interval);
  wss.clients.forEach((c) => c.terminate());
  server.close(() => process.exit(0));
});
