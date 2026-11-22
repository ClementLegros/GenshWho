import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomInt } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { initCharacters, getCharacters, getUpdatedAt, getImage } from './characters.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const DISCONNECT_GRACE_MS = 2 * 60 * 1000;
const BOARD_SIZES = [24, 40, 60, 0]; // 0 = tous les personnages
const BAN_COUNTS = [0, 3, 5];       // bans par joueur avant chaque manche

// ---------------------------------------------------------------- HTTP

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/characters') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(JSON.stringify({ updatedAt: getUpdatedAt(), characters: getCharacters() }));
    }

    if (pathname.startsWith('/img/')) {
      const buf = await getImage(path.basename(pathname, '.png')).catch(() => null);
      if (!buf) return res.writeHead(404).end();
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=2592000' });
      return res.end(buf);
    }

    const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : decodeURIComponent(pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(403).end();
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('Introuvable');
  }
});

// ---------------------------------------------------------------- Salons

/** code -> salon */
const rooms = new Map();

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 20) || 'Joueur';
}

function send(ws, msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function fail(ws, msg) {
  send(ws, { t: 'error', msg });
}

/** État du salon vu par un joueur : le personnage secret adverse n'est jamais envoyé avant la fin. */
function view(room, me) {
  return {
    t: 'state',
    code: room.code,
    phase: room.phase,
    round: room.round,
    size: room.size,
    banCount: room.banCount,
    bans: room.bans,
    total: getCharacters().length,
    you: me,
    players: room.players.map((p) => ({
      name: p.name,
      online: !!p.ws,
      ready: room.phase === 'ban' ? p.bans !== null : p.secret !== null,
      score: p.score,
    })),
    board: room.board,
    // Phase de bans : chacun choisit dans `pool` ; les bans adverses restent cachés jusqu'au tirage du plateau.
    pool: room.pool,
    myBans: room.players[me].bans,
    roundBans: room.phase === 'ban' || room.phase === 'lobby' ? null : room.players.map((p) => p.bans ?? []),
    turn: room.turn,
    pending: room.pending,
    log: room.log,
    winner: room.winner,
    secret: room.players[me].secret,
    secrets: room.phase === 'over' ? room.players.map((p) => p.secret) : null,
  };
}

function broadcast(room) {
  room.players.forEach((p, i) => send(p.ws, view(room, i)));
}

function resetToLobby(room) {
  room.phase = 'lobby';
  room.board = [];
  room.pool = [];
  room.pending = null;
  room.log = [];
  room.winner = null;
  for (const p of room.players) {
    p.secret = null;
    p.bans = null;
  }
}

function drawBoard(room, pool) {
  room.board = sample(pool, room.size);
  room.pool = [];
  room.phase = 'pick';
}

function attach(ws, room, player) {
  clearTimeout(player.timer);
  if (player.ws && player.ws !== ws) {
    player.ws.room = player.ws.player = null;
    player.ws.close();
  }
  player.ws = ws;
  ws.room = room;
  ws.player = player;
}

function removePlayer(room, player) {
  clearTimeout(player.timer);
  const i = room.players.indexOf(player);
  if (i < 0) return;
  room.players.splice(i, 1);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  resetToLobby(room);
  broadcast(room);
}

function detach(ws, { leave = false } = {}) {
  const { room, player } = ws;
  if (!room || !player) return;
  ws.room = ws.player = null;
  player.ws = null;
  if (leave) return removePlayer(room, player);
  // Déconnexion : on garde la place un moment pour permettre de revenir (rechargement, coupure réseau).
  player.timer = setTimeout(() => removePlayer(room, player), DISCONNECT_GRACE_MS);
  broadcast(room);
}

function sample(list, n) {
  const pool = [...list];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return n > 0 ? pool.slice(0, n) : pool;
}

// ---------------------------------------------------------------- Messages

const handlers = {
  create(ws, msg) {
    detach(ws, { leave: true });
    const room = {
      code: makeCode(), players: [], phase: 'lobby', size: 24, round: 0,
      banCount: 0, bans: [], pool: [],
      board: [], turn: 0, pending: null, log: [], winner: null,
    };
    rooms.set(room.code, room);
    handlers.join(ws, { ...msg, code: room.code });
  },

  join(ws, msg) {
    const pid = String(msg.pid ?? '');
    if (pid.length < 16 || pid.length > 64) return fail(ws, 'Identifiant invalide.');
    const room = rooms.get(String(msg.code ?? '').trim().toUpperCase());
    if (!room) return send(ws, { t: 'gone', msg: 'Ce salon n’existe pas ou plus.' });

    let player = room.players.find((p) => p.pid === pid);
    if (!player) {
      if (room.players.length >= 2) return send(ws, { t: 'gone', msg: 'Ce salon est déjà complet.' });
      player = { pid, name: cleanName(msg.name), ws: null, secret: null, bans: null, score: 0, timer: null };
      room.players.push(player);
    }
    if (ws.room && ws.room !== room) detach(ws, { leave: true });
    attach(ws, room, player);
    broadcast(room);
  },

  leave(ws) {
    detach(ws, { leave: true });
    send(ws, { t: 'left' });
  },

  settings(ws, msg, room, me) {
    if (me !== 0 || room.phase !== 'lobby') return;
    if (BOARD_SIZES.includes(msg.size)) room.size = msg.size;
    if (BAN_COUNTS.includes(msg.banCount)) room.banCount = msg.banCount;
    if (Array.isArray(msg.bans)) {
      const known = new Set(getCharacters().map((c) => c.id));
      room.bans = [...new Set(msg.bans.map(String))].filter((id) => known.has(id));
    }
    broadcast(room);
  },

  start(ws, msg, room, me) {
    if (me !== 0 || (room.phase !== 'lobby' && room.phase !== 'over')) return;
    if (room.players.length < 2) return fail(ws, 'Il faut deux joueurs pour lancer la partie.');
    const ids = getCharacters().map((c) => c.id);
    if (ids.length < 2) return fail(ws, 'Les personnages ne sont pas encore chargés, réessaie dans un instant.');
    const excluded = new Set(room.bans);
    const pool = ids.filter((id) => !excluded.has(id));
    if (pool.length - 2 * room.banCount < 2) return fail(ws, 'Trop de personnages exclus : il n’en reste pas assez pour jouer.');
    resetToLobby(room);
    room.round += 1;
    room.turn = room.round === 1 ? randomInt(2) : room.round % 2;
    if (room.banCount > 0) {
      room.pool = pool;
      room.phase = 'ban';
    } else {
      drawBoard(room, pool);
    }
    broadcast(room);
  },

  bans(ws, msg, room, me) {
    const player = room.players[me];
    if (room.phase !== 'ban' || player.bans !== null || !Array.isArray(msg.ids)) return;
    player.bans = [...new Set(msg.ids.map(String))].filter((id) => room.pool.includes(id)).slice(0, room.banCount);
    if (room.players.every((p) => p.bans !== null)) {
      const out = new Set(room.players.flatMap((p) => p.bans));
      drawBoard(room, room.pool.filter((id) => !out.has(id)));
    }
    broadcast(room);
  },

  lobby(ws, msg, room, me) {
    if (me !== 0 || room.phase === 'lobby') return;
    resetToLobby(room);
    broadcast(room);
  },

  secret(ws, msg, room, me) {
    const player = room.players[me];
    const id = String(msg.id);
    if (room.phase !== 'pick' || player.secret !== null || !room.board.includes(id)) return;
    player.secret = id;
    if (room.players.every((p) => p.secret !== null)) room.phase = 'play';
    broadcast(room);
  },

  ask(ws, msg, room, me) {
    if (room.phase !== 'play' || room.turn !== me || room.pending) return;
    const text = String(msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!text) return;
    room.pending = text;
    room.log.push({ k: 'q', by: me, text });
    broadcast(room);
  },

  answer(ws, msg, room, me) {
    if (room.phase !== 'play' || room.turn === me || !room.pending) return;
    room.log.push({ k: 'a', by: me, yes: !!msg.yes });
    room.pending = null;
    room.turn = me;
    broadcast(room);
  },

  guess(ws, msg, room, me) {
    const id = String(msg.id);
    if (room.phase !== 'play' || room.turn !== me || room.pending || !room.board.includes(id)) return;
    const ok = room.players[1 - me].secret === id;
    room.log.push({ k: 'g', by: me, id, ok });
    if (ok) {
      room.phase = 'over';
      room.winner = me;
      room.players[me].score += 1;
    } else {
      room.turn = 1 - me;
    }
    broadcast(room);
  },
};

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16384 });

wss.on('error', () => {}); // les erreurs d'écoute sont traitées sur le serveur HTTP, plus bas

wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', () => {});
  ws.on('close', () => detach(ws));
  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    const handler = Object.hasOwn(handlers, msg?.t) ? handlers[msg.t] : null;
    if (!handler) return;
    if (['create', 'join', 'leave'].includes(msg.t)) return handler(ws, msg);
    if (!ws.room) return send(ws, { t: 'gone', msg: 'Tu n’es plus dans ce salon.' });
    handler(ws, msg, ws.room, ws.room.players.indexOf(ws.player));
  });
});

// Détecte les connexions mortes et garde les autres ouvertes derrière un proxy.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30_000).unref();

await initCharacters();

// Si le port par défaut est déjà pris par un autre programme, on essaie les suivants.
// Un port demandé explicitement via PORT n'est jamais remplacé.
let port = PORT;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !process.env.PORT && port < PORT + 20) {
    console.warn(`Port ${port} déjà utilisé, essai sur le ${port + 1}…`);
    server.listen(++port);
  } else {
    console.error(err.code === 'EADDRINUSE' ? `Le port ${port} est déjà utilisé.` : err);
    process.exit(1);
  }
});
server.on('listening', () => console.log(`GenshWho est prêt : http://localhost:${port}`));
server.listen(port);
