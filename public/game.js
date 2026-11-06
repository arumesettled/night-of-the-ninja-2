const socket = io();

const lobby = document.getElementById('lobby');
const game = document.getElementById('game');
const playerNameInput = document.getElementById('playerName');
const roomCodeInput = document.getElementById('roomCode');
const createBtn = document.getElementById('createBtn');
const joinBtn = document.getElementById('joinBtn');
const startBtn = document.getElementById('startBtn');
const playerList = document.getElementById('playerList');
const lobbyInfo = document.getElementById('lobbyInfo');
const phaseLabel = document.getElementById('phaseLabel');
const roomDisplay = document.getElementById('roomDisplay');
const playersPanel = document.getElementById('playersPanel');
const houseDisplay = document.getElementById('houseDisplay');
const handDisplay = document.getElementById('handDisplay');
const actionArea = document.getElementById('actionArea');
const log = document.getElementById('log');

let myId = null;
let currentRoom = null;
let isHost = false;
let myHouse = null;
let myHand = [];

createBtn.onclick = () => {
  const name = playerNameInput.value.trim();
  if (!name) return alert('Enter a name');
  socket.emit('createRoom', name);
};

joinBtn.onclick = () => {
  const name = playerNameInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name || !code) return alert('Name and room code required');
  socket.emit('joinRoom', { code, playerName: name });
};

startBtn.onclick = () => socket.emit('startGame');

socket.on('connect', () => { myId = socket.id; });

socket.on('roomCreated', ({ code, players }) => {
  currentRoom = code;
  isHost = true;
  showLobby(code, players);
  startBtn.style.display = 'block';
});

socket.on('joinedRoom', ({ code, players }) => {
  currentRoom = code;
  isHost = false;
  showLobby(code, players);
});

socket.on('updatePlayers', (players) => {
  renderPlayerList(players);
  renderGamePlayers(players);
});

function renderGamePlayers(players) {
  if (!playersPanel) return;
  playersPanel.innerHTML = '<h3>Players</h3>' + players.map(p => 
    `<div class="player-card ${p.alive === false ? 'dead' : ''}">
      <span>${p.name}${p.id === myId ? ' (you)' : ''}</span>
      <span>${p.honor || 0} honor</span>
    </div>`
  ).join('');
}

socket.on('gameStarted', (data) => {
  lobby.style.display = 'none';
  game.style.display = 'block';
  roomDisplay.textContent = `Room: ${currentRoom}`;
  addLog('Game started!');
  if (data.players) renderGamePlayers(data.players);
});

socket.on('privateInfo', ({ house, hand }) => {
  myHouse = house;
  myHand = hand || [];
  renderPrivate();
});

socket.on('draftAck', ({ kept }) => {
  addLog(`You kept: ${kept.type}${kept.number ? ' ' + kept.number : ''}`);
});

socket.on('phaseUpdate', ({ phase, message }) => {
  phaseLabel.textContent = `Phase: ${phase}`;
  if (message) addLog(message);
});

socket.on('error', (msg) => alert(msg));

function showLobby(code, players) {
  lobbyInfo.innerHTML = `<strong>Room code: ${code}</strong> — share this with your team`;
  renderPlayerList(players);
}

function renderPlayerList(players) {
  playerList.innerHTML = players.map(p => 
    `<li>${p.name}${p.id === myId ? ' (you)' : ''}${isHost && p.id === myId ? ' — Host' : ''}</li>`
  ).join('');
}

function renderPrivate() {
  if (myHouse) {
    const color = myHouse.house === 'Crane' ? 'var(--crane)' : myHouse.house === 'Lotus' ? 'var(--lotus)' : 'var(--ronin)';
    houseDisplay.innerHTML = `<span style="color:${color};font-weight:bold">${myHouse.house} ${myHouse.rank || ''}</span>`;
  }
  handDisplay.innerHTML = myHand.map((c, i) => 
    `<div class="hand-card" data-i="${i}">${c.type}${c.number ? ' ' + c.number : ''}</div>`
  ).join('') || '<em>No cards</em>';
}

function addLog(msg) {
  const div = document.createElement('div');
  div.textContent = msg;
  log.prepend(div);
}

handDisplay.addEventListener('click', (e) => {
  const card = e.target.closest('.hand-card');
  if (!card) return;
  document.querySelectorAll('.hand-card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
  const index = parseInt(card.dataset.i);
  socket.emit('draftChoice', { cardIndex: index });
  addLog(`Kept a card (waiting for others...)`);
});
