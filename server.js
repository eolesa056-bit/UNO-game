const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ✅ ГЛАВНЫЙ МАРШРУТ (исправляет ошибку "Не удается получить /")
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'UNO Multiplayer Server is running!',
    version: '1.0.0',
    endpoints: {
      leaderboard: '/api/leaderboard',
      register: 'POST /api/register',
      login: 'POST /api/login'
    }
  });
});

// Хранилище данных
let accounts = {};
let bannedUsers = [];
let reports = [];
let activeGames = {};
let waitingPlayers = [];

// Константы
const DEV_LOGIN = "unity";
const DEV_PASS = "ZXC1337";
const WIN_CUPS = 8;
const LOSE_CUPS = -5;
const MAX_CUPS = 100000;

// Загрузка данных
function loadData() {
  if (Object.keys(accounts).length === 0) {
    accounts["unity"] = { password: "ZXC1337", cups: 9999, isDev: true };
    accounts["DemoPlayer"] = { password: "", cups: 0, isDev: false };
    accounts["TestUser"] = { password: "", cups: 0, isDev: false };
  }
}

loadData();

// API endpoints
app.get('/api/leaderboard', (req, res) => {
  const sorted = Object.entries(accounts)
    .sort((a, b) => b[1].cups - a[1].cups)
    .slice(0, 10)
    .map(([name, data]) => ({ name, cups: data.cups }));
  res.json(sorted);
});

app.post('/api/register', (req, res) => {
  const { nickname, password } = req.body;
  if (!nickname) return res.json({ success: false, error: 'Введите никнейм' });
  if (nickname === DEV_LOGIN) return res.json({ success: false, error: 'Никнейм зарезервирован' });
  if (accounts[nickname]) return res.json({ success: false, error: 'Никнейм уже существует' });
  
  accounts[nickname] = { password: password || "", cups: 0, isDev: false };
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { nickname, password } = req.body;
  
  if (nickname === DEV_LOGIN && password === DEV_PASS) {
    return res.json({ success: true, isDev: true, cups: accounts[DEV_LOGIN]?.cups || 9999 });
  }
  
  if (!accounts[nickname]) return res.json({ success: false, error: 'Аккаунт не найден' });
  if (bannedUsers.includes(nickname)) return res.json({ success: false, error: 'Аккаунт забанен' });
  if (accounts[nickname].password && accounts[nickname].password !== password) {
    return res.json({ success: false, error: 'Неверный пароль' });
  }
  
  res.json({ success: true, isDev: false, cups: accounts[nickname].cups });
});

app.post('/api/add-cups', (req, res) => {
  const { nickname, delta } = req.body;
  if (!accounts[nickname]) return res.json({ success: false });
  let newCups = accounts[nickname].cups + delta;
  newCups = Math.min(MAX_CUPS, Math.max(0, newCups));
  accounts[nickname].cups = newCups;
  res.json({ success: true, cups: newCups });
});

app.post('/api/admin/ban', (req, res) => {
  const { adminKey, nickname } = req.body;
  if (adminKey !== DEV_PASS) return res.json({ success: false });
  if (nickname === DEV_LOGIN) return res.json({ success: false, error: 'Нельзя забанить разработчика' });
  
  if (bannedUsers.includes(nickname)) {
    bannedUsers = bannedUsers.filter(b => b !== nickname);
  } else {
    bannedUsers.push(nickname);
  }
  res.json({ success: true, banned: bannedUsers.includes(nickname) });
});

app.post('/api/admin/set-cups', (req, res) => {
  const { adminKey, nickname, cups } = req.body;
  if (adminKey !== DEV_PASS) return res.json({ success: false });
  if (!accounts[nickname]) return res.json({ success: false });
  accounts[nickname].cups = Math.min(MAX_CUPS, Math.max(0, cups));
  res.json({ success: true });
});

app.get('/api/admin/reports', (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== DEV_PASS) return res.json({ success: false });
  res.json({ reports });
});

app.post('/api/report', (req, res) => {
  const { from } = req.body;
  reports.push({ from, time: new Date().toISOString() });
  res.json({ success: true });
});

// Socket.IO для реального времени
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  
  socket.on('find-game', (data) => {
    const { playerName, playerCount } = data;
    
    let found = false;
    for (let roomId in activeGames) {
      const game = activeGames[roomId];
      if (game.players.length < game.maxPlayers && game.maxPlayers === playerCount && game.status === 'waiting') {
        game.players.push({ id: socket.id, name: playerName, hand: [], ready: false });
        socket.join(roomId);
        socket.emit('game-found', { roomId, players: game.players.map(p => ({ name: p.name })) });
        io.to(roomId).emit('player-joined', { players: game.players.map(p => ({ name: p.name })) });
        found = true;
        break;
      }
    }
    
    if (!found) {
      const roomId = Date.now().toString();
      activeGames[roomId] = {
        id: roomId,
        players: [{ id: socket.id, name: playerName, hand: [], ready: false }],
        maxPlayers: playerCount,
        status: 'waiting',
        currentTurn: 0,
        currentColor: null,
        discardPile: [],
        direction: 1,
        mustDraw: 0,
        deck: []
      };
      socket.join(roomId);
      socket.emit('game-found', { roomId, players: [{ name: playerName }] });
    }
  });
  
  socket.on('player-ready', (data) => {
    const { roomId } = data;
    const game = activeGames[roomId];
    if (!game) return;
    
    const player = game.players.find(p => p.id === socket.id);
    if (player) player.ready = true;
    
    const allReady = game.players.length === game.maxPlayers && game.players.every(p => p.ready);
    if (allReady && game.players.length === game.maxPlayers) {
      startGame(roomId);
    }
    
    io.to(roomId).emit('players-update', { players: game.players.map(p => ({ name: p.name, ready: p.ready })) });
  });
  
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    for (let roomId in activeGames) {
      const game = activeGames[roomId];
      const playerIndex = game.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        game.players.splice(playerIndex, 1);
        io.to(roomId).emit('player-left', { players: game.players.map(p => ({ name: p.name })) });
        if (game.players.length === 0) {
          delete activeGames[roomId];
        }
        break;
      }
    }
  });
});

function createDeck() {
  const COLORS = ['red', 'blue', 'green', 'yellow'];
  let deck = [];
  for (let c of COLORS) {
    for (let n = 0; n <= 9; n++) {
      let cnt = (n === 0) ? 1 : 2;
      for (let i = 0; i < cnt; i++) deck.push({ type: 'num', color: c, val: n });
    }
    for (let i = 0; i < 2; i++) {
      deck.push({ type: 'skip', color: c, val: 'skip' });
      deck.push({ type: 'reverse', color: c, val: 'reverse' });
      deck.push({ type: '+2', color: c, val: '+2' });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ type: 'wild', color: null, val: 'wild' });
    deck.push({ type: 'wild+4', color: null, val: 'wild+4' });
  }
  return shuffle(deck);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    let j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startGame(roomId) {
  const game = activeGames[roomId];
  const deck = createDeck();
  
  for (let player of game.players) {
    player.hand = [];
    for (let i = 0; i < 7; i++) player.hand.push(deck.pop());
  }
  
  let firstCard = deck.pop();
  while (firstCard.type === 'wild' || firstCard.type === 'wild+4') {
    deck.push(firstCard);
    deck = shuffle(deck);
    firstCard = deck.pop();
  }
  
  game.deck = deck;
  game.discardPile = [firstCard];
  game.currentColor = firstCard.color;
  game.currentTurn = 0;
  game.direction = 1;
  game.mustDraw = 0;
  game.status = 'playing';
  
  io.to(roomId).emit('game-start', {
    players: game.players.map(p => ({ name: p.name, cardCount: p.hand.length })),
    currentTurn: 0,
    currentCard: firstCard,
    currentColor: firstCard.color,
    currentPlayerHand: game.players[0].hand
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ UNO Server running on port ${PORT}`);
  console.log(`📡 Server URL: http://localhost:${PORT}`);
});
