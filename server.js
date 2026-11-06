const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

// Card definitions
const CARD_TYPES = {
  SPY: 'Spy',
  MYSTIC: 'Mystic',
  BLIND_ASSASSIN: 'Blind Assassin',
  SHINOBI: 'Shinobi',
  SHAPESHIFTER: 'Shapeshifter',
  JUDGE: 'Judge',
  GRAVEDIGGER: 'Gravedigger',
  SPIRIT_MERCHANT: 'Spirit Merchant',
  THIEF: 'Thief',
  TROUBLEMAKER: 'Troublemaker',
  MIRROR_MONK: 'Mirror Monk',
  MARTYR: 'Martyr',
  MASTERMIND: 'Mastermind'
};

function createNinjaDeck() {
  const deck = [];
  // Multiple copies of core cards (numbered 1-6)
  for (let num = 1; num <= 6; num++) {
    deck.push({ type: CARD_TYPES.SPY, number: num, phase: 'Spy' });
    deck.push({ type: CARD_TYPES.MYSTIC, number: num, phase: 'Mystic' });
    deck.push({ type: CARD_TYPES.BLIND_ASSASSIN, number: num, phase: 'Blind Assassin' });
    deck.push({ type: CARD_TYPES.SHINOBI, number: num, phase: 'Shinobi' });
  }
  // Special Tricksters
  deck.push({ type: CARD_TYPES.SHAPESHIFTER, number: 1, phase: 'Trickster' });
  deck.push({ type: CARD_TYPES.GRAVEDIGGER, number: 2, phase: 'Trickster' });
  deck.push({ type: CARD_TYPES.TROUBLEMAKER, number: 3, phase: 'Trickster' });
  deck.push({ type: CARD_TYPES.SPIRIT_MERCHANT, number: 4, phase: 'Trickster' });
  deck.push({ type: CARD_TYPES.THIEF, number: 5, phase: 'Trickster' });
  deck.push({ type: CARD_TYPES.JUDGE, number: 6, phase: 'Trickster' });
  // Reactions / special
  deck.push({ type: CARD_TYPES.MIRROR_MONK, number: 0, phase: 'React' });
  deck.push({ type: CARD_TYPES.MARTYR, number: 0, phase: 'React' });
  deck.push({ type: CARD_TYPES.MASTERMIND, number: 0, phase: 'Reveal' });
  return shuffle(deck);
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function createHouseCards(playerCount) {
  const houses = [];
  const half = Math.floor(playerCount / 2);
  for (let i = 1; i <= half; i++) {
    houses.push({ house: 'Crane', rank: i });
    houses.push({ house: 'Lotus', rank: i });
  }
  if (playerCount % 2 === 1) {
    houses.push({ house: 'Ronin', rank: 0 });
  }
  return shuffle(houses);
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('createRoom', (playerName) => {
    const code = generateRoomCode();
    const room = {
      code,
      players: [{ id: socket.id, name: playerName, honor: 0, alive: true }],
      host: socket.id,
      state: 'lobby',
      game: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('roomCreated', { code, players: room.players });
    io.to(code).emit('updatePlayers', room.players);
  });

  socket.on('joinRoom', ({ code, playerName }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit('error', 'Room not found');
    if (room.players.length >= 11) return socket.emit('error', 'Room full');
    if (room.state !== 'lobby') return socket.emit('error', 'Game already started');

    room.players.push({ id: socket.id, name: playerName, honor: 0, alive: true });
    socket.join(code);
    socket.emit('joinedRoom', { code, players: room.players });
    io.to(code).emit('updatePlayers', room.players);
  });

  socket.on('startGame', () => {
    const room = getRoomBySocket(socket);
    if (!room || room.host !== socket.id) return;
    if (room.players.length < 4) return socket.emit('error', 'Need at least 4 players');

    startRound(room);
  });

  socket.on('draftChoice', ({ cardIndex }) => {
    // Draft logic will be handled here
    const room = getRoomBySocket(socket);
    if (!room || !room.game) return;
    handleDraftChoice(room, socket.id, cardIndex);
  });

  socket.on('playCard', (data) => {
    const room = getRoomBySocket(socket);
    if (!room || !room.game) return;
    handlePlayCard(room, socket.id, data);
  });

  socket.on('disconnect', () => {
    const room = getRoomBySocket(socket);
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      if (room.players.length === 0) {
        rooms.delete(room.code);
      } else {
        io.to(room.code).emit('updatePlayers', room.players);
      }
    }
  });
});

function getRoomBySocket(socket) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.id === socket.id)) return room;
  }
  return null;
}

function startRound(room) {
  const houseCards = createHouseCards(room.players.length);
  const ninjaDeck = createNinjaDeck();

  room.game = {
    phase: 'draft',
    draftStep: 0,
    houses: {},
    hands: {},
    played: {},
    discard: [],
    honorTokens: shuffle(Array(35).fill(0).map((_, i) => [2, 3, 4][i % 3]))
  };

  room.players.forEach((p, i) => {
    room.game.houses[p.id] = houseCards[i];
    // Deal 3 cards for draft
    room.game.hands[p.id] = ninjaDeck.splice(0, 3);
    p.alive = true;
  });

  room.state = 'playing';
  io.to(room.code).emit('gameStarted', {
    players: room.players.map(p => ({ id: p.id, name: p.name, honor: p.honor })),
    yourHouse: null // will be sent privately
  });

  // Send private house and hand
  room.players.forEach(p => {
    io.to(p.id).emit('privateInfo', {
      house: room.game.houses[p.id],
      hand: room.game.hands[p.id]
    });
  });

  io.to(room.code).emit('phaseUpdate', { phase: 'Draft', message: 'Choose 1 card to keep, then pass the rest' });
}

function handleDraftChoice(room, playerId, cardIndex) {
  const game = room.game;
  if (!game || game.phase !== 'draft') return;
  const hand = game.hands[playerId];
  if (!hand || !hand[cardIndex]) return;

  // Simple: keep the chosen card, move others toward discard for prototype
  const kept = hand.splice(cardIndex, 1)[0];
  game.discard.push(...hand);
  game.hands[playerId] = [kept]; // temporarily store kept

  io.to(playerId).emit('draftAck', { kept });

  // Check if all have chosen (simplified for now)
  const allChosen = room.players.every(p => game.hands[p.id] && game.hands[p.id].length === 1);
  if (allChosen) {
    // Move to night
    game.phase = 'night';
    game.currentPhase = 'Spy';
    io.to(room.code).emit('phaseUpdate', { 
      phase: 'Night — Spy', 
      message: 'Spy phase: play a Spy card if you have one, or pass.' 
    });
    // Send updated hands
    room.players.forEach(p => {
      io.to(p.id).emit('privateInfo', {
        house: game.houses[p.id],
        hand: game.hands[p.id]
      });
    });
  }
}

function handlePlayCard(room, playerId, data) {
  // Placeholder for phase resolution
  io.to(room.code).emit('cardPlayed', { playerId, ...data });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Night of the Ninja server running on port ${PORT}`);
});
