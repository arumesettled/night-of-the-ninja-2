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
const toasts = $('toasts');

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 11;
const PHASES = ['Draft', 'Spy', 'Mystic', 'Trickster', 'Blind Assassin', 'Shinobi', 'Reveal'];

const CARD_GLYPHS = {
  'Spy': '諜', 'Mystic': '霊', 'Blind Assassin': '刺', 'Shinobi': '忍',
  'Shapeshifter': '変', 'Judge': '判', 'Grave Digger': '墓', 'Spirit Merchant': '商',
  'Thief': '盗', 'Troublemaker': '乱', 'Mirror Monk': '鏡', 'Martyr': '殉', 'Mastermind': '策'
};
const HOUSE_SIGILS = { Crane: '鶴', Lotus: '蓮', Ronin: '浪' };
const AVATAR_COLORS = ['#e2445c', '#4f9dff', '#b18cff', '#34d399', '#f472b6', '#22d3ee', '#fb7185', '#818cf8', '#2dd4bf', '#c084fc', '#60a5fa'];

let S = null;            // latest state from server
let session = null;      // { code, pid } for rejoining
let lastPromptId = null;

try { session = JSON.parse(sessionStorage.getItem('notn-session') || 'null'); } catch { session = null; }

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
function cardName(c) { return c.num ? `${c.type} ${c.num}` : c.type; }
const CLASS_KEY = { 'Spy': 'spy', 'Mystic': 'mystic', 'Trickster': 'trickster', 'Blind Assassin': 'assassin', 'Shinobi': 'shinobi', 'React': 'react', 'Reveal': 'reveal' };
const CLASS_LABEL = { 'React': 'Reaction', 'Reveal': 'Reveal' };
const ENSO = '<svg class="enso" viewBox="0 0 100 100" aria-hidden="true"><path d="M78 24 A38 38 0 1 0 86 52" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round"/><path d="M80 30 A36 36 0 0 0 74 22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" opacity=".6"/></svg>';

function cardHTML(c, extra = '') {
  const key = CLASS_KEY[c.cls] || 'spy';
  const clsLabel = CLASS_LABEL[c.cls] || c.cls;
  const level = c.num ? esc(c.num) : (c.cls === 'React' ? '!' : '★');
  return `<div class="ncard c-${key} ${extra}" title="${esc(cardName(c))}: ${esc(c.text || '')}">
      <div class="nc-top"><span class="nc-level">${level}</span><span class="nc-class">${esc(clsLabel)}</span></div>
      <div class="nc-art">${ENSO}<span class="nc-glyph">${CARD_GLYPHS[c.type] || '✦'}</span></div>
      <div class="nc-name">${esc(c.type)}</div>
      <div class="nc-text">${esc(c.text || '')}</div>
    </div>`;
}

function houseCardHTML(h, showName = true) {
  const k = String(h.house).toLowerCase();
  return `<div class="house-card ${k} hc">
      <span class="house-sigil">${HOUSE_SIGILS[h.house] || '?'}</span>
      <span class="house-seal">${h.rank ? esc(h.rank) : '—'}</span>
      <span class="house-name">${h.house === 'Ronin' ? 'Ronin' : 'House ' + esc(h.house)}</span>
      ${showName && h.name ? `<span class="house-rank">${esc(h.name)}</span>` : ''}
    </div>`;
}
function flipHTML(h, delay = 0, extra = '') {
  return `<div class="flip ${extra}" style="--d:${delay}ms">
      <div class="flip-inner">
        <div class="flip-back"><span>忍</span></div>
        <div class="flip-front">${houseCardHTML(h)}</div>
      </div>
    </div>`;
}

function houseSetText(n) {
  if (n < 2) return '';
  const pairs = Math.floor(n / 2);
  const r = pairs === 1 ? '1' : `1–${pairs}`;
  return `${n} players: Crane ${r} vs Lotus ${r}${n % 2 ? ' + one Ronin' : ''}`;
}

// ---------- Lobby actions ----------
createBtn.onclick = () => {
  const name = playerNameInput.value.trim();
  if (!name) { playerNameInput.focus(); return toast('Pick a ninja name first'); }
  socket.emit('createRoom', name);
};

$('soloBtn').onclick = () => {
  const name = playerNameInput.value.trim();
  if (!name) { playerNameInput.focus(); return toast('Pick a ninja name first'); }
  socket.emit('playSolo', name);
};

$('addBotBtn').onclick = () => socket.emit('addBot');

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
  if (!S) return;
  try { await navigator.clipboard.writeText(S.code); toast('Room code copied', 'ok'); }
  catch { toast(`Room code: ${S.code}`, 'ok'); }
};

startBtn.onclick = () => socket.emit('startGame');

// ---------- Socket events ----------
socket.on('connect', () => {
  if (session) socket.emit('rejoin', session);
});
socket.on('rejoinFailed', () => { session = null; sessionStorage.removeItem('notn-session'); });
socket.on('joined', ({ code, pid }) => {
  session = { code, pid };
  sessionStorage.setItem('notn-session', JSON.stringify(session));
});
socket.on('gameError', (msg) => toast(typeof msg === 'string' ? msg : 'Something went wrong'));
socket.on('state', (state) => { S = state; render(); });

// ---------- Rendering ----------
function render() {
  if (!S) return;
  const inGame = S.stage !== 'lobby';
  lobby.hidden = inGame;
  game.hidden = !inGame;
  document.body.classList.toggle('in-game', inGame);
  if (!inGame) return renderLobby();
  renderGame();
}

function tagsFor(p) {
  return [
    p.pid === S.me ? '<span class="tag you">You</span>' : '',
    p.pid === S.hostPid ? '<span class="tag host">Host</span>' : '',
    p.bot ? '<span class="tag cpu">CPU</span>' : '',
    p.connected === false ? '<span class="tag off">Away</span>' : ''
  ].join('');
}

function renderLobby() {
  $('heroPhoto').hidden = true;
  entryPanel.hidden = true;
  waitingPanel.hidden = false;
  codeText.textContent = S.code;
  const isHost = S.hostPid === S.me;
  playerList.innerHTML = S.players.map((p) => `<li>
      <span class="avatar" style="background:${avatarColor(p.pid)}">${initials(p.name)}</span>
      <span class="pname">${esc(p.name)}</span>${tagsFor(p)}${isHost && p.bot ? `<button class="remove-bot" data-bot="${esc(p.pid)}" title="Remove ${esc(p.name)}">×</button>` : ''}</li>`).join('');
  playerList.querySelectorAll('[data-bot]').forEach((b) => { b.onclick = () => socket.emit('removeBot', b.dataset.bot); });
  $('botControls').hidden = !isHost || S.players.length >= MAX_PLAYERS;
  const humans = S.players.filter((p) => !p.bot).length;
  $('lobbyInfo').textContent = humans === 1 && S.players.length > 1 ? 'Playing against the computer. Friends can still join with this code.' : 'Share this code with your team.';
  playerCount.textContent = `${S.players.length} / ${MAX_PLAYERS}`;
  const need = MIN_PLAYERS - S.players.length;
  startBtn.hidden = !isHost;
  startBtn.disabled = need > 0;
  startBtn.textContent = 'Begin the night';
  $('houseSet').textContent = S.players.length >= MIN_PLAYERS ? houseSetText(S.players.length) : `Houses are set when ${MIN_PLAYERS}+ ninjas are in.`;
  startHint.textContent = isHost
    ? (need > 0 ? `Waiting for ${need} more ninja${need > 1 ? 's' : ''} (minimum ${MIN_PLAYERS}).` : 'Everyone ready? Begin when your team is in.')
    : 'Waiting for the host to begin the night…';
}

function phaseKey() {
  if (!S.phase) return 'Draft';
  if (S.phase.startsWith('Night: ')) return S.phase.slice(7);
  if (S.phase === 'House reveal') return 'Reveal';
  return 'Draft';
}

function renderGame() {
  $('roomDisplay').textContent = `Room ${S.code}`;
  $('roundLabel').textContent = `Round ${S.round || 1}`;
  $('phaseLabel').textContent = S.stage === 'gameOver' ? 'Game over' : (S.phase || '—');
  const pk = phaseKey();
  const cur = PHASES.indexOf(pk);
  $('phaseTrack').innerHTML = PHASES.map((ph, i) =>
    `<span class="pt ${i < cur ? 'past' : ''} ${i === cur ? 'now' : ''}" title="${ph}">${ph === 'Blind Assassin' ? 'Assassin' : ph}</span>`).join('');

  // Players
  $('playersTitle').textContent = `Players · ${houseSetText(S.players.length)}`;
  $('playersPanel').innerHTML = S.players.map((p) => {
    const house = p.house ? `<span class="mini-house ${String(p.houseName).toLowerCase()}">${esc(p.house)}</span>` : '';
    return `<div class="player-card ${p.alive === false ? 'dead' : ''}">
      <span class="avatar" style="background:${avatarColor(p.pid)}">${p.alive === false ? '☠' : initials(p.name)}</span>
      <span class="pname">${esc(p.name)}</span>${tagsFor(p)}${house}
      <span class="honor" title="Honor tokens">${p.tokenCount} ✦</span>
    </div>`;
  }).join('');

  // House
  const hd = $('houseDisplay');
  if (S.myHouse) {
    const h = S.myHouse.house;
    hd.className = `house-card ${h.toLowerCase()}`;
    hd.innerHTML = `<span class="house-sigil">${HOUSE_SIGILS[h] || '?'}</span>
      <span class="house-seal">${S.myHouse.rank ? esc(S.myHouse.rank) : '—'}</span>
      <span class="house-name">${h === 'Ronin' ? 'Ronin' : 'House ' + esc(h)}</span>
      <span class="house-rank">${S.myHouse.rank ? (S.myHouse.rank === 1 ? 'Your house leader' : 'Rank ' + esc(S.myHouse.rank)) : 'Lone wolf: survive to win'}</span>`;
  }
  const me = S.players.find((p) => p.pid === S.me);
  $('honorBox').innerHTML = `<span class="eyebrow">Your honor</span>
    <strong>${me && me.points != null ? me.points : 0}</strong> pts
    <span class="muted small">${S.myTokens.length ? '(' + S.myTokens.join(' + ') + ')' : '· first to 10 wins'}</span>`;

  // Hand
  const cards = S.myCards || [];
  $('handDisplay').innerHTML = cards.length
    ? cards.map((c) => cardHTML(c)).join('')
    : `<span class="empty-hand">${S.stage === 'playing' && phaseKey() === 'Draft' ? 'Draft your cards above.' : 'No ninja cards in hand.'}</span>`;

  // Notes
  const notes = S.notes || [];
  $('notes').innerHTML = notes.length
    ? notes.map((n) => `<div class="note">${esc(n)}</div>`).join('')
    : '<p class="muted small">What you learn tonight appears here. Only you can see it.</p>';

  // Played cards
  const played = S.played || [];
  $('playedBox').hidden = !played.length;
  $('playedList').innerHTML = played.map((x) => `<div class="played ${x.status || ''}">
      ${cardHTML(x.card, 'small')}
      <span class="played-by">${esc(x.name)}${x.status === 'fizzled' ? ' · fizzled' : x.status === 'active' ? ' · acting' : ''}</span>
    </div>`).join('');

  // Log
  $('log').innerHTML = (S.log || []).slice().reverse().map((m) => `<div>${esc(m)}</div>`).join('');

  renderAction();
}

function renderAction() {
  const area = $('actionArea');
  if (!S.prompt) area.dataset.prompt = '';
  const isHost = S.hostPid === S.me;
  const me = S.players.find((p) => p.pid === S.me);

  if (S.stage === 'gameOver' && S.final) {
    area.hidden = false;
    area.className = 'card action-card result';
    area.innerHTML = `<span class="eyebrow">Victory</span>
      <h2 class="result-title">🏆 ${esc(S.final.champions.join(' & '))}</h2>
      <div class="scores">${S.final.scores.map((s) => `<div><span>${esc(s.name)}</span><strong>${s.points}</strong></div>`).join('')}</div>
      ${isHost ? '<button class="btn btn-primary" id="nextBtn">Play again</button>' : '<p class="muted small">Waiting for the host to start a new game…</p>'}`;
    bindNext();
    return;
  }

  if (S.stage === 'roundEnd' && S.result) {
    area.hidden = false;
    area.className = 'card action-card result';
    const won = S.result.gainers.includes(me && me.name);
    area.innerHTML = `<span class="eyebrow">House reveal</span>
      <h2 class="result-title">${S.result.winner ? `House ${esc(S.result.winner)} wins` : 'No house wins'}</h2>
      <p>${esc(S.result.reason)}</p>
      <p class="muted small">${S.result.gainers.length ? 'Honor tokens to: ' + esc(S.result.gainers.join(', ')) : 'No honor tokens this round.'}${won ? ' (including you!)' : ''}</p>
      ${isHost ? '<button class="btn btn-primary" id="nextBtn">Start next round</button>' : '<p class="muted small">Waiting for the host to start the next round…</p>'}`;
    bindNext();
    return;
  }

  const pr = S.prompt;
  if (pr) {
    if (area.dataset.prompt === pr.id) return; // keep the open prompt steady while others act
    area.dataset.prompt = pr.id;
    area.hidden = false;
    area.className = `card action-card prompt ${pr.kind}`;
    const cards = pr.cards || (pr.kind === 'draft' ? S.draftHand : null);
    const killing = pr.kind === 'target' && /kill/i.test(pr.text + pr.title);
    let visual = '';
    if (pr.houses && pr.houses.length) visual += `<div class="prompt-houses">${pr.houses.map((h, i) => flipHTML(h, i * 250)).join('')}</div>`;
    if (cards && cards.length) {
      visual += pr.pick
        ? `<div class="hand pick">${cards.map((c) => `<button class="pick-card" data-v="${esc(c.id)}">${cardHTML(c)}</button>`).join('')}</div>`
        : `<div class="hand prompt-cards">${cards.map((c) => cardHTML(c)).join('')}</div>`;
    }
    const optionBtn = (o, i) => `<button class="btn ${i === pr.options.length - 1 && pr.options.length > 1 && /hold|don't|spare|leave|keep it secret|accept|pass/i.test(o.label) ? 'btn-secondary' : 'btn-primary'}" data-v="${esc(o.value)}">${esc(o.label)}</button>`;
    const targetBtn = (o, i) => {
      const p = S.players.find((x) => x.pid === o.value);
      if (!p) return optionBtn(o, i);
      const known = p.house ? `<span class="mini-house ${String(p.houseName).toLowerCase()}">${esc(p.house)}</span>` : '';
      return `<button class="target-tile ${killing ? 'danger' : ''}" data-v="${esc(o.value)}">
          <span class="avatar" style="background:${avatarColor(p.pid)}">${initials(p.name)}</span>
          <span class="pname">${esc(o.label)}</span>${known}${killing ? '<span class="tt-icon">🗡</span>' : ''}
        </button>`;
    };
    const buttons = pr.pick ? '' : pr.kind === 'target'
      ? `<div class="targets">${pr.options.map(targetBtn).join('')}</div>`
      : `<div class="options">${pr.options.map(optionBtn).join('')}</div>`;
    area.innerHTML = `<span class="eyebrow">${pr.kind === 'react' ? 'Quick, decide!' : killing ? 'Choose your target' : 'Your move'}</span>
      <h2>${esc(pr.title)}</h2>
      <p>${esc(pr.text)}</p>
      ${visual}${buttons}`;
    area.classList.toggle('killing', killing);
    area.querySelectorAll('[data-v]').forEach((b) => {
      b.onclick = () => {
        const opt = pr.options.find((o) => String(o.value) === b.dataset.v);
        if (!opt) return;
        area.querySelectorAll('button').forEach((x) => { x.disabled = true; });
        socket.emit('answer', { promptId: pr.id, value: opt.value });
      };
    });
    if (pr.id !== lastPromptId) {
      if (pr.kind === 'react' && navigator.vibrate) navigator.vibrate(200);
      const r = area.getBoundingClientRect();
      if (r.top < 0 || r.top > window.innerHeight * 0.6) area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    lastPromptId = pr.id;
    return;
  }

  if (S.waiting) {
    area.hidden = false;
    area.className = 'card action-card waiting-note';
    area.innerHTML = `<span class="spinner"></span><span>${esc(S.waiting)}</span>${me && me.alive === false ? '<span class="muted small"> You are dead this round, but you can still talk to your team.</span>' : ''}`;
    return;
  }
  area.hidden = true;
}

function bindNext() {
  const b = $('nextBtn');
  if (b) b.onclick = () => { b.disabled = true; socket.emit('startGame'); };
}


// ---------- Shared animations ----------
const fxRoot = $('fx');
const fxQueue = [];
let fxBusy = false;
const PHASE_GLYPH = { 'Spy': '諜', 'Mystic': '霊', 'Trickster': '変', 'Blind Assassin': '刺', 'Shinobi': '忍' };

socket.on('fx', (ev) => { fxQueue.push(ev); if (!fxBusy) nextFx(); });

function nextFx() {
  const ev = fxQueue.shift();
  if (!ev) { fxBusy = false; return; }
  fxBusy = true;
  const built = buildFx(ev);
  if (!built) return nextFx();
  const el = document.createElement('div');
  el.className = `fx-layer ${built.cls}`;
  el.innerHTML = built.html;
  fxRoot.appendChild(el);
  if (built.shake) { document.body.classList.remove('shake'); void document.body.offsetWidth; document.body.classList.add('shake'); }
  requestAnimationFrame(() => el.classList.add('in'));
  const ms = fxQueue.length > 1 ? Math.min(built.ms, 1400) : built.ms; // catch up if events pile up
  let done = false;
  const close = () => {
    if (done) return; done = true;
    el.classList.add('out');
    setTimeout(() => { el.remove(); nextFx(); }, 380);
  };
  el.addEventListener('click', close);
  setTimeout(close, ms);
}

function buildFx(ev) {
  const meName = (S && S.players.find((p) => p.pid === S.me) || {}).name;
  switch (ev.type) {
    case 'phase': {
      const n = ev.plays.length;
      return {
        cls: 'fx-phase', ms: n ? 1700 + 450 * n : 1100,
        html: `<div class="fx-panel">
            <span class="fx-kanji">${PHASE_GLYPH[ev.phase] || '夜'}</span>
            <span class="eyebrow">Night falls</span>
            <h2 class="fx-title">${esc(ev.phase)} phase</h2>
            ${n ? `<div class="fx-cards">${ev.plays.map((x, i) => `<div class="fx-dealt" style="--d:${250 + i * 300}ms">${cardHTML(x.card)}<span class="fx-who">${x.pid === S.me ? 'You' : esc(x.name)}</span></div>`).join('')}</div>`
              : `<p class="fx-sub">No one reveals a ${esc(ev.phase)}.</p>`}
          </div>`
      };
    }
    case 'kill': {
      const me = ev.pid === (S && S.me);
      const how = ev.reflected ? `reflected by ${esc(ev.by)}'s Mirror Monk` : ev.card ? `by ${esc(ev.by)}'s ${esc(cardName(ev.card))}` : '';
      return {
        cls: `fx-kill ${me ? 'is-me' : ''}`, ms: 2900, shake: true,
        html: `<div class="fx-blood"></div><div class="fx-slash"></div><div class="fx-slash two"></div>
          <div class="fx-panel">
            <span class="fx-kanji kill">死</span>
            <h2 class="fx-title">${me ? 'You have been killed' : esc(ev.name)}</h2>
            <p class="fx-sub">${me ? how : 'has been killed ' + how}</p>
          </div>`
      };
    }
    case 'react':
      return {
        cls: `fx-react ${ev.react === 'Martyr' ? 'martyr' : 'mirror'}`, ms: 2200, shake: ev.react !== 'Martyr',
        html: `<div class="fx-panel">
            <span class="eyebrow">${ev.name === meName ? 'You react!' : esc(ev.name) + ' reacts!'}</span>
            <div class="fx-cards"><div class="fx-dealt big" style="--d:100ms">${cardHTML(ev.card)}</div></div>
            <h2 class="fx-title">${esc(ev.react)}</h2>
            <p class="fx-sub">${esc(ev.text)}</p>
          </div>`
      };
    case 'house':
      return {
        cls: 'fx-house', ms: 2500,
        html: `<div class="fx-panel">
            <span class="eyebrow">${esc(ev.title)}</span>
            <div class="fx-flips">${flipHTML(ev, 350, 'big')}</div>
            <h2 class="fx-title">${ev.pid === S.me ? 'You' : esc(ev.name)}: ${ev.house === 'Ronin' ? 'Ronin' : esc(ev.house) + ' ' + esc(ev.rank)}</h2>
          </div>`
      };
    case 'peek':
      return {
        cls: 'fx-peek', ms: ev.cards && ev.cards.length ? 3000 : 2400,
        html: `<div class="fx-panel">
            <span class="eyebrow">🤫 ${esc(ev.title)}</span>
            <div class="fx-flips">${ev.houses.map((h, i) => flipHTML(h, 300 + i * 250, 'big')).join('')}
              ${(ev.cards || []).map((c) => `<div class="fx-dealt" style="--d:900ms">${cardHTML(c)}</div>`).join('')}</div>
            ${ev.caption ? `<p class="fx-sub">${esc(ev.caption)}</p>` : ''}
          </div>`
      };
    case 'notice':
      return {
        cls: 'fx-notice', ms: 2200,
        html: `<div class="fx-panel">
            ${ev.card ? `<div class="fx-cards"><div class="fx-dealt fizzled" style="--d:0ms">${cardHTML(ev.card)}</div></div>` : ''}
            <h2 class="fx-title">${esc(ev.title)}</h2>
            <p class="fx-sub">${esc(ev.text)}</p>
          </div>`
      };
    case 'roundReveal': {
      const n = ev.players.length;
      const end = 600 + n * 450;
      return {
        cls: 'fx-round', ms: end + 3200,
        html: `<div class="fx-panel wide">
            <span class="eyebrow">Dawn breaks</span>
            <h2 class="fx-title">House reveal</h2>
            <div class="fx-flips grid">${ev.players.map((p, i) => `<div class="rr ${p.alive ? '' : 'dead'} ${ev.winner && p.house === ev.winner ? 'won' : ''}">
                ${flipHTML(p, 600 + i * 450)}${p.mastermind ? '<span class="rr-badge">策 Mastermind</span>' : ''}
                <span class="rr-name">${p.pid === S.me ? 'You' : esc(p.name)}${p.alive ? '' : ' ☠'}</span>
              </div>`).join('')}</div>
            <div class="fx-verdict" style="--d:${end + 300}ms">
              <h3>${ev.winner ? `House ${esc(ev.winner)} wins` : 'No house wins'}</h3>
              <p class="fx-sub">${esc(ev.reason)}</p>
            </div>
          </div>`
      };
    }
  }
  return null;
}
