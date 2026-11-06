const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 11;
const WIN_POINTS = 10;

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------
const PHASES = ['Spy', 'Mystic', 'Trickster', 'Blind Assassin', 'Shinobi'];

const TRICKSTERS = [
  { type: 'Shapeshifter', num: 1, text: 'Look at the HOUSE cards of two players. You may secretly swap them. They may not look at their new HOUSES.' },
  { type: 'Grave Digger', num: 2, text: 'Look at two discarded NINJA cards and pick one. Play it immediately or keep it for later.' },
  { type: 'Troublemaker', num: 3, text: "Look at another player's HOUSE card. You may reveal it." },
  { type: 'Spirit Merchant', num: 4, text: "Look at another player's HONOR tokens or HOUSE card. You may swap one HONOR token with them." },
  { type: 'Thief', num: 5, text: 'Reveal your HOUSE card. You may take one HONOR token from a player who has more than you.' },
  { type: 'Judge', num: 6, text: 'Reveal your HOUSE card. Choose a player and KILL them. Mirror Monks and Martyrs do not work on the Judge.' }
];

const CLASS_TEXT = {
  'Spy': "Look at another player's HOUSE card.",
  'Mystic': 'Look at the HOUSE card and one NINJA card of another player.',
  'Blind Assassin': 'Choose a player and KILL them.',
  'Shinobi': 'Choose a player. Look at their HOUSE card. You may choose to KILL them.'
};

function createNinjaDeck() {
  const deck = [];
  let id = 0;
  for (const cls of ['Spy', 'Mystic', 'Blind Assassin', 'Shinobi']) {
    for (let num = 1; num <= 6; num++) deck.push({ id: id++, type: cls, cls, num, text: CLASS_TEXT[cls] });
  }
  for (const t of TRICKSTERS) deck.push({ id: id++, type: t.type, cls: 'Trickster', num: t.num, text: t.text });
  deck.push({ id: id++, type: 'Mirror Monk', cls: 'React', num: 0, text: 'React: reveal if a Shinobi or Blind Assassin chooses to KILL you. KILL them instead.' });
  deck.push({ id: id++, type: 'Martyr', cls: 'React', num: 0, text: 'React: reveal if a Shinobi or Blind Assassin chooses to KILL you. Gain an HONOR token.' });
  deck.push({ id: id++, type: 'Mastermind', cls: 'Reveal', num: 0, text: 'If you are still alive during the Reveal, your HOUSE wins the round. (If you are the Ronin, no HOUSE wins.)' });
  return shuffle(deck); // 33 cards
}

function cardName(c) { return c.num ? `${c.type} ${c.num}` : c.type; }

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createHouseCards(n) {
  const houses = [];
  for (let r = 1; r <= Math.floor(n / 2); r++) {
    houses.push({ house: 'Crane', rank: r });
    houses.push({ house: 'Lotus', rank: r });
  }
  if (n % 2 === 1) houses.push({ house: 'Ronin', rank: 0 });
  return shuffle(houses);
}

function createTokenPool() {
  const pool = [];
  for (let i = 0; i < 35; i++) pool.push([2, 3, 4][i % 3]);
  return shuffle(pool);
}

function houseLabel(h) { return h.house === 'Ronin' ? 'Ronin' : `${h.house} ${h.rank}`; }
function generateRoomCode() {
  let c;
  do { c = Math.random().toString(36).substring(2, 7).toUpperCase(); } while (c.length < 5 || rooms.has(c));
  return c;
}

// ---------------------------------------------------------------------------
// Room helpers
// ---------------------------------------------------------------------------
function P(room, pid) { return room.players.find(p => p.pid === pid); }
function nameOf(room, pid) { const p = P(room, pid); return p ? p.name : '?'; }
function points(p) { return p.tokens.reduce((a, b) => a + b, 0); }

function log(room, msg) {
  if (!room.game) return;
  room.game.log.push(msg);
}
function note(room, pid, msg) {
  if (!room.game) return;
  (room.game.notes[pid] = room.game.notes[pid] || []).push(msg);
}
function drawToken(room) {
  if (room.tokenPool.length === 0) room.tokenPool = createTokenPool();
  return room.tokenPool.pop();
}

// Ask a player something and wait for the answer. Disconnected players get the default.
function ask(room, pid, prompt) {
  const p = P(room, pid);
  const def = prompt.default !== undefined ? prompt.default : (prompt.options && prompt.options.length ? prompt.options[prompt.options.length - 1].value : null);
  const { ai, ...pub } = prompt; // `ai` hints are for computer players only, never sent to clients
  if (p && p.bot) {
    const delay = prompt.kind === 'draft' ? 500 + Math.random() * 1000 : 900 + Math.random() * 1300;
    return new Promise((resolve) => setTimeout(() => {
      let v;
      try { v = botDecide(room, pid, prompt); } catch (e) { console.error('Bot error', e); v = def; }
      const opts = prompt.options || [];
      if (opts.length && !opts.some(o => o.value === v)) v = def;
      resolve(v);
    }, delay));
  }
  if (!p || !p.connected) return Promise.resolve(def);
  return new Promise((resolve) => {
    const id = crypto.randomBytes(6).toString('hex');
    room.pending[pid] = { id, prompt: { ...pub, id }, resolve, def };
    sync(room);
  });
}

// ---------------------------------------------------------------------------
// Computer players
// ---------------------------------------------------------------------------
const BOT_NAMES = ['Kage', 'Hanzo', 'Tsubaki', 'Raiden', 'Mizuki', 'Kaito', 'Sora', 'Yuki', 'Ren', 'Akane', 'Jin', 'Hoshi'];
const DRAFT_VALUE = {
  'Mastermind': 10, 'Mirror Monk': 8, 'Judge': 8, 'Shinobi': 7, 'Blind Assassin': 6, 'Martyr': 5,
  'Thief': 4, 'Troublemaker': 4, 'Spirit Merchant': 4, 'Spy': 4, 'Mystic': 4, 'Shapeshifter': 3, 'Grave Digger': 3
};
const pickRandom = (a) => a[Math.floor(Math.random() * a.length)];

function addBot(room) {
  const taken = new Set(room.players.map(p => p.name.toLowerCase()));
  const free = BOT_NAMES.filter(n => !taken.has(n.toLowerCase()));
  const name = free.length ? pickRandom(free) : `Ninja ${room.players.length + 1}`;
  room.players.push({ pid: 'bot-' + crypto.randomBytes(6).toString('hex'), sid: null, name, connected: true, bot: true, tokens: [] });
}

// What a bot has seen of each player's house this round
function learn(room, viewer, target) {
  const g = room.game;
  const p = P(room, viewer);
  if (!g || !p || !p.bot) return;
  (g.seen[viewer] = g.seen[viewer] || {})[target] = { ...g.houses[target] };
}
function botKnows(room, me, t) {
  const g = room.game;
  if (g.revealed[t]) return g.houses[t];
  return (g.seen[me] || {})[t] || null;
}
function botRelation(room, me, t) {
  const h = botKnows(room, me, t);
  if (!h) return 'unknown';
  const mine = room.game.knownHouse[me];
  if (mine.house === 'Ronin' || h.house === 'Ronin' || h.house !== mine.house) return 'enemy';
  return 'ally';
}
function botPickTarget(room, me, opts, goal) {
  const players = opts.filter(o => P(room, o.value));
  if (!players.length) return opts.length ? opts[opts.length - 1].value : null;
  const rel = (o) => botRelation(room, me, o.value);
  const rankOf = (o) => { const h = botKnows(room, me, o.value); return h ? (h.rank || 0) : 99; };
  const enemies = players.filter(o => rel(o) === 'enemy').sort((a, b) => rankOf(a) - rankOf(b));
  const unknown = players.filter(o => rel(o) === 'unknown');
  const allies = players.filter(o => rel(o) === 'ally').sort((a, b) => rankOf(b) - rankOf(a));
  if (goal === 'kill') return (enemies[0] || pickRandom(unknown.length ? unknown : allies)).value;
  if (goal === 'shinobi') return (enemies[0] || (unknown.length ? pickRandom(unknown) : allies[0])).value;
  // information: look at someone we know nothing about
  return pickRandom(unknown.length ? unknown : players).value;
}

function botDecide(room, me, prompt) {
  const g = room.game;
  const opts = prompt.options || [];
  const ai = prompt.ai || {};
  switch (prompt.kind) {
    case 'draft': {
      const cards = ai.cards || [];
      const scored = cards.map(c => ({ c, s: (DRAFT_VALUE[c.type] || 3) + Math.random() * 2.5 }));
      scored.sort((a, b) => b.s - a.s);
      return scored.length ? scored[0].c.id : prompt.default;
    }
    case 'declare':
      if (Math.random() < 0.1) return 'pass';
      return opts.some(o => o.value === 'all') ? 'all' : opts[0].value;
    case 'react':
      if (opts.some(o => o.value === 'Mirror Monk')) return 'Mirror Monk';
      if (opts.some(o => o.value === 'Martyr')) return 'Martyr';
      return 'none';
    case 'target':
      if (ai.goal === 'steal') {
        const rich = opts.filter(o => o.value !== 'none').sort((a, b) => P(room, b.value).tokens.length - P(room, a.value).tokens.length);
        return rich.length ? rich[0].value : 'none';
      }
      return botPickTarget(room, me, opts, ai.goal);
    case 'choice':
      switch (ai.goal) {
        case 'shinobiKill': return botRelation(room, me, ai.target) === 'ally' ? 'spare' : 'kill';
        case 'expose': return botRelation(room, me, ai.target) === 'enemy' ? 'reveal' : 'hide';
        case 'swapHouses': return Math.random() < 0.35 ? 'swap' : 'keep';
        case 'merchantLook': return 'house';
        case 'merchantGive': {
          const mine = P(room, me).tokens;
          if (!mine.length) return 'none';
          const lo = Math.min(...mine);
          return lo <= 2 ? `m${mine.indexOf(lo)}` : 'none';
        }
        case 'merchantTake': {
          const theirs = P(room, ai.target).tokens;
          return `t${theirs.indexOf(Math.max(...theirs))}`;
        }
        case 'digPick': {
          const cards = (ai.cards || []).slice().sort((a, b) => (DRAFT_VALUE[b.type] || 0) - (DRAFT_VALUE[a.type] || 0));
          return cards.length ? String(cards[0].id) : opts[0].value;
        }
        case 'digUse': return 'now';
      }
      return prompt.default !== undefined ? prompt.default : (opts[0] && opts[0].value);
  }
  return prompt.default;
}

function answer(room, pid, promptId, value) {
  const pend = room.pending[pid];
  if (!pend || pend.id !== promptId) return;
  const opts = pend.prompt.options || [];
  if (opts.length && !opts.some(o => o.value === value)) return; // reject invalid choices
  delete room.pending[pid];
  pend.resolve(value);
}

function cancelPending(room, pid) {
  const pend = room.pending[pid];
  if (pend) { delete room.pending[pid]; pend.resolve(pend.def); }
}

// Shared animations: every player sees these, and the game waits for them to play
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function fx(room, ev) { io.to(room.code).emit('fx', ev); }
function isHuman(room, pid) { const p = P(room, pid); return !!(p && !p.bot && p.connected && p.sid); }
async function fxPrivate(room, pid, ev, ms) {
  if (!isHuman(room, pid)) return;
  io.to(P(room, pid).sid).emit('fx', ev);
  if (ms) await sleep(ms);
}
const houseView = (room, pid) => ({ pid, name: nameOf(room, pid), house: room.game.houses[pid].house, rank: room.game.houses[pid].rank });

function setWaiting(room, text) { if (room.game) room.game.waiting = text; sync(room); }

// Player options for target prompts
function playerOptions(room, filter) {
  return room.players.filter(filter).map(p => ({ value: p.pid, label: p.name + (room.game.dead[p.pid] ? ' (dead)' : '') }));
}
const others = (room, me) => (p) => p.pid !== me;
const otherAlive = (room, me) => (p) => p.pid !== me && !room.game.dead[p.pid];

// ---------------------------------------------------------------------------
// Personalised state sent to each player
// ---------------------------------------------------------------------------
function stateFor(room, pid) {
  const g = room.game;
  const me = P(room, pid);
  const s = {
    code: room.code,
    me: pid,
    hostPid: room.hostPid,
    stage: room.state,
    round: room.round,
    players: room.players.map(p => ({
      pid: p.pid,
      name: p.name,
      connected: p.connected,
      bot: !!p.bot,
      alive: g ? !g.dead[p.pid] : true,
      tokenCount: p.tokens.length,
      points: room.state === 'gameOver' || p.pid === pid ? points(p) : null,
      house: g && (g.revealed[p.pid] || g.stage === 'reveal') ? houseLabel(g.houses[p.pid]) : null,
      houseName: g && (g.revealed[p.pid] || g.stage === 'reveal') ? g.houses[p.pid].house : null
    })),
    myTokens: me ? me.tokens.slice() : [],
    prompt: room.pending[pid] ? room.pending[pid].prompt : null
  };
  if (g) {
    const known = g.revealed[pid] || g.stage === 'reveal' ? g.houses[pid] : g.knownHouse[pid];
    s.phase = g.phaseLabel;
    s.myHouse = known ? { house: known.house, rank: known.rank, label: houseLabel(known) } : null;
    s.myCards = (g.hands[pid] || []).map(c => ({ ...c }));
    s.draftHand = g.draftView[pid] || null;
    s.notes = g.notes[pid] || [];
    s.log = g.log.slice(-60);
    s.played = g.played.map(x => ({ name: nameOf(room, x.pid), card: x.card, status: x.status }));
    s.waiting = g.waiting;
    s.result = g.result || null;
  }
  if (room.state === 'gameOver') s.final = room.final;
  return s;
}

function sync(room) {
  for (const p of room.players) {
    if (p.connected && p.sid) io.to(p.sid).emit('state', stateFor(room, p.pid));
  }
}

// ---------------------------------------------------------------------------
// Round flow
// ---------------------------------------------------------------------------
async function playRound(room) {
  const players = room.players;
  const n = players.length;
  const houseCards = createHouseCards(n);
  const deck = createNinjaDeck();
  room.round += 1;

  const g = room.game = {
    stage: 'draft',
    phaseLabel: 'Draft',
    houses: {}, knownHouse: {}, hands: {}, draftView: {},
    discard: [], played: [], dead: {}, revealed: {}, notes: {}, log: [], seen: {},
    waiting: '', result: null
  };
  players.forEach((p, i) => {
    g.houses[p.pid] = houseCards[i];
    g.knownHouse[p.pid] = { ...houseCards[i] };
    g.hands[p.pid] = [];
  });
  log(room, `Round ${room.round} begins. Everyone has a secret house.`);

  // ---- Draft: keep 1 of 3, pass 2 left, keep 1 of 2, discard 1 ----
  const packs = {};
  players.forEach(p => { packs[p.pid] = deck.splice(0, 3); });

  const pickFrom = async (pickLabel) => {
    const picks = await Promise.all(players.map(async (p) => {
      g.draftView[p.pid] = packs[p.pid];
      const v = await ask(room, p.pid, {
        kind: 'draft',
        title: pickLabel,
        text: 'Choose a card to keep.',
        options: packs[p.pid].map(c => ({ value: c.id, label: cardName(c) })),
        default: packs[p.pid][0].id,
        cards: packs[p.pid], pick: true,
        ai: { cards: packs[p.pid] }
      });
      const idx = Math.max(0, packs[p.pid].findIndex(c => c.id === v));
      const kept = packs[p.pid].splice(idx, 1)[0];
      g.hands[p.pid].push(kept);
      delete g.draftView[p.pid];
      sync(room);
      return kept;
    }));
    return picks;
  };

  setWaiting(room, 'Everyone is choosing a card to keep…');
  await pickFrom('Draft: first pick');
  // pass the remaining two cards to the left (next player in seat order)
  const passed = {};
  players.forEach((p, i) => { passed[players[(i + 1) % n].pid] = packs[p.pid]; });
  players.forEach(p => { packs[p.pid] = passed[p.pid]; });
  log(room, 'Everyone passes their other two cards to the left.');
  setWaiting(room, 'Everyone is choosing their second card…');
  await pickFrom('Draft: second pick (the other card is discarded)');
  players.forEach(p => { g.discard.push(...packs[p.pid]); packs[p.pid] = []; });
  log(room, 'Draft complete. Each ninja holds two cards. The night begins…');

  // ---- The Night ----
  g.stage = 'night';
  for (const cls of PHASES) {
    g.phaseLabel = `Night: ${cls}`;
    log(room, `— ${cls} phase —`);
    const eligible = players.filter(p => !g.dead[p.pid] && g.hands[p.pid].some(c => c.cls === cls));
    setWaiting(room, `Ninjas may reveal a ${cls} card…`);

    const plays = [];
    await Promise.all(eligible.map(async (p) => {
      const matching = g.hands[p.pid].filter(c => c.cls === cls);
      const options = matching.map(c => ({ value: String(c.id), label: `Play ${cardName(c)}` }));
      if (matching.length > 1) options.push({ value: 'all', label: 'Play both' });
      options.push({ value: 'pass', label: 'Hold it back (it will be lost)' });
      const v = await ask(room, p.pid, {
        kind: 'declare',
        title: `${cls} phase`,
        text: `You hold ${matching.map(cardName).join(' and ')}. Play now? If you don't, you can't play it later this round.`,
        options,
        cards: matching,
        default: 'pass'
      });
      const chosen = v === 'all' ? matching : matching.filter(c => String(c.id) === v);
      for (const c of matching) g.hands[p.pid] = g.hands[p.pid].filter(h => h.id !== c.id);
      for (const c of chosen) plays.push({ pid: p.pid, card: c });
    }));

    plays.sort((a, b) => a.card.num - b.card.num);
    fx(room, { type: 'phase', phase: cls, plays: plays.map(x => ({ pid: x.pid, name: nameOf(room, x.pid), card: x.card })) });
    await sleep(plays.length ? 1900 + 500 * plays.length : 1300);
    if (plays.length === 0) { log(room, `No one plays a ${cls}.`); sync(room); continue; }
    for (const x of plays) {
      x.status = 'waiting';
      g.played.push(x);
      log(room, `${nameOf(room, x.pid)} reveals ${cardName(x.card)}.`);
    }
    sync(room);

    for (const x of plays) {
      if (g.dead[x.pid]) {
        x.status = 'fizzled';
        log(room, `${nameOf(room, x.pid)} is dead, so ${cardName(x.card)} does nothing.`);
        note(room, x.pid, `You were killed before your ${cardName(x.card)} could act.`);
        sync(room);
        await fxPrivate(room, x.pid, { type: 'notice', title: 'Too late', text: `You were killed before your ${cardName(x.card)} could act.`, card: x.card }, 2400);
        continue;
      }
      x.status = 'active';
      setWaiting(room, `${nameOf(room, x.pid)} is using ${cardName(x.card)}…`);
      await resolveCard(room, x.pid, x.card);
      x.status = 'done';
      sync(room);
    }
  }

  // ---- House reveal ----
  g.stage = 'reveal';
  g.phaseLabel = 'House reveal';
  g.waiting = '';
  await scoreRound(room);
}

async function resolveCard(room, pid, card) {
  const g = room.game;
  const me = nameOf(room, pid);
  switch (card.type) {
    case 'Spy': {
      const t = await ask(room, pid, { kind: 'target', title: cardName(card), text: card.text, options: playerOptions(room, others(room, pid)) });
      learn(room, pid, t);
      log(room, `${me} spies on ${nameOf(room, t)}'s house.`);
      note(room, pid, `${cardName(card)}: ${nameOf(room, t)} is ${houseLabel(g.houses[t])}.`);
      sync(room);
      await fxPrivate(room, pid, { type: 'peek', title: `${cardName(card)}: only you can see this`, houses: [houseView(room, t)] }, 2600);
      break;
    }
    case 'Mystic': {
      const t = await ask(room, pid, { kind: 'target', title: cardName(card), text: card.text, options: playerOptions(room, others(room, pid)) });
      learn(room, pid, t);
      log(room, `${me} reads ${nameOf(room, t)}'s house and a ninja card.`);
      const held = g.hands[t];
      const seen = held.length ? held[Math.floor(Math.random() * held.length)] : null;
      note(room, pid, `${cardName(card)}: ${nameOf(room, t)} is ${houseLabel(g.houses[t])}, and holds ${seen ? cardName(seen) : 'no ninja cards'}.`);
      sync(room);
      await fxPrivate(room, pid, { type: 'peek', title: `${cardName(card)}: only you can see this`, houses: [houseView(room, t)], cards: seen ? [seen] : [], caption: seen ? `${nameOf(room, t)} also holds ${cardName(seen)}` : `${nameOf(room, t)} holds no ninja cards` }, 3200);
      break;
    }
    case 'Shapeshifter': {
      const a = await ask(room, pid, { kind: 'target', title: cardName(card), text: 'Choose the first player.', options: playerOptions(room, others(room, pid)) });
      const b = await ask(room, pid, { kind: 'target', title: cardName(card), text: 'Choose the second player.', options: playerOptions(room, p => p.pid !== pid && p.pid !== a) });
      const swap = await ask(room, pid, {
        kind: 'choice', title: cardName(card),
        text: `${nameOf(room, a)} is ${houseLabel(g.houses[a])}. ${nameOf(room, b)} is ${houseLabel(g.houses[b])}. Swap their houses? They won't know.`,
        options: [{ value: 'swap', label: 'Swap them' }, { value: 'keep', label: 'Leave them' }], default: 'keep',
        houses: [houseView(room, a), houseView(room, b)],
        ai: { goal: 'swapHouses' }
      });
      note(room, pid, `${cardName(card)}: ${nameOf(room, a)} was ${houseLabel(g.houses[a])}, ${nameOf(room, b)} was ${houseLabel(g.houses[b])}.${swap === 'swap' ? ' You swapped them.' : ''}`);
      if (swap === 'swap') { const tmp = g.houses[a]; g.houses[a] = g.houses[b]; g.houses[b] = tmp; }
      learn(room, pid, a); learn(room, pid, b);
      log(room, `${me} looks at ${nameOf(room, a)} and ${nameOf(room, b)}'s houses…`);
      break;
    }
    case 'Grave Digger': {
      if (g.discard.length === 0) { log(room, `${me} digs, but the discard pile is empty.`); break; }
      const offered = shuffle(g.discard.slice()).slice(0, 2);
      const pick = await ask(room, pid, { kind: 'choice', title: cardName(card), text: 'Pick one discarded card.', options: offered.map(c => ({ value: String(c.id), label: cardName(c) })), default: String(offered[0].id), cards: offered, pick: true, ai: { goal: 'digPick', cards: offered } });
      const dug = offered.find(c => String(c.id) === pick) || offered[0];
      g.discard = g.discard.filter(c => c.id !== dug.id);
      const usable = !['React', 'Reveal'].includes(dug.cls);
      const how = usable ? await ask(room, pid, {
        kind: 'choice', title: cardName(card), text: `You dug up ${cardName(dug)}. Use it now, or keep it for its own phase?`,
        options: [{ value: 'now', label: 'Use it now' }, { value: 'keep', label: 'Keep it for later' }], default: 'keep',
        cards: [dug],
        ai: { goal: 'digUse' }
      }) : 'keep';
      if (how === 'now') {
        log(room, `${me} digs up ${cardName(dug)} and uses it immediately!`);
        g.played.push({ pid, card: dug, status: 'active' });
        sync(room);
        await resolveCard(room, pid, dug);
        g.played[g.played.length - 1].status = 'done';
      } else {
        g.hands[pid].push(dug);
        log(room, `${me} digs up a card and keeps it for later.`);
        note(room, pid, `${cardName(card)}: you kept ${cardName(dug)}.`);
      }
      break;
    }
    case 'Troublemaker': {
      const t = await ask(room, pid, { kind: 'target', title: cardName(card), text: card.text, options: playerOptions(room, others(room, pid)) });
      learn(room, pid, t);
      const rev = await ask(room, pid, {
        kind: 'choice', title: cardName(card), text: `${nameOf(room, t)} is ${houseLabel(g.houses[t])}. Reveal it to everyone?`,
        options: [{ value: 'reveal', label: 'Reveal it' }, { value: 'hide', label: 'Keep it secret' }], default: 'hide',
        houses: [houseView(room, t)],
        ai: { goal: 'expose', target: t }
      });
      note(room, pid, `${cardName(card)}: ${nameOf(room, t)} is ${houseLabel(g.houses[t])}.`);
      if (rev === 'reveal') {
        g.revealed[t] = true;
        log(room, `${me} exposes ${nameOf(room, t)}: ${houseLabel(g.houses[t])}!`);
        sync(room);
        fx(room, { type: 'house', title: `${me}'s Troublemaker exposes`, ...houseView(room, t) });
        await sleep(2800);
      }
      else log(room, `${me} looks at ${nameOf(room, t)}'s house and keeps quiet.`);
      break;
    }
    case 'Spirit Merchant': {
      const t = await ask(room, pid, { kind: 'target', title: cardName(card), text: card.text, options: playerOptions(room, others(room, pid)) });
      const tp = P(room, t), mp = P(room, pid);
      const look = await ask(room, pid, {
        kind: 'choice', title: cardName(card), text: `Look at ${tp.name}'s honor tokens or house card?`,
        options: [{ value: 'tokens', label: 'Honor tokens' }, { value: 'house', label: 'House card' }], default: 'house',
        ai: { goal: 'merchantLook' }
      });
      if (look === 'house') learn(room, pid, t);
      if (look === 'house') {
        note(room, pid, `${cardName(card)}: ${tp.name} is ${houseLabel(g.houses[t])}.`);
        sync(room);
        await fxPrivate(room, pid, { type: 'peek', title: `${cardName(card)}: only you can see this`, houses: [houseView(room, t)] }, 2600);
      }
      else note(room, pid, `${cardName(card)}: ${tp.name}'s tokens are ${tp.tokens.length ? tp.tokens.join(', ') : 'none'}.`);
      log(room, `${me} bargains with ${tp.name}…`);
      if (tp.tokens.length && mp.tokens.length) {
        const mine = await ask(room, pid, {
          kind: 'choice', title: cardName(card), text: 'Swap one honor token? Choose one of yours to give.',
          options: [...mp.tokens.map((v, i) => ({ value: `m${i}`, label: `Give my ${v}` })), { value: 'none', label: "Don't swap" }], default: 'none',
          ai: { goal: 'merchantGive' }
        });
        if (mine !== 'none') {
          let ti = Math.floor(Math.random() * tp.tokens.length);
          if (look === 'tokens') {
            const theirs = await ask(room, pid, {
              kind: 'choice', title: cardName(card), text: `Which of ${tp.name}'s tokens do you take?`,
              options: tp.tokens.map((v, i) => ({ value: `t${i}`, label: `Take their ${v}` })), default: 't0',
              ai: { goal: 'merchantTake', target: t }
            });
            ti = Number(theirs.slice(1));
          }
          const mi = Number(mine.slice(1));
          const give = mp.tokens[mi], take = tp.tokens[ti];
          mp.tokens[mi] = take; tp.tokens[ti] = give;
          note(room, pid, `You swapped your ${give} for ${tp.name}'s ${take}.`);
          note(room, t, `${me}'s Spirit Merchant swapped one of your honor tokens.`);
          log(room, `${me} swaps an honor token with ${tp.name}.`);
        }
      }
      break;
    }
    case 'Thief': {
      g.revealed[pid] = true;
      log(room, `${me} reveals their house: ${houseLabel(g.houses[pid])}.`);
      sync(room);
      fx(room, { type: 'house', title: `${me} reveals their house`, ...houseView(room, pid) });
      await sleep(2800);
      const mp = P(room, pid);
      const richer = room.players.filter(p => p.pid !== pid && p.tokens.length > mp.tokens.length);
      if (!richer.length) { log(room, `No one has more honor than ${me}, so there is nothing to steal.`); break; }
      const t = await ask(room, pid, {
        kind: 'target', title: cardName(card), text: 'Take one honor token from a player with more tokens than you?',
        options: [...richer.map(p => ({ value: p.pid, label: `${p.name} (${p.tokens.length} tokens)` })), { value: 'none', label: "Don't steal" }], default: 'none',
        ai: { goal: 'steal' }
      });
      if (t !== 'none') {
        const tp = P(room, t);
        const v = tp.tokens.splice(Math.floor(Math.random() * tp.tokens.length), 1)[0];
        mp.tokens.push(v);
        note(room, pid, `${cardName(card)}: you stole a ${v} from ${tp.name}.`);
        note(room, t, `${me} stole one of your honor tokens (a ${v}).`);
        log(room, `${me} steals an honor token from ${tp.name}.`);
      }
      break;
    }
    case 'Judge': {
      g.revealed[pid] = true;
      log(room, `${me} reveals their house: ${houseLabel(g.houses[pid])}.`);
      sync(room);
      fx(room, { type: 'house', title: `${me} reveals their house`, ...houseView(room, pid) });
      await sleep(2800);
      const t = await ask(room, pid, { kind: 'target', title: cardName(card), text: 'Choose a player to KILL. No reaction can stop the Judge.', options: playerOptions(room, otherAlive(room, pid)), ai: { goal: 'kill' } });
      if (t) await attemptKill(room, pid, t, card, false);
      break;
    }
    case 'Blind Assassin': {
      const t = await ask(room, pid, { kind: 'target', title: cardName(card), text: 'Choose a player to KILL.', options: playerOptions(room, otherAlive(room, pid)), ai: { goal: 'kill' } });
      if (t) await attemptKill(room, pid, t, card, true);
      break;
    }
    case 'Shinobi': {
      const t = await ask(room, pid, { kind: 'target', title: cardName(card), text: 'Choose a player and look at their house.', options: playerOptions(room, otherAlive(room, pid)), ai: { goal: 'shinobi' } });
      if (!t) break;
      learn(room, pid, t);
      const k = await ask(room, pid, {
        kind: 'choice', title: cardName(card), text: `${nameOf(room, t)} is ${houseLabel(g.houses[t])}. Kill them?`,
        options: [{ value: 'kill', label: 'Kill them' }, { value: 'spare', label: 'Spare them' }], default: 'spare',
        houses: [houseView(room, t)],
        ai: { goal: 'shinobiKill', target: t }
      });
      note(room, pid, `${cardName(card)}: ${nameOf(room, t)} is ${houseLabel(g.houses[t])}.`);
      if (k === 'kill') await attemptKill(room, pid, t, card, true);
      else log(room, `${me} looks at ${nameOf(room, t)}'s house… and spares them.`);
      break;
    }
  }
  sync(room);
}

async function attemptKill(room, killer, target, card, reactable) {
  const g = room.game;
  const kn = nameOf(room, killer), tn = nameOf(room, target);
  if (g.dead[target]) return;
  if (reactable) {
    const reacts = g.hands[target].filter(c => c.cls === 'React');
    if (reacts.length) {
      const v = await ask(room, target, {
        kind: 'react', title: 'You are being attacked!', text: `${kn}'s ${cardName(card)} is trying to kill you.`,
        options: [...reacts.map(c => ({ value: c.type, label: `Reveal ${c.type}` })), { value: 'none', label: 'Accept your fate' }], default: 'none',
        cards: reacts
      });
      if (v === 'Mirror Monk') {
        g.hands[target] = g.hands[target].filter(c => c.type !== 'Mirror Monk');
        g.played.push({ pid: target, card: reacts.find(c => c.type === 'Mirror Monk'), status: 'done' });
        log(room, `${tn} reveals a Mirror Monk! The attack turns back on ${kn}.`);
        sync(room);
        fx(room, { type: 'react', react: 'Mirror Monk', card: reacts.find(c => c.type === 'Mirror Monk'), name: tn, text: `The blade turns back on ${kn}!` });
        await sleep(2400);
        await kill(room, killer, `reflected by ${tn}'s Mirror Monk`, { by: tn, card: reacts.find(c => c.type === 'Mirror Monk'), reflected: true });
        return;
      }
      if (v === 'Martyr') {
        g.hands[target] = g.hands[target].filter(c => c.type !== 'Martyr');
        g.played.push({ pid: target, card: reacts.find(c => c.type === 'Martyr'), status: 'done' });
        const tok = drawToken(room);
        P(room, target).tokens.push(tok);
        note(room, target, `Martyr: you gained an honor token worth ${tok}.`);
        log(room, `${tn} reveals a Martyr and gains an honor token.`);
        sync(room);
        fx(room, { type: 'react', react: 'Martyr', card: reacts.find(c => c.type === 'Martyr'), name: tn, text: `${tn} dies with honor and gains a token.` });
        await sleep(2400);
      }
    }
  }
  await kill(room, target, `killed by ${kn}'s ${cardName(card)}`, { by: kn, card });
}

async function kill(room, pid, how, info = {}) {
  const g = room.game;
  g.dead[pid] = true;
  g.hands[pid] = g.hands[pid].filter(c => false);
  cancelPending(room, pid);
  log(room, `☠ ${nameOf(room, pid)} is ${how}.`);
  sync(room);
  fx(room, { type: 'kill', pid, name: nameOf(room, pid), by: info.by || '', card: info.card || null, reflected: !!info.reflected });
  await sleep(3200);
}

async function scoreRound(room) {
  const g = room.game;
  const alive = room.players.filter(p => !g.dead[p.pid]);
  const mastermindHolder = alive.find(p => g.hands[p.pid].some(c => c.type === 'Mastermind'));
  let winner = null;
  let reason = '';
  let fullTie = false;

  if (mastermindHolder) {
    const h = g.houses[mastermindHolder.pid];
    g.played.push({ pid: mastermindHolder.pid, card: g.hands[mastermindHolder.pid].find(c => c.type === 'Mastermind'), status: 'done' });
    if (h.house === 'Ronin') { winner = null; reason = `${mastermindHolder.name} survived with the Mastermind, but is the Ronin. No house wins.`; }
    else { winner = h.house; reason = `${mastermindHolder.name} survived with the Mastermind. House ${h.house} wins!`; }
  } else {
    const ranks = (house) => alive.map(p => g.houses[p.pid]).filter(h => h.house === house).map(h => h.rank).sort((a, b) => a - b);
    const c = ranks('Crane'), l = ranks('Lotus');
    if (!c.length && !l.length) fullTie = true;
    else {
      for (let i = 0; ; i++) {
        if (i >= c.length && i >= l.length) { fullTie = true; break; }
        if (i >= c.length) { winner = 'Lotus'; break; }
        if (i >= l.length) { winner = 'Crane'; break; }
        if (c[i] < l[i]) { winner = 'Crane'; break; }
        if (l[i] < c[i]) { winner = 'Lotus'; break; }
      }
    }
    if (fullTie) reason = 'Neither house could be separated. Every survivor gains an honor token.';
    else {
      const best = alive.map(p => g.houses[p.pid]).filter(h => h.house === winner).sort((a, b) => a.rank - b.rank)[0];
      reason = `House ${winner} wins with ${winner} ${best.rank} surviving!`;
    }
  }
  log(room, `— House reveal — ${reason}`);
  fx(room, {
    type: 'roundReveal', winner, reason,
    players: room.players.map(p => ({ ...houseView(room, p.pid), alive: !g.dead[p.pid], mastermind: !!(mastermindHolder && mastermindHolder.pid === p.pid) }))
  });
  await sleep(2600 + 450 * room.players.length + 1800);

  const gains = [];
  const give = (p) => { const v = drawToken(room); p.tokens.push(v); gains.push(p.pid); note(room, p.pid, `You gained an honor token worth ${v}.`); };
  if (fullTie) alive.forEach(give);
  else {
    room.players.forEach(p => {
      const h = g.houses[p.pid];
      if (winner && h.house === winner) give(p);
      else if (h.house === 'Ronin' && !g.dead[p.pid]) give(p);
    });
  }
  g.result = { winner, reason, fullTie, gainers: gains.map(pid => nameOf(room, pid)) };

  const top = Math.max(...room.players.map(points));
  if (top >= WIN_POINTS) {
    room.state = 'gameOver';
    const champs = room.players.filter(p => points(p) === top).map(p => p.name);
    room.final = {
      champions: champs,
      scores: room.players.map(p => ({ name: p.name, points: points(p), tokens: p.tokens.slice() })).sort((a, b) => b.points - a.points)
    };
    log(room, `🏆 ${champs.join(' & ')} ${champs.length > 1 ? 'share' : 'claims'} victory with ${top} honor!`);
  } else {
    room.state = 'roundEnd';
  }
  sync(room);
}

async function runRound(room) {
  try {
    room.state = 'playing';
    room.pending = {};
    await playRound(room);
  } catch (e) {
    console.error('Round error', e);
    room.state = 'roundEnd';
    if (room.game) { room.game.waiting = ''; log(room, 'Something went wrong this round. The host can start the next one.'); }
    sync(room);
  }
}

// ---------------------------------------------------------------------------
// Sockets
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);
  let bound = null; // { room, pid }

  const bind = (room, pid) => {
    bound = { room, pid };
    const p = P(room, pid);
    p.sid = socket.id;
    p.connected = true;
    socket.join(room.code);
    socket.emit('joined', { code: room.code, pid });
    sync(room);
  };

  socket.on('createRoom', (playerName) => {
    const name = String(playerName || '').trim().slice(0, 20);
    if (!name) return socket.emit('gameError', 'Pick a ninja name first');
    const code = generateRoomCode();
    const pid = crypto.randomBytes(8).toString('hex');
    const room = { code, hostPid: pid, players: [], state: 'lobby', round: 0, game: null, pending: {}, tokenPool: createTokenPool() };
    room.players.push({ pid, sid: socket.id, name, connected: true, tokens: [] });
    rooms.set(code, room);
    bind(room, pid);
  });

  socket.on('playSolo', (playerName) => {
    const name = String(playerName || '').trim().slice(0, 20);
    if (!name) return socket.emit('gameError', 'Pick a ninja name first');
    const code = generateRoomCode();
    const pid = crypto.randomBytes(8).toString('hex');
    const room = { code, hostPid: pid, players: [], state: 'lobby', round: 0, game: null, pending: {}, tokenPool: createTokenPool() };
    room.players.push({ pid, sid: socket.id, name, connected: true, tokens: [] });
    for (let i = 0; i < 4; i++) addBot(room);
    rooms.set(code, room);
    bind(room, pid);
  });

  socket.on('addBot', () => {
    if (!bound) return;
    const { room, pid } = bound;
    if (room.hostPid !== pid || room.state !== 'lobby') return;
    if (room.players.length >= MAX_PLAYERS) return socket.emit('gameError', 'Room is full (11 players)');
    addBot(room);
    sync(room);
  });

  socket.on('removeBot', (botPid) => {
    if (!bound) return;
    const { room, pid } = bound;
    if (room.hostPid !== pid || room.state !== 'lobby') return;
    const b = P(room, botPid);
    if (!b || !b.bot) return;
    room.players = room.players.filter(p => p.pid !== botPid);
    sync(room);
  });

  socket.on('joinRoom', ({ code, playerName }) => {
    const room = rooms.get(String(code || '').toUpperCase());
    const name = String(playerName || '').trim().slice(0, 20);
    if (!room) return socket.emit('gameError', 'Room not found');
    if (!name) return socket.emit('gameError', 'Pick a ninja name first');
    // Rejoin a game in progress by name if that player dropped off
    const existing = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing && !existing.connected) return bind(room, existing.pid);
    if (existing) return socket.emit('gameError', 'Someone in this room already has that name');
    if (room.state !== 'lobby') return socket.emit('gameError', 'This game has already started');
    if (room.players.length >= MAX_PLAYERS) return socket.emit('gameError', 'Room is full (11 players)');
    const pid = crypto.randomBytes(8).toString('hex');
    room.players.push({ pid, sid: socket.id, name, connected: true, tokens: [] });
    bind(room, pid);
  });

  socket.on('rejoin', ({ code, pid }) => {
    const room = rooms.get(String(code || ''));
    if (!room || !P(room, pid)) return socket.emit('rejoinFailed');
    bind(room, pid);
  });

  socket.on('startGame', () => {
    if (!bound) return;
    const { room, pid } = bound;
    if (room.hostPid !== pid) return;
    if (room.state === 'playing') return;
    if (room.state === 'lobby' && room.players.length < MIN_PLAYERS) return socket.emit('gameError', `Need at least ${MIN_PLAYERS} players`);
    if (room.state === 'gameOver') { room.players.forEach(p => { p.tokens = []; }); room.round = 0; room.tokenPool = createTokenPool(); room.final = null; }
    runRound(room);
  });

  socket.on('answer', ({ promptId, value }) => {
    if (!bound) return;
    answer(bound.room, bound.pid, promptId, value);
  });

  socket.on('leaveRoom', () => {
    if (!bound) return;
    const { room, pid } = bound;
    if (room.state === 'lobby') removePlayer(room, pid);
    else markDisconnected(room, pid);
    socket.leave(room.code);
    bound = null;
  });

  socket.on('disconnect', () => {
    if (!bound) return;
    const { room, pid } = bound;
    const p = P(room, pid);
    if (!p || p.sid !== socket.id) return; // already rebound on another socket
    if (room.state === 'lobby') removePlayer(room, pid);
    else markDisconnected(room, pid);
  });
});

function removePlayer(room, pid) {
  room.players = room.players.filter(p => p.pid !== pid);
  const humans = room.players.filter(p => !p.bot);
  if (!humans.length) return rooms.delete(room.code);
  if (room.hostPid === pid) room.hostPid = humans[0].pid;
  sync(room);
}

function markDisconnected(room, pid) {
  const p = P(room, pid);
  if (!p) return;
  p.connected = false;
  if (room.hostPid === pid) {
    const next = room.players.find(x => x.connected && !x.bot);
    if (next) room.hostPid = next.pid;
  }
  // Give a dropped player 45s to come back before their pending choice is made for them
  setTimeout(() => { if (!p.connected) cancelPending(room, pid); }, 45000);
  const humanOnline = () => room.players.some(x => x.connected && !x.bot);
  if (!humanOnline()) {
    setTimeout(() => { if (!humanOnline()) rooms.delete(room.code); }, 10 * 60 * 1000);
  }
  sync(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Night of the Ninja server running on port ${PORT}`);
});

module.exports = { createNinjaDeck, createHouseCards };
