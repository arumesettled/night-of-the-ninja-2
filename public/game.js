const socket = io();

const $ = (id) => document.getElementById(id);
const lobby = $('lobby');
const game = $('game');
const entryPanel = $('entryPanel');
const waitingPanel = $('waitingPanel');
const playerNameInput = $('playerName');
const roomCodeInput = $('roomCode');
const createBtn = $('createBtn');
const joinBtn = $('joinBtn');
const startBtn = $('startBtn');
const startHint = $('startHint');
const playerList = $('playerList');
const playerCount = $('playerCount');
const codeText = $('codeText');
const copyCode = $('copyCode');
const phaseLabel = $('phaseLabel');
const roomDisplay = $('roomDisplay');
const playersPanel = $('playersPanel');
const houseDisplay = $('houseDisplay');
const handDisplay = $('handDisplay');
const handHint = $('handHint');
const log = $('log');
const toasts = $('toasts');

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 11;

let myId = null;
let currentRoom = null;
let isHost = false;
let hostId = null;
let myHouse = null;
let myHand = [];

const CARD_GLYPHS = {
  'Spy': '諜', 'Mystic': '霊', 'Blind Assassin': '刺', 'Shinobi': '忍',
  'Shapeshifter': '変', 'Judge': '判', 'Gravedigger': '墓', 'Spirit Merchant': '商',
  'Thief': '盗', 'Troublemaker': '乱', 'Mirror Monk': '鏡', 'Martyr': '殉', 'Mastermind': '謀'
};
const HOUSE_SIGILS = { Crane: '鶴', Lotus: '蓮', Ronin: '浪' };
const AVATAR_COLORS = ['#e2445c', '#4f9dff', '#b18cff', '#34d399', '#f472b6', '#22d3ee', '#fb7185', '#818cf8', '#2dd4bf', '#c084fc', '#60a5fa'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function initials(name) {
  return esc(String(name).trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?');
}
function avatarColor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function toast(msg, kind = 'error') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  toasts.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------- Lobby actions ----------
createBtn.onclick = () => {
  const name = playerNameInput.value.trim();
  if (!name) { playerNameInput.focus(); return toast('Pick a ninja name first'); }
  socket.emit('createRoom', name);
};

joinBtn.onclick = () => {
  const name = playerNameInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name) { playerNameInput.focus(); return toast('Pick a ninja name first'); }
  if (!code) { roomCodeInput.focus(); return toast('Enter a room code'); }
  socket.emit('joinRoom', { code, playerName: name });
};

roomCodeInput.addEventListener('input', () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
roomCodeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
playerNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') (roomCodeInput.value ? joinBtn : createBtn).click(); });

copyCode.onclick = async () => {
  if (!currentRoom) return;
  try { await navigator.clipboard.writeText(currentRoom); toast('Room code copied', 'ok'); }
  catch { toast(`Room code: ${currentRoom}`, 'ok'); }
};

startBtn.onclick = () => socket.emit('startGame');

// ---------- Socket events ----------
socket.on('connect', () => { myId = socket.id; });

socket.on('roomCreated', ({ code, players }) => {
  currentRoom = code;
  isHost = true;
  hostId = myId;
  showLobby(code, players);
});

socket.on('joinedRoom', ({ code, players }) => {
  currentRoom = code;
  isHost = false;
  hostId = players[0] && players[0].id;
  showLobby(code, players);
});

socket.on('updatePlayers', (players) => {
  renderPlayerList(players);
  renderGamePlayers(players);
});

socket.on('gameStarted', (data) => {
  lobby.hidden = true;
  game.hidden = false;
  document.body.classList.add('in-game');
  roomDisplay.textContent = `Room ${currentRoom}`;
  addLog('The night begins…');
  if (data.players) renderGamePlayers(data.players);
});

socket.on('privateInfo', ({ house, hand }) => {
  myHouse = house;
  myHand = hand || [];
  renderPrivate();
});

socket.on('draftAck', ({ kept }) => {
  addLog(`You kept ${kept.type}${kept.number ? ' ' + kept.number : ''}`);
});

socket.on('phaseUpdate', ({ phase, message }) => {
  phaseLabel.textContent = phase;
  if (message) addLog(message);
});

socket.on('error', (msg) => toast(typeof msg === 'string' ? msg : 'Something went wrong'));

// ---------- Rendering ----------
function showLobby(code, players) {
  entryPanel.hidden = true;
  $('heroPhoto').hidden = true;
  waitingPanel.hidden = false;
  codeText.textContent = code;
  renderPlayerList(players);
}

function playerRow(p, extra = '') {
  const tags = [
    p.id === myId ? '<span class="tag you">You</span>' : '',
    p.id === hostId ? '<span class="tag host">Host</span>' : ''
  ].join('');
  return `<span class="avatar" style="background:${avatarColor(p.id)}">${initials(p.name)}</span>
    <span class="pname">${esc(p.name)}</span>${tags}${extra}`;
}

function renderPlayerList(players) {
  if (players.length && !players.some((p) => p.id === hostId)) hostId = players[0].id;
  if (hostId === myId) isHost = true;
  playerList.innerHTML = players.map((p) => `<li>${playerRow(p)}</li>`).join('');
  playerCount.textContent = `${players.length} / ${MAX_PLAYERS}`;

  const need = MIN_PLAYERS - players.length;
  startBtn.hidden = !isHost;
  startBtn.disabled = need > 0;
  if (isHost) {
    startHint.textContent = need > 0 ? `Waiting for ${need} more ninja${need > 1 ? 's' : ''} (minimum ${MIN_PLAYERS}).` : 'Everyone ready? Begin when your team is in.';
  } else {
    startHint.textContent = 'Waiting for the host to begin the night…';
  }
}

function renderGamePlayers(players) {
  playersPanel.innerHTML = players.map((p) =>
    `<div class="player-card ${p.alive === false ? 'dead' : ''}">
      ${playerRow(p, `<span class="honor">${p.honor || 0} ✦</span>`)}
    </div>`
  ).join('');
}

function renderPrivate() {
  if (myHouse) {
    const h = myHouse.house;
    houseDisplay.className = `house-card ${String(h).toLowerCase()}`;
    houseDisplay.innerHTML = `
      <span class="house-sigil">${HOUSE_SIGILS[h] || '?'}</span>
      <span class="house-name">${esc(h)}</span>
      ${myHouse.rank ? `<span class="house-rank">Rank ${esc(myHouse.rank)}</span>` : ''}`;
  }
  handHint.hidden = myHand.length <= 1;
  handDisplay.innerHTML = myHand.map((c, i) => {
    const phaseClass = c.phase === 'Trickster' ? 'trickster' : c.phase === 'React' ? 'react' : c.phase === 'Reveal' ? 'reveal' : '';
    return `<div class="hand-card ${phaseClass}" data-i="${i}" role="button" tabindex="0">
      <span class="card-num">${c.number ? esc(c.number) : '&nbsp;'}</span>
      <span class="card-glyph">${CARD_GLYPHS[c.type] || '✦'}</span>
      <span class="card-type">${esc(c.type)}</span>
    </div>`;
  }).join('') || '<span class="empty-hand">No cards yet</span>';
}

function addLog(msg) {
  const div = document.createElement('div');
  div.textContent = msg;
  log.prepend(div);
}

handDisplay.addEventListener('click', (e) => {
  const card = e.target.closest('.hand-card');
  if (!card) return;
  document.querySelectorAll('.hand-card').forEach((c) => c.classList.remove('selected'));
  card.classList.add('selected');
  socket.emit('draftChoice', { cardIndex: parseInt(card.dataset.i, 10) });
  addLog('Card kept. Waiting for the others…');
});
handDisplay.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('hand-card')) { e.preventDefault(); e.target.click(); }
});
