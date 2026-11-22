const $ = (id) => document.getElementById(id);

const ELEMENT_COLORS = {
  Pyro: '#e2603a', Hydro: '#3b9ae8', 'Anémo': '#4fc9a8', 'Électro': '#a66be0',
  Dendro: '#7dbb2c', Cryo: '#7fd4e6', 'Géo': '#e0a92c',
};
const ATTRS = [
  ['element', 'Élément'], ['weapon', 'Arme'], ['region', 'Région'],
  ['rank', 'Rareté'], ['gender', 'Genre'], ['height', 'Taille'],
];

// Le stockage peut être indisponible (navigation privée) : le jeu doit marcher sans.
const store = {
  get(area, key) { try { return area.getItem(key); } catch { return null; } },
  set(area, key, value) { try { area.setItem(key, value); } catch { /* ignoré */ } },
};

// Identifiant secret du joueur, propre à l'onglet : il permet de retrouver sa place après un rechargement.
let pid = store.get(sessionStorage, 'pid');
if (!pid) {
  pid = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  store.set(sessionStorage, 'pid', pid);
}

let chars = new Map();
let state = null;       // dernier état reçu du serveur (null = accueil)
let roomCode = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? null;
let eliminated = new Set();
let elimKey = '';
let picked = null;      // carte sélectionnée pendant le choix du personnage secret
let guessMode = false;
let gridKey = '';
let ws = null;

// ---------------------------------------------------------------- Utilitaires

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

let toastTimer;
function toast(text, ms = 3500) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, ms);
}

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  else toast('Connexion au serveur en cours…');
}

function playerName() {
  const name = $('nameInput').value.trim() || 'Joueur';
  store.set(localStorage, 'name', name);
  return name;
}

function setUrl(code) {
  history.replaceState(null, '', code ? `?room=${code}` : location.pathname);
}

async function loadChars() {
  const res = await fetch('/api/characters');
  const data = await res.json();
  chars = new Map(data.characters.map((c) => [c.id, c]));
  const date = data.updatedAt ? new Date(data.updatedAt).toLocaleDateString('fr-FR') : '—';
  $('dataInfo').textContent = `${chars.size} personnages · données mises à jour le ${date}`;
}

const charOf = (id) => chars.get(id) ?? { id, name: '???', icon: '', rank: 4, element: '', weapon: '', region: '' };
const formatAttr = (attr, value) => (attr === 'rank' ? `${value}★` : value);

function miniCard(node, id) {
  const c = charOf(id);
  node.className = `mini r${c.rank}`;
  node.replaceChildren(
    el('img', { src: `/img/${c.icon}.png`, alt: '' }),
    el('div', {}, el('strong', { textContent: c.name }), el('small', { textContent: `${c.element} · ${c.weapon} · ${c.region}` })),
  );
}

// ---------------------------------------------------------------- Connexion

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    // (Re)prend sa place dans le salon après un rechargement ou une coupure.
    if (roomCode && (state || store.get(localStorage, 'name'))) {
      send({ t: 'join', code: roomCode, name: playerName(), pid });
    }
  };
  ws.onmessage = (event) => onMessage(JSON.parse(event.data));
  ws.onclose = () => {
    if (state) toast('Connexion perdue, reconnexion…');
    setTimeout(connect, 1500);
  };
}

async function onMessage(msg) {
  if (msg.t === 'error') return toast(msg.msg);
  if (msg.t === 'gone' || msg.t === 'left') {
    if (msg.msg) toast(msg.msg);
    state = null;
    roomCode = null;
    setUrl(null);
    return render();
  }
  if (msg.t !== 'state') return;

  const before = state;
  if (msg.board.some((id) => !chars.has(id))) await loadChars().catch(() => {});
  state = msg;
  roomCode = msg.code;
  setUrl(msg.code);

  const key = `elim:${msg.code}:${msg.round}`;
  if (key !== elimKey) {
    elimKey = key;
    picked = null;
    try { eliminated = new Set(JSON.parse(store.get(sessionStorage, key)) ?? []); } catch { eliminated = new Set(); }
  }
  if (before && before.phase !== 'lobby' && msg.phase === 'lobby' && msg.players.length < 2) {
    toast('Ton adversaire a quitté le salon.');
  }
  if (!(msg.phase === 'play' && msg.turn === msg.you && !msg.pending)) guessMode = false;
  render();
}

// ---------------------------------------------------------------- Affichage

function render() {
  const s = state;
  $('home').hidden = !!s;
  $('lobby').hidden = s?.phase !== 'lobby';
  $('game').hidden = !s || s.phase === 'lobby';
  $('roomChip').hidden = $('leaveBtn').hidden = !s;
  document.body.classList.toggle('guessing', guessMode);
  if (!s) {
    gridKey = '';
    return;
  }
  $('roomChip').textContent = s.code;
  if (s.phase === 'lobby') renderLobby(s);
  else renderGame(s);
}

function renderLobby(s) {
  const host = s.you === 0;
  $('lobbyCode').textContent = s.code;
  $('linkInput').value = `${location.origin}/?room=${s.code}`;

  const items = s.players.map((p, i) => el('li', {},
    el('span', { className: `status-dot${p.online ? '' : ' off'}` }),
    el('span', { textContent: p.name + (i === s.you ? ' (toi)' : '') }),
    el('span', { className: 'tag', textContent: [i === 0 ? 'Hôte' : '', p.score ? `${p.score} victoire${p.score > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') }),
  ));
  if (s.players.length < 2) items.push(el('li', { className: 'empty', textContent: 'En attente d’un adversaire…' }));
  $('playerList').replaceChildren(...items);

  $('sizeSelect').replaceChildren(...[24, 40, 60, 0].map((n) => el('option', {
    value: n,
    textContent: n ? `${n} personnages` : `Tous les personnages (${s.total})`,
    disabled: n > s.total,
  })));
  $('sizeSelect').value = s.size;
  $('sizeSelect').disabled = !host;

  $('startBtn').hidden = !host;
  $('startBtn').disabled = s.players.length < 2;
  $('lobbyHint').textContent = host
    ? (s.players.length < 2 ? 'La partie pourra démarrer dès que ton adversaire sera là.' : '')
    : 'L’hôte va lancer la partie…';
}

function renderGrid(s) {
  const key = `${s.code}:${s.round}`;
  if (key !== gridKey) {
    gridKey = key;
    const sorted = s.board.map(charOf).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    $('grid').replaceChildren(...sorted.map((c) => {
      const card = el('button', { className: `card r${c.rank}`, type: 'button' },
        el('img', { src: `/img/${c.icon}.png`, alt: '', loading: 'lazy' }),
        el('span', { className: 'name', textContent: c.name }),
        el('span', { className: 'meta' },
          el('i', { className: 'dot', style: `background:${ELEMENT_COLORS[c.element] ?? '#8892a8'}` }),
          `${c.element} · ${c.region}`),
        el('span', { className: 'meta', textContent: c.weapon }),
      );
      card.dataset.id = c.id;
      return card;
    }));
    fillAttrValues(s);
  }
  for (const card of $('grid').children) {
    const id = card.dataset.id;
    const over = s.phase === 'over';
    card.classList.toggle('out', s.phase === 'play' && eliminated.has(id));
    card.classList.toggle('sel', s.phase === 'pick' && picked === id && s.secret === null);
    card.classList.toggle('mine', (over || s.phase === 'pick') && s.secret === id);
    card.classList.toggle('theirs', over && s.secrets[1 - s.you] === id);
  }
}

function renderGame(s) {
  const me = s.you;
  const opp = s.players[1 - me] ?? { name: 'Adversaire', online: false, ready: false, score: 0 };
  const myTurn = s.turn === me;
  renderGrid(s);

  // Scores
  $('scores').replaceChildren(...[me, 1 - me].map((i) => {
    const p = s.players[i] ?? opp;
    return el('div', { className: `score${s.phase === 'play' && s.turn === i ? ' turn' : ''}` },
      el('span', { className: `status-dot${p.online ? '' : ' off'}` }),
      el('span', { textContent: i === me ? `${p.name} (toi)` : p.name }),
      el('b', { textContent: p.score }));
  }));

  // Mon personnage
  $('secretBox').hidden = s.secret === null;
  if (s.secret !== null) miniCard($('secretCard'), s.secret);

  // Bloc d'action
  const show = { actPick: false, actWait: false, actTurn: false, actAnswer: false, actOver: false };
  let status = '';
  if (s.phase === 'pick') {
    if (s.secret === null) {
      show.actPick = true;
      status = 'Choisis ton personnage secret';
      $('confirmBtn').disabled = picked === null;
    } else {
      show.actWait = true;
      status = `${opp.name} choisit son personnage…`;
      $('waitText').textContent = 'Ton choix est enregistré. La partie démarre dès que ton adversaire a choisi.';
    }
  } else if (s.phase === 'play') {
    if (myTurn && !s.pending) {
      show.actTurn = true;
      status = guessMode ? 'Quel personnage proposes-tu ?' : 'À toi : pose une question ou tente ta chance';
      $('guessBtn').textContent = guessMode ? 'Annuler' : 'Deviner un personnage';
      $('guessBtn').classList.toggle('active', guessMode);
      $('guessHint').hidden = !guessMode;
      $('askForm').hidden = guessMode;
    } else if (myTurn) {
      show.actWait = true;
      status = `${opp.name} réfléchit à sa réponse…`;
      $('waitText').textContent = `Ta question : « ${s.pending} »`;
    } else if (s.pending) {
      show.actAnswer = true;
      status = 'Réponds à la question';
      $('answerTitle').textContent = `${opp.name} te demande`;
      $('answerQuestion').textContent = s.pending;
    } else {
      show.actWait = true;
      status = `Au tour de ${opp.name}`;
      $('waitText').textContent = 'Profites-en pour éliminer des personnages en cliquant sur leur carte.';
    }
  } else {
    show.actOver = true;
    const won = s.winner === me;
    status = won ? 'Victoire !' : 'Défaite…';
    $('overTitle').textContent = won ? 'Tu as trouvé le bon personnage' : `${opp.name} a trouvé ton personnage`;
    const theirs = el('div', {});
    miniCard(theirs, s.secrets[1 - me]);
    $('overSecrets').replaceChildren(el('span', { className: 'label', textContent: `Le personnage de ${opp.name} était` }), theirs);
    $('overHost').hidden = me !== 0;
    $('overGuest').hidden = me === 0;
  }
  if (!opp.online && s.phase !== 'over') status = `${opp.name} est déconnecté, en attente de son retour…`;
  for (const [id, visible] of Object.entries(show)) $(id).hidden = !visible;
  $('statusText').textContent = status;

  $('toolBox').hidden = s.phase !== 'play';
  document.body.classList.toggle('locked', s.phase === 'over' || (s.phase === 'pick' && s.secret !== null));
  const left = s.board.length - s.board.filter((id) => eliminated.has(id)).length;
  $('remaining').textContent = s.phase === 'play' ? `${left} / ${s.board.length} suspects` : `${s.board.length} personnages`;

  renderLog(s);
}

function renderLog(s) {
  const name = (i) => (i === s.you ? 'Toi' : s.players[i]?.name ?? 'Adversaire');
  const items = s.log.map((entry) => {
    if (entry.k === 'q') return el('li', {}, el('span', { className: 'who', textContent: `${name(entry.by)} : ` }), entry.text);
    if (entry.k === 'a') return el('li', { className: 'ans' }, '↳ ', el('b', { className: entry.yes ? 'yes' : 'no', textContent: entry.yes ? 'Oui' : 'Non' }));
    return el('li', {},
      el('span', { className: 'who', textContent: `${name(entry.by)} ` }),
      `propose ${charOf(entry.id).name} : `,
      el('b', { textContent: entry.ok ? 'trouvé !' : 'raté.' }));
  });
  if (!items.length) items.push(el('li', { className: 'empty', textContent: 'Aucune question pour l’instant.' }));
  $('log').replaceChildren(...items);
  $('log').scrollTop = $('log').scrollHeight;
}

// ---------------------------------------------------------------- Tri rapide

function fillAttrValues(s = state) {
  const attr = $('attrSelect').value;
  const values = [...new Set(s.board.map((id) => charOf(id)[attr]))].sort((a, b) => String(a).localeCompare(String(b), 'fr'));
  $('valueSelect').replaceChildren(...values.map((v) => el('option', { value: v, textContent: formatAttr(attr, v) })));
}

function saveEliminated() {
  store.set(sessionStorage, elimKey, JSON.stringify([...eliminated]));
}

function eliminateBy(matching) {
  const attr = $('attrSelect').value;
  const value = $('valueSelect').value;
  for (const id of state.board) {
    if ((String(charOf(id)[attr]) === value) === matching) eliminated.add(id);
  }
  saveEliminated();
  render();
}

// ---------------------------------------------------------------- Événements

$('attrSelect').replaceChildren(...ATTRS.map(([value, label]) => el('option', { value, textContent: label })));
$('attrSelect').onchange = () => fillAttrValues();
$('hideMatchBtn').onclick = () => eliminateBy(true);
$('hideOtherBtn').onclick = () => eliminateBy(false);
$('resetBtn').onclick = () => { eliminated.clear(); saveEliminated(); render(); };

$('createBtn').onclick = () => send({ t: 'create', name: playerName(), pid });
$('joinForm').onsubmit = (event) => {
  event.preventDefault();
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 5) return toast('Le code d’un salon fait 5 caractères.');
  send({ t: 'join', code, name: playerName(), pid });
};
$('leaveBtn').onclick = () => {
  if (state.phase === 'lobby' || state.phase === 'over' || confirm('Quitter la partie en cours ?')) send({ t: 'leave' });
};

$('copyBtn').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('linkInput').value);
    toast('Lien copié !');
  } catch {
    $('linkInput').select();
    toast('Copie le lien sélectionné (Ctrl+C).');
  }
};
$('sizeSelect').onchange = () => send({ t: 'settings', size: Number($('sizeSelect').value) });
$('startBtn').onclick = $('againBtn').onclick = () => send({ t: 'start' });
$('backBtn').onclick = () => send({ t: 'lobby' });

$('randomBtn').onclick = () => {
  picked = state.board[Math.floor(Math.random() * state.board.length)];
  render();
  $('grid').querySelector('.sel')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
};
$('confirmBtn').onclick = () => { if (picked !== null) send({ t: 'secret', id: picked }); };

$('askForm').onsubmit = (event) => {
  event.preventDefault();
  const text = $('askInput').value.trim();
  if (!text) return;
  send({ t: 'ask', text });
  $('askInput').value = '';
};
$('guessBtn').onclick = () => { guessMode = !guessMode; render(); };
$('yesBtn').onclick = () => send({ t: 'answer', yes: true });
$('noBtn').onclick = () => send({ t: 'answer', yes: false });

let guessTarget = null;
$('guessDlg').onclose = () => {
  if ($('guessDlg').returnValue === 'yes' && guessTarget !== null) send({ t: 'guess', id: guessTarget });
  guessTarget = null;
};

$('grid').onclick = (event) => {
  const id = event.target.closest('.card')?.dataset.id;
  if (!id || !state) return;
  if (state.phase === 'pick' && state.secret === null) {
    picked = id;
  } else if (state.phase === 'play' && guessMode) {
    guessTarget = id;
    miniCard($('guessDlgCard'), id);
    $('guessDlg').returnValue = 'no';
    $('guessDlg').showModal();
    return;
  } else if (state.phase === 'play') {
    if (!eliminated.delete(id)) eliminated.add(id);
    saveEliminated();
  } else {
    return;
  }
  render();
};

// ---------------------------------------------------------------- Démarrage

$('nameInput').value = store.get(localStorage, 'name') ?? '';
if (roomCode) $('codeInput').value = roomCode;
render();
loadChars().catch(() => toast('Impossible de charger les personnages.')).finally(connect);
