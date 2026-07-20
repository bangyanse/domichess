'use strict';
/* =========================================================================
   THE HIDDEN CODE — PvP networking (PeerJS, P2P, no server) + UI wiring
   ========================================================================= */

const G = {
  peer:null, conn:null,
  isHost:false, mySide:null,          // 'p1' (Merah, guest) or 'p2' (Biru, host)
  phase:'lobby',
  myCard:null, myPool:[],
  boardPieces:{},
  placedTypesBySide:{p1:[], p2:[]},
  placementSeq:['p2','p1','p2','p1','p2','p1','p2','p1'],
  placementIndex:0,
  armedPlaceType:null,
  round:1,
  turnsLeft:{p1:6, p2:6},
  activeSide:'p1',
  guessStats:{p1:{count:0,wrong:0}, p2:{count:0,wrong:0}},
  publicTrace:{p1:[], p2:[]},
  pendingGuessValue:null,
  selectedCell:null,
  remainingSteps:0,
  activePoolIdx:null,
  myReadyCard:false, peerReadyCard:false,
  roundReadyMe:false, roundReadyPeer:false,
  pendingBottomChoice:null,
  gameEnded:false,
};
if (typeof window !== 'undefined') window.G = G;

// ---------------------------------------------------------------- utilities
function renderPublicTrace(){
  const el = document.getElementById('tracePanel');
  el.innerHTML =
    `<div><b style="color:var(--red);">[Merah]</b> ${G.publicTrace.p1.join(', ')}</div>` +
    `<div><b style="color:var(--blue);">[Biru]</b> ${G.publicTrace.p2.join(', ')}</div>`;
}
function log(text){
  const el = document.getElementById('logPanel');
  const d = document.createElement('div');
  d.textContent = text;
  el.appendChild(d);
  el.scrollTop = el.scrollHeight;
}
function banner(text){ document.getElementById('banner').textContent = text; }
function statusBar(){
  const sideLabel = G.mySide==='p1' ? 'Merah' : 'Biru';
  document.getElementById('statusBar').textContent =
    `Kamu: ${sideLabel} · Ronde ${G.round} · Giliran tersisa — Merah:${G.turnsLeft.p1} Biru:${G.turnsLeft.p2}`;
}
function send(msg){ if (G.conn && G.conn.open) G.conn.send(msg); }
function showOverlay(html){
  document.getElementById('overlayBox').innerHTML = html;
  document.getElementById('overlay').style.display = 'flex';
}
function hideOverlay(){ document.getElementById('overlay').style.display = 'none'; }

// ---------------------------------------------------------------- lobby / connection

// Kredensial TURN dedicated (akun Metered.ca "domchess", free trial 500MB/bulan).
// Plan free/trial cuma bisa pakai host "standard.relay.metered.ca" (bukan "global").
const METERED_USERNAME   = '1329f5dcef2360add71e2266';
const METERED_CREDENTIAL = 'XIUmIhfq0t/7TIhf';

const DEDICATED_ICE_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:standard.relay.metered.ca:80', username: METERED_USERNAME, credential: METERED_CREDENTIAL },
  { urls: 'turn:standard.relay.metered.ca:80?transport=tcp', username: METERED_USERNAME, credential: METERED_CREDENTIAL },
  { urls: 'turn:standard.relay.metered.ca:443', username: METERED_USERNAME, credential: METERED_CREDENTIAL },
  { urls: 'turns:standard.relay.metered.ca:443?transport=tcp', username: METERED_USERNAME, credential: METERED_CREDENTIAL },
];

const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:freestun.net:3478' },
  { urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

async function buildIceConfig(){
  // Dedicated (kuota sendiri, lebih andal) diprioritaskan; publik jadi cadangan kalau kuota habis.
  const iceServers = [...DEDICATED_ICE_SERVERS, ...FALLBACK_ICE_SERVERS];
  return { debug: 2, config: { iceServers } };
}



function connectTimeoutGuard(label, ms=20000){
  return setTimeout(()=>{
    if (G.phase==='lobby'){
      const el = document.getElementById('connStatus');
      el.style.display='block';
      let warnBox = document.getElementById('connWarnBox');
      if (!warnBox){
        warnBox = document.createElement('div');
        warnBox.id = 'connWarnBox';
        el.insertBefore(warnBox, el.firstChild);
      }
      warnBox.innerHTML = `⚠️ ${label} tidak kunjung berhasil dalam ${ms/1000} detik.<br>
        Lihat baris "Diagnostik teknis" di bawah ini:<br>
        • Kalau <b>jenis kandidat</b> cuma "host" saja (tidak ada srflx/relay) → jaringan salah satu pihak memblokir WebRTC total.<br>
        • Kalau ada "srflx"/"relay" tapi status ICE tetap "checking" atau "failed" → NAT kedua pihak sama-sama ketat, butuh server TURN yang lebih andal.<br>
        Coba: refresh dan ulangi, atau pindah salah satu ke jaringan lain.`;
    }
  }, ms);
}

function attachIceDiagnostics(conn){
  const candidateTypes = new Set();
  function ensureLine(){
    let line = document.getElementById('iceDiagLine');
    if (!line){
      line = document.createElement('div');
      line.id = 'iceDiagLine';
      line.style.cssText = 'font-size:.72rem;color:var(--muted);margin-top:8px;line-height:1.5;';
      document.getElementById('connStatus').appendChild(line);
    }
    return line;
  }
  function update(){
    const pc = conn.peerConnection;
    if (!pc) return;
    ensureLine().textContent =
      `Diagnostik teknis — status ICE: ${pc.iceConnectionState} · pengumpulan kandidat: ${pc.iceGatheringState} · jenis kandidat ditemukan: ${[...candidateTypes].join(', ') || '(belum ada)'}`;
  }
  (function poll(){
    const pc = conn.peerConnection;
    if (!pc){ setTimeout(poll, 200); return; }
    pc.addEventListener('iceconnectionstatechange', update);
    pc.addEventListener('icegatheringstatechange', update);
    pc.addEventListener('icecandidate', e => {
      if (e.candidate && e.candidate.candidate){
        const parts = e.candidate.candidate.split(' ');
        const i = parts.indexOf('typ');
        if (i>=0) candidateTypes.add(parts[i+1]);
      }
      update();
    });
    update();
  })();
}

document.getElementById('btnHost').onclick = async () => {
  G.isHost = true; G.mySide = 'p2';
  document.getElementById('btnHost').disabled = true;
  document.getElementById('btnHost').textContent = 'Menyiapkan koneksi...';
  const iceConfig = await buildIceConfig();
  document.getElementById('btnHost').textContent = 'Buat Room Baru';
  document.getElementById('btnHost').disabled = false;
  G.peer = new Peer(iceConfig);
  const guard = connectTimeoutGuard('Menunggu teman join');
  G.peer.on('open', id => {
    document.getElementById('hostCodeBox').style.display = 'block';
    document.getElementById('hostCodeDisplay').value = id;
  });
  G.peer.on('connection', c => {
    clearTimeout(guard);
    G.conn = c;
    wireConn();
    document.getElementById('connStatus').style.display='block';
    document.getElementById('connStatus').textContent = 'Teman terhubung! Menyiapkan Kartu Sandi...';
    attachIceDiagnostics(c);
    startCardSelectPhase();
  });
  G.peer.on('error', e => {
    const el = document.getElementById('connStatus');
    el.style.display='block';
    el.textContent = 'Gagal membuat room: '+e.type+'. Coba refresh halaman dan ulangi.';
  });
};

document.getElementById('btnJoin').onclick = async () => {
  const code = document.getElementById('joinCodeInput').value.trim();
  if (!code) return alert('Masukkan kode room dulu.');
  G.isHost = false; G.mySide = 'p1';
  document.getElementById('btnJoin').disabled = true;
  document.getElementById('btnJoin').textContent = 'Menyiapkan koneksi...';
  const iceConfig = await buildIceConfig();
  document.getElementById('btnJoin').textContent = 'Gabung';
  document.getElementById('btnJoin').disabled = false;
  G.peer = new Peer(iceConfig);
  const guard = connectTimeoutGuard('Menghubungkan ke room');
  G.peer.on('open', () => {
    G.conn = G.peer.connect(code, { reliable: true });
    wireConn(guard);
    document.getElementById('connStatus').style.display='block';
    document.getElementById('connStatus').textContent = 'Menghubungkan ke room...';
    attachIceDiagnostics(G.conn);
  });
  G.peer.on('error', e => {
    clearTimeout(guard);
    const el = document.getElementById('connStatus');
    el.style.display='block';
    el.textContent = 'Gagal terhubung: '+e.type+'. Cek lagi kode room-nya, atau minta temanmu buat room baru.';
  });
};

function wireConn(guard){
  G.conn.on('open', () => {
    if (guard) clearTimeout(guard);
    document.getElementById('connStatus').textContent = 'Terhubung! Menyiapkan Kartu Sandi...';
    startCardSelectPhase();
  });
  G.conn.on('data', handleMessage);
  G.conn.on('close', () => { banner('Koneksi dengan lawan terputus.'); });
  G.conn.on('error', e => {
    const el = document.getElementById('connStatus');
    el.style.display='block';
    el.textContent = 'Kesalahan koneksi: '+(e.type||e.message||e)+'. Coba refresh dan ulangi.';
  });
}

// ---------------------------------------------------------------- CARD SELECT PHASE
function startCardSelectPhase(){
  if (G.phase !== 'lobby') return; // avoid double-trigger from both open events
  G.phase = 'cardSelect';
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('cardSelectArea').style.display = 'block';
  renderCardSelectUI();
}

let cardDraft = { topVal:null, topSplit:null, bottomVal:null, bottomSplit:null };

function renderCardSelectUI(){
  const topDiv = document.getElementById('topSelectUI');
  topDiv.innerHTML = '<b>Sisi Atas</b> (menentukan 4 Poin Gerak + bonus)';
  const rowTop = document.createElement('div'); rowTop.className='row'; rowTop.style.margin='6px 0';
  [4,5,6].forEach(v=>{
    const b=document.createElement('button'); b.className='secondary'; b.textContent='Sisi Atas '+v;
    b.onclick=()=>{ cardDraft.topVal=v; cardDraft.topSplit=null; renderCardSelectUI(); };
    if (cardDraft.topVal===v) b.classList.add('active');
    rowTop.appendChild(b);
  });
  topDiv.appendChild(rowTop);
  if (cardDraft.topVal){
    const optWrap = document.createElement('div'); optWrap.className='split-options';
    const seen = new Set();
    DB_ATAS[cardDraft.topVal].forEach(raw=>{
      const final = applyBonus(raw, cardDraft.topVal).sort((a,b)=>a-b);
      const key = final.join(',');
      if (seen.has(key)) return; seen.add(key);
      const d = document.createElement('div');
      d.className = 'split-opt' + (cardDraft.topSplit && cardDraft.topSplit.join(',')===key ? ' chosen':'');
      d.textContent = '[ '+final.join(', ')+' ]';
      d.onclick = ()=>{ cardDraft.topSplit = final; renderCardSelectUI(); };
      optWrap.appendChild(d);
    });
    topDiv.appendChild(optWrap);
  }

  const botDiv = document.getElementById('bottomSelectUI');
  botDiv.innerHTML = '<b>Sisi Bawah</b> (menentukan 3 Poin Gerak)';
  const rowBot = document.createElement('div'); rowBot.className='row'; rowBot.style.margin='6px 0';
  [4,5,6].forEach(v=>{
    const b=document.createElement('button'); b.className='secondary'; b.textContent='Sisi Bawah '+v;
    b.onclick=()=>{ cardDraft.bottomVal=v; cardDraft.bottomSplit=null; renderCardSelectUI(); };
    if (cardDraft.bottomVal===v) b.classList.add('active');
    rowBot.appendChild(b);
  });
  botDiv.appendChild(rowBot);
  if (cardDraft.bottomVal){
    const optWrap = document.createElement('div'); optWrap.className='split-options';
    DB_BAWAH[cardDraft.bottomVal].forEach(raw=>{
      const key = raw.join(',');
      const d = document.createElement('div');
      d.className = 'split-opt' + (cardDraft.bottomSplit && cardDraft.bottomSplit.join(',')===key ? ' chosen':'');
      d.textContent = '[ '+raw.join(', ')+' ]';
      d.onclick = ()=>{ cardDraft.bottomSplit = [...raw]; renderCardSelectUI(); };
      optWrap.appendChild(d);
    });
    botDiv.appendChild(optWrap);
  }

  document.getElementById('btnLockCard').disabled = !(cardDraft.topSplit && cardDraft.bottomSplit);
}

document.getElementById('btnLockCard').onclick = () => {
  G.myCard = { ...cardDraft };
  G.myPool = [...cardDraft.topSplit, ...cardDraft.bottomSplit].map(v=>({value:v, used:false}));
  G.myReadyCard = true;
  document.getElementById('btnLockCard').disabled = true;
  document.getElementById('cardReadyStatus').textContent = 'Kartu Sandi dikunci. Menunggu lawan...';
  send({type:'cardReady'});
  checkBothCardReady();
};

function checkBothCardReady(){
  if (G.myReadyCard && G.peerReadyCard){
    document.getElementById('cardSelectArea').style.display='none';
    startPlacementPhase();
  }
}

// ---------------------------------------------------------------- PLACEMENT PHASE
function startPlacementPhase(){
  G.phase = 'setupPlacement';
  document.getElementById('gameArea').style.display = 'block';
  renderBoard();
  renderPlacementControls();
  log('=== Fase Penempatan Bidak dimulai (Biru duluan) ===');
}

function currentPlacementSide(){ return G.placementSeq[G.placementIndex]; }

function renderPlacementControls(){
  statusBar();
  const side = currentPlacementSide();
  const mine = side === G.mySide;
  banner(mine ? 'Giliran Anda menempatkan bidak.' : `Menunggu ${side==='p1'?'Merah':'Biru'} menempatkan bidak...`);
  const box = document.getElementById('phaseControls');
  box.innerHTML='';
  document.getElementById('phaseTitle').textContent = 'Persiapan Awal — Penempatan Bidak';
  if (!mine) return;
  const placed = G.placedTypesBySide[G.mySide];
  const remainingTypes = ['K','PH','PV','SR'].filter(t=>!placed.includes(t));
  const mustBeKingFirst = !placed.includes('K');
  const availableNow = mustBeKingFirst ? ['K'] : remainingTypes;
  const p = document.createElement('div');
  p.innerHTML = '<small class="hint">Pilih jenis bidak, lalu klik petak kosong di zona Anda.</small>';
  box.appendChild(p);
  const row = document.createElement('div'); row.className='row';
  availableNow.forEach(t=>{
    const b = document.createElement('button');
    b.textContent = pieceIcon(t)+' '+pieceName(t);
    if (G.armedPlaceType===t) b.classList.add('active'); else b.className='secondary';
    b.onclick = ()=>{ G.armedPlaceType=t; renderPlacementControls(); };
    row.appendChild(b);
  });
  box.appendChild(row);
}

function onCellClickPlacement(cell){
  const side = currentPlacementSide();
  if (side !== G.mySide) return;
  if (!G.armedPlaceType) return alert('Pilih jenis bidak dulu di panel kanan.');
  const r = rOf(cell);
  const zone = zoneOfRow(r);
  if (zone !== G.mySide) return alert('Hanya boleh menempatkan di zona pertahanan sendiri.');
  if (G.boardPieces[cell]) return alert('Petak sudah terisi.');
  if (G.armedPlaceType==='K' && !(r===(G.mySide==='p1'?0:6))) return alert('Raja wajib di baris paling ujung.');

  const type = G.armedPlaceType;
  G.boardPieces[cell] = { type, side: G.mySide };
  G.placedTypesBySide[G.mySide].push(type);
  G.armedPlaceType = null;
  G.placementIndex++;
  send({type:'place', side:G.mySide, pieceType:type, cell});
  log(`[Setup] ${G.mySide==='p1'?'Merah':'Biru'} menempatkan ${pieceName(type)} di ${cell}.`);
  renderBoard();
  if (G.placementIndex >= 8){
    startBattlePhase();
  } else {
    renderPlacementControls();
  }
}

// ---------------------------------------------------------------- BATTLE PHASE
function startBattlePhase(){
  G.phase='battle';
  G.activeSide='p1';
  log('=== Ronde 1 dimulai — Merah jalan duluan ===');
  renderAll();
}

function renderAll(){
  renderBoard();
  renderPool();
  renderBattleControls();
  statusBar();
  renderPublicTrace();
}

function renderPool(){
  const panel = document.getElementById('poolPanel');
  panel.innerHTML='';
  G.myPool.forEach((slot, idx)=>{
    const b = document.createElement('button');
    b.className = 'poolBtn' + (slot.used?' used':'') + (G.activePoolIdx===idx?' active':'');
    b.textContent = slot.value;
    b.disabled = slot.used || G.phase!=='battle' || G.activeSide!==G.mySide || G.remainingSteps>0;
    b.onclick = ()=>{
      G.activePoolIdx = idx;
      G.remainingSteps = slot.value;
      G.selectedCell = null;
      renderAll();
    };
    panel.appendChild(b);
  });
  const q = 2 - G.guessStats[G.mySide].count;
  document.getElementById('guessQuotaHint').textContent = `Sisa jatah Aksi Bongkar Sandi: ${q}/2.`;
}

function renderBattleControls(){
  document.getElementById('phaseTitle').textContent = 'Pertempuran';
  const box = document.getElementById('phaseControls');
  box.innerHTML='';
  const myTurn = G.activeSide === G.mySide;
  const armedFresh = G.activePoolIdx!==null && G.remainingSteps === G.myPool[G.activePoolIdx].value && !G.selectedCell;
  if (!myTurn){
    banner(`Menunggu giliran ${G.activeSide==='p1'?'Merah':'Biru'}...`);
    box.innerHTML = '<small class="hint">Bukan giliran Anda.</small>';
  } else if (G.remainingSteps>0){
    banner(`Poin Gerak ${G.myPool[G.activePoolIdx].value} aktif (sisa ${G.remainingSteps}). Klik bidak Anda lalu klik petak tujuan — atau lakukan Aksi Bongkar Sandi untuk mengorbankan Poin Gerak ini.`);
    box.innerHTML = '<small class="hint">Anda wajib menghabiskan seluruh nilai Poin Gerak ini untuk melangkah, kecuali dipakai untuk Aksi Bongkar Sandi.</small>';
  } else {
    banner('Giliran Anda: pilih satu Poin Gerak di panel Pool Energi untuk mulai melangkah atau menebak.');
    box.innerHTML = '<small class="hint">Pilih Poin Gerak di bawah dulu.</small>';
  }
  const guessBtn = document.getElementById('btnGuessOpen');
  guessBtn.disabled = !(myTurn && armedFresh && G.guessStats[G.mySide].count<2);
}

function onCellClickBattle(cell){
  if (G.activeSide !== G.mySide) return;
  if (G.remainingSteps<=0) return; // must pick a pool number first
  const piece = G.boardPieces[cell];
  if (!G.selectedCell){
    if (!piece || piece.side!==G.mySide) return;
    G.selectedCell = cell;
    renderAll();
    return;
  }
  if (cell === G.selectedCell){ G.selectedCell=null; renderAll(); return; }

  const check = validateMove(G.boardPieces, G.mySide, G.selectedCell, cell);
  if (!check.ok) return alert(check.reason);
  if (check.cost > G.remainingSteps) return alert('Jarak ini melebihi sisa alokasi Poin Gerak Anda saat ini.');

  const movedType = G.boardPieces[G.selectedCell].type;
  const capturedPiece = G.boardPieces[cell];
  G.boardPieces[cell] = G.boardPieces[G.selectedCell];
  delete G.boardPieces[G.selectedCell];
  send({type:'move', side:G.mySide, src:G.selectedCell, dest:cell});
  if (capturedPiece) log(`[${G.mySide==='p1'?'Merah':'Biru'}] ${pieceName(movedType)} memakan ${pieceName(capturedPiece.type)} lawan di ${cell}!`);
  else log(`[${G.mySide==='p1'?'Merah':'Biru'}] ${pieceName(movedType)} bergeser ke ${cell}.`);

  G.remainingSteps -= check.cost;
  G.selectedCell = null;

  if (check.isKingCapture){
    renderBoard();
    return endGame(G.mySide, 'Skakmat Fisik — Raja lawan berhasil dimakan.');
  }

  if (G.remainingSteps===0){
    const usedVal = G.myPool[G.activePoolIdx].value;
    G.myPool[G.activePoolIdx].used = true;
    G.activePoolIdx = null;
    finishMyTurn(usedVal);
  } else {
    renderAll();
  }
}

function finishMyTurn(usedValue){
  advanceTurn(G.mySide, usedValue);
  send({type:'advanceTurn', side:G.mySide, value:usedValue});
}

function advanceTurn(sideThatActed, usedValue){
  if (usedValue!==undefined && usedValue!==null){
    G.publicTrace[sideThatActed].push(usedValue);
    renderPublicTrace();
  }
  G.turnsLeft[sideThatActed] = Math.max(0, G.turnsLeft[sideThatActed]-1);
  G.activeSide = sideThatActed==='p1' ? 'p2' : 'p1';
  if (G.turnsLeft.p1<=0 && G.turnsLeft.p2<=0){
    startRoundTransition();
  } else {
    renderAll();
  }
}

// ---------------------------------------------------------------- AKSI BONGKAR SANDI (guess)
document.getElementById('btnGuessOpen').onclick = () => {
  if (G.activePoolIdx===null) return;
  const sacValue = G.myPool[G.activePoolIdx].value;
  showOverlay(`
    <h2 style="margin-top:0;color:var(--gold);">Aksi Bongkar Sandi</h2>
    <p style="font-size:.85rem;color:var(--muted);">Tebak kombinasi Kartu Sandi lawan. Tindakan ini akan mengorbankan
      <b style="color:var(--gold);">Poin Gerak bernilai ${sacValue}</b> yang sudah Anda pilih, beserta giliran Anda.</p>
    <div class="row" id="guessTopRow"></div>
    <div class="row" id="guessBotRow" style="margin-top:8px;"></div>
    <div style="margin-top:14px;">
      <button id="btnSubmitGuess" disabled>Kirim Tebakan</button>
      <button class="secondary" onclick="hideOverlay()">Batal</button>
    </div>
  `);
  let g = { top:null, bottom:null };
  const topRow = document.getElementById('guessTopRow');
  [4,5,6].forEach(v=>{
    const b=document.createElement('button'); b.className='secondary'; b.textContent='Atas '+v;
    b.onclick=()=>{ g.top=v; refreshGuessBtn(); [...topRow.children].forEach(x=>x.classList.remove('active')); b.classList.add('active'); };
    topRow.appendChild(b);
  });
  const botRow = document.getElementById('guessBotRow');
  [4,5,6].forEach(v=>{
    const b=document.createElement('button'); b.className='secondary'; b.textContent='Bawah '+v;
    b.onclick=()=>{ g.bottom=v; refreshGuessBtn(); [...botRow.children].forEach(x=>x.classList.remove('active')); b.classList.add('active'); };
    botRow.appendChild(b);
  });
  function refreshGuessBtn(){
    document.getElementById('btnSubmitGuess').disabled = !(g.top && g.bottom);
  }
  document.getElementById('btnSubmitGuess').onclick = () => {
    const usedValue = G.myPool[G.activePoolIdx].value;
    G.myPool[G.activePoolIdx].used = true;
    G.activePoolIdx = null;
    G.remainingSteps = 0;
    G.guessStats[G.mySide].count++;
    G.pendingGuessValue = usedValue;
    send({type:'guess', side:G.mySide, topVal:g.top, bottomVal:g.bottom});
    showOverlay('<p>Menunggu jawaban lawan...</p>');
    renderAll();
  };
};

// ---------------------------------------------------------------- MESSAGE HANDLER
function handleMessage(msg){
  switch(msg.type){
    case 'cardReady':
      G.peerReadyCard = true;
      document.getElementById('cardReadyStatus').textContent = G.myReadyCard ? 'Kedua pemain siap!' : 'Lawan sudah siap, giliranmu memilih kartu.';
      checkBothCardReady();
      break;

    case 'place':
      G.boardPieces[msg.cell] = { type: msg.pieceType, side: msg.side };
      G.placedTypesBySide[msg.side].push(msg.pieceType);
      G.placementIndex++;
      log(`[Setup] ${msg.side==='p1'?'Merah':'Biru'} menempatkan ${pieceName(msg.pieceType)} di ${msg.cell}.`);
      if (G.placementIndex >= 8) startBattlePhase();
      else renderPlacementControls();
      renderBoard();
      break;

    case 'move': {
      const capturedPiece = G.boardPieces[msg.dest];
      G.boardPieces[msg.dest] = G.boardPieces[msg.src];
      delete G.boardPieces[msg.src];
      const movedType = G.boardPieces[msg.dest].type;
      if (capturedPiece) log(`[${msg.side==='p1'?'Merah':'Biru'}] ${pieceName(movedType)} memakan ${pieceName(capturedPiece.type)} di ${msg.dest}!`);
      else log(`[${msg.side==='p1'?'Merah':'Biru'}] ${pieceName(movedType)} bergeser ke ${msg.dest}.`);
      if (movedType==='SR' && capturedPiece && capturedPiece.type==='K'){
        renderBoard();
        endGame(msg.side, 'Skakmat Fisik — Raja berhasil dimakan lawan.');
        return;
      }
      renderBoard();
      break;
    }

    case 'advanceTurn':
      advanceTurn(msg.side, msg.value);
      break;

    case 'guess': {
      const correct = (msg.topVal===G.myCard.topVal && msg.bottomVal===G.myCard.bottomVal);
      G.guessStats[msg.side].count++;
      log(`[${msg.side==='p1'?'Merah':'Biru'}] menebak Atas ${msg.topVal} / Bawah ${msg.bottomVal}.`);
      if (correct){
        send({type:'guessResult', side:msg.side, correct:true});
        endGame(msg.side, 'Bongkar Sandi Akurat — kartu rahasia berhasil ditebak.');
        return;
      }
      G.guessStats[msg.side].wrong++;
      if (G.guessStats[msg.side].wrong >= 2){
        send({type:'guessResult', side:msg.side, correct:false, fatal:true});
        endGame(G.mySide, `Lawan salah tebak pada percobaan ke-2.`);
        return;
      }
      send({type:'guessResult', side:msg.side, correct:false, fatal:false});
      log('Tebakan salah — lawan wajib mengorbankan 1 Penjaga.');
      renderAll();
      break;
    }

    case 'guessResult':
      hideOverlay();
      if (msg.correct){
        endGame(G.mySide, 'Bongkar Sandi Akurat — kartu rahasia lawan berhasil ditebak.');
        return;
      }
      if (msg.fatal){
        endGame(msg.side==='p1'?'p2':'p1', 'Anda salah tebak pada percobaan ke-2.');
        return;
      }
      log('Tebakan Anda salah. Pilih 1 Penjaga milik Anda untuk dikorbankan (Tumbal Penjaga).');
      promptGuardSacrifice();
      break;

    case 'sacrifice':
      delete G.boardPieces[msg.cell];
      log(`[Tumbal Penjaga] ${msg.side==='p1'?'Merah':'Biru'} kehilangan Penjaga di ${msg.cell}.`);
      renderBoard();
      if (msg.side !== G.mySide) { /* peer's own sacrifice already advanced their turn on their side */ }
      break;

    case 'roundReady':
      G.roundReadyPeer = true;
      checkBothRoundReady();
      break;

    case 'gameOverAck':
      break;
  }
}

function promptGuardSacrifice(){
  const guards = Object.entries(G.boardPieces).filter(([c,p])=>p.side===G.mySide && (p.type==='PH'||p.type==='PV'));
  if (guards.length===0){
    // Tidak ada Penjaga tersisa untuk dikorbankan — tetap lanjut giliran (kasus edge, sesuai desain tumbal fisik)
    finishMyTurn(G.pendingGuessValue);
    G.pendingGuessValue = null;
    return;
  }
  showOverlay(`
    <h2 style="margin-top:0;color:var(--red);">Tumbal Penjaga</h2>
    <p style="font-size:.85rem;">Tebakan Anda salah. Pilih 1 Penjaga untuk dihapus dari papan:</p>
    <div class="row" id="sacRow"></div>
  `);
  const row = document.getElementById('sacRow');
  guards.forEach(([cell,p])=>{
    const b=document.createElement('button');
    b.textContent = pieceIcon(p.type)+' '+pieceName(p.type)+' ('+cell+')';
    b.onclick = () => {
      delete G.boardPieces[cell];
      send({type:'sacrifice', side:G.mySide, cell});
      log(`[Tumbal Penjaga] Anda kehilangan ${pieceName(p.type)} di ${cell}.`);
      hideOverlay();
      renderBoard();
      finishMyTurn(G.pendingGuessValue);
      G.pendingGuessValue = null;
    };
    row.appendChild(b);
  });
}

// ---------------------------------------------------------------- ROUND TRANSITION
function startRoundTransition(){
  G.phase = 'roundTransition';
  G.roundReadyMe = false; G.roundReadyPeer = false;
  document.getElementById('phaseTitle').textContent = 'Transisi Ronde';
  const box = document.getElementById('phaseControls');
  if (G.round === 1){
    banner('Ronde 1 selesai! Pilih ulang kombinasi Sisi Bawah Anda (nilai tetap sama).');
    box.innerHTML = '<div id="bottomRedrawUI"></div><button id="btnRoundReady" disabled>Siap Lanjut Ronde 2</button>';
    renderBottomRedrawUI();
    document.getElementById('btnRoundReady').onclick = () => {
      G.myCard.bottomSplit = G.pendingBottomChoice;
      G.roundReadyMe = true;
      document.getElementById('btnRoundReady').disabled = true;
      send({type:'roundReady'});
      checkBothRoundReady();
    };
  } else if (G.round === 2){
    banner('Ronde 2 selesai tanpa pemenang! Bersiap ke Ronde 3 (Sudden Death) — kartu sama persis.');
    box.innerHTML = '<button id="btnRoundReady">Siap Lanjut Ronde 3 (Sudden Death)</button>';
    document.getElementById('btnRoundReady').onclick = () => {
      G.roundReadyMe = true;
      document.getElementById('btnRoundReady').disabled = true;
      send({type:'roundReady'});
      checkBothRoundReady();
    };
  } else {
    endGame('draw', 'Kuota Ronde 3 habis tanpa pemenang.');
  }
}

function renderBottomRedrawUI(){
  const div = document.getElementById('bottomRedrawUI');
  div.innerHTML = `<b>Sisi Bawah (nilai tetap ${G.myCard.bottomVal})</b>`;
  const wrap = document.createElement('div'); wrap.className='split-options';
  DB_BAWAH[G.myCard.bottomVal].forEach(raw=>{
    const d = document.createElement('div');
    d.className = 'split-opt';
    d.textContent = '[ '+raw.join(', ')+' ]';
    d.onclick = () => {
      G.pendingBottomChoice = [...raw];
      document.getElementById('btnRoundReady').disabled = false;
      [...wrap.children].forEach(x=>x.classList.remove('chosen'));
      d.classList.add('chosen');
    };
    wrap.appendChild(d);
  });
  div.appendChild(wrap);
}

function checkBothRoundReady(){
  if (G.roundReadyMe && G.roundReadyPeer){
    if (G.round===1){
      G.round = 2;
      G.turnsLeft = {p1:6, p2:6};
      G.myPool = [...G.myCard.topSplit, ...G.myCard.bottomSplit].map(v=>({value:v, used:false}));
      log('=== Ronde 2 dimulai — Merah jalan duluan ===');
    } else if (G.round===2){
      G.round = 3;
      G.turnsLeft = {p1:3, p2:3};
      G.myPool = [...G.myCard.topSplit, ...G.myCard.bottomSplit].map(v=>({value:v, used:false}));
      log('=== Ronde 3 (Sudden Death) dimulai — kartu sama persis, 3 giliran tersisa ===');
    }
    G.activeSide = 'p1';
    G.phase = 'battle';
    G.remainingSteps = 0; G.activePoolIdx = null; G.selectedCell = null;
    renderAll();
  }
}

// ---------------------------------------------------------------- WIN / DRAW
function endGame(winnerSide, reasonText){
  if (G.gameEnded) return;
  G.gameEnded = true;
  G.phase = 'gameOver';
  let title;
  if (winnerSide==='draw') title = 'SERI / REMIS';
  else title = (winnerSide===G.mySide) ? 'ANDA MENANG!' : 'ANDA KALAH';
  showOverlay(`
    <h2 style="margin-top:0;color:${winnerSide==='draw'?'var(--gold)':(winnerSide===G.mySide?'#5ee08a':'var(--red)')}">${title}</h2>
    <p>${reasonText}</p>
    <button class="secondary" onclick="location.reload()">Main Lagi (Reload)</button>
  `);
  log(`=== PERTANDINGAN SELESAI: ${reasonText} ===`);
}

function computeLegalTargets(){
  if (!G.selectedCell || G.remainingSteps<=0 || G.phase!=='battle') return [];
  const results = [];
  const r0 = rOf(G.selectedCell), c0 = cOf(G.selectedCell);
  for (let c=1;c<=6;c++){
    if (c===c0) continue;
    const dest = cellId(r0,c);
    const cost = moveCost(G.selectedCell, dest);
    if (cost>=1 && cost<=G.remainingSteps){
      if (validateMove(G.boardPieces, G.mySide, G.selectedCell, dest).ok) results.push(dest);
    }
  }
  for (let r=0;r<7;r++){
    if (r===r0) continue;
    const dest = cellId(r,c0);
    const cost = moveCost(G.selectedCell, dest);
    if (cost>=1 && cost<=G.remainingSteps){
      if (validateMove(G.boardPieces, G.mySide, G.selectedCell, dest).ok) results.push(dest);
    }
  }
  return results;
}

// ---------------------------------------------------------------- BOARD RENDERING
function renderBoard(){
  const board = document.getElementById('board');
  board.innerHTML='';
  const legalTargets = new Set(computeLegalTargets());
  for (let r=0;r<7;r++){
    for (let c=1;c<=6;c++){
      const id = cellId(r,c);
      const div = document.createElement('div');
      div.className = 'cell zone-'+zoneOfRow(r);
      div.id = 'cell-'+id;
      const coord = document.createElement('span'); coord.className='coord'; coord.textContent=id;
      div.appendChild(coord);

      const piece = G.boardPieces[id];
      if (piece){
        const span = document.createElement('span');
        span.className = 'piece-'+piece.side;
        span.textContent = pieceIcon(piece.type);
        div.appendChild(span);
      }
      if (G.selectedCell===id) div.classList.add('selected');
      if (legalTargets.has(id)) div.classList.add('legal-target');

      const clickable = (G.phase==='setupPlacement' && currentPlacementSide()===G.mySide) ||
                         (G.phase==='battle' && G.activeSide===G.mySide);
      if (clickable){
        div.classList.add('clickable');
        div.onclick = () => {
          if (G.phase==='setupPlacement') onCellClickPlacement(id);
          else if (G.phase==='battle') onCellClickBattle(id);
        };
      }
      board.appendChild(div);
    }
  }
}
