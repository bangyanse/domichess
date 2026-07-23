'use strict';
/* =========================================================================
   EPTA — Bot AI (heuristik + deduksi), untuk mode "Main Lawan Bot"
   Bot selalu bermain sebagai Biru (p2), manusia selalu Merah (p1).
   Tidak lewat P2P — berjalan di context JS yang sama dengan game-network.js,
   jadi aksi bot cukup memanggil handleMessage()/advanceTurn() langsung,
   persis seolah pesan itu datang dari jaringan.

   Perilaku bot:
   1. Bertahan  — mendeteksi ancaman Panglima lawan ke Raja sendiri (segaris,
      jarak <=4, lintasan bersih) dan memprioritaskan menghalangi lintasan
      atau memindah Raja keluar dari segaris, di atas semua pertimbangan lain.
   2. Menyerang — mendekatkan & mensejajarkan Panglima ke Raja lawan, dengan
      bonus ekstra kalau lintasan tembak sudah bersih (siap eksekusi giliran
      berikutnya).
   3. Bongkar Kode — deduksi dari Catatan Perang Merah tiap ronde, dipersempit
      lintas ronde. Menebak pasti kalau kandidat tinggal 1; kalau tinggal 2 dan
      masih py 2 kesempatan tebak, mengambil risiko terukur di akhir ronde.
   4. Wajib bergerak — begitu 1 Jatah Gerak dipilih, bot WAJIB memakainya utk
      melangkah (dicarikan gerakan pelengkap kalau nilainya tak habis oleh 1
      bidak saja), kecuali dipakai utk Bongkar Kode. Bot tidak pernah
      "melewati" gilirannya begitu saja.
   ========================================================================= */

const Bot = {
  card: null,
  pool: [],
  poolRound: 1,
  possiblePairs: null,
  roundStartTraceLen: 0,

  ALL_PAIRS(){
    const out = [];
    [4,5,6].forEach(t=>[4,5,6].forEach(b=>out.push(t+'-'+b)));
    return out;
  },

  init(){
    this.pickCard();
    this.poolRound = 1;
    this.possiblePairs = new Set(this.ALL_PAIRS());
    this.roundStartTraceLen = 0;
    G.peerReadyCard = true; // bot langsung "siap"; giliran manusia mengunci Kartu Domino-nya sendiri
  },

  pickCard(){
    // Bobot ringan menjauhi nilai 6 (ekstrem/gampang ketebak) — tetap mungkin, cuma tak difavoritkan.
    const weightedVal = () => {
      const r = Math.random();
      if (r < 0.38) return 4;
      if (r < 0.76) return 5;
      return 6;
    };
    const topVal = weightedVal();
    const bottomVal = weightedVal();
    const topSplit = [...DB_ATAS[topVal][Math.floor(Math.random()*DB_ATAS[topVal].length)]];
    const bottomSplit = [...DB_BAWAH[bottomVal][Math.floor(Math.random()*DB_BAWAH[bottomVal].length)]];
    this.card = { topVal, topSplit, bottomVal, bottomSplit };
    this.pool = [...topSplit, ...bottomSplit].map(v=>({value:v, used:false}));
  },

  // ---------------- pesan dari klien manusia (menggantikan peran koneksi P2P) ----------------
  onHumanMessage(msg){
    if (msg.type !== 'guess') return; // place/move/advanceTurn/sacrifice/cardReady/roundReady: bot urus sendiri
    const correct = msg.topVal===this.card.topVal && msg.bottomVal===this.card.bottomVal;
    log(`[Biru/Bot] menerima Bongkar Kode Anda: Atas ${msg.topVal} / Bawah ${msg.bottomVal}.`);
    if (correct){ handleMessage({type:'guessResult', side:msg.side, correct:true}); return; }
    G.guessStats[msg.side].wrong = (G.guessStats[msg.side].wrong||0) + 1;
    if (G.guessStats[msg.side].wrong >= 2){
      handleMessage({type:'guessResult', side:msg.side, correct:false, fatal:true});
      return;
    }
    handleMessage({type:'guessResult', side:msg.side, correct:false, fatal:false});
  },

  // ---------------- penempatan bidak ----------------
  takePlacementTurn(){
    if (G.phase!=='setupPlacement' || currentPlacementSide()!=='p2') return;
    const placed = G.placedTypesBySide.p2;
    const remaining = ['K','PH','PV','SR'].filter(t=>!placed.includes(t));
    const type = placed.includes('K') ? remaining[Math.floor(Math.random()*remaining.length)] : 'K';
    const cell = this.pickPlacementCell(type);
    if (!cell) return;
    handleMessage({type:'place', side:'p2', pieceType:type, cell});
  },

  pickPlacementCell(type){
    const isEmpty = (cell)=>!G.boardPieces[cell];
    if (type==='K'){
      for (const c of shuffle([1,2,3,4,5,6])){ const cell=cellId(6,c); if (isEmpty(cell)) return cell; }
    }
    if (type==='SR'){
      // Panglima ditaruh agak ke tengah zona sendiri supaya jangkauannya ke papan tengah maksimal
      const candidates = shuffle([cellId(5,2),cellId(5,3),cellId(5,4),cellId(5,5),cellId(4,3),cellId(4,4)]);
      for (const cell of candidates) if (isEmpty(cell)) return cell;
    }
    // Penjaga (Sayap/Poros): sebar di dekat Raja untuk memperluas Zona Blokade pelindung
    const kingEntry = Object.entries(G.boardPieces).find(([c,p])=>p.side==='p2'&&p.type==='K');
    const preferred = [];
    if (kingEntry){
      const kc = cOf(kingEntry[0]);
      preferred.push(cellId(6, Math.max(1,kc-2)), cellId(6, Math.min(6,kc+2)), cellId(5, kc));
    }
    const all = [];
    for (const r of [4,5,6]) for (let c=1;c<=6;c++) all.push(cellId(r,c));
    for (const cell of shuffle([...preferred, ...all])) if (isEmpty(cell)) return cell;
    return null;
  },

  // ---------------- deduksi kartu lawan dari Catatan Perang ----------------
  onPlayerMoved(){
    this.updateDeduction();
  },

  resetRoundDeduction(){
    this.roundStartTraceLen = G.publicTrace.p1.length;
  },

  updateDeduction(){
    const playedThisRound = G.publicTrace.p1.slice(this.roundStartTraceLen);
    const counts = {1:0,2:0,3:0,4:0};
    playedThisRound.forEach(v=>{ if (counts[v]!==undefined) counts[v]++; });

    const stillPossible = new Set();
    this.possiblePairs.forEach(pair=>{
      const [t,b] = pair.split('-').map(Number);
      if (this.pairConsistentWithCounts(t,b,counts)) stillPossible.add(pair);
    });
    if (stillPossible.size>0) this.possiblePairs = stillPossible;
  },

  pairConsistentWithCounts(topVal, bottomVal, counts){
    const topVariants = uniqueFinalSplits(DB_ATAS[topVal]);
    const bottomVariants = DB_BAWAH[bottomVal];
    for (const tv of topVariants){
      for (const bv of bottomVariants){
        const combined = {1:0,2:0,3:0,4:0};
        tv.forEach(v=>combined[v]++);
        bv.forEach(v=>combined[v]++);
        let ok = true;
        for (const k of [1,2,3,4]) if (counts[k] > combined[k]) { ok=false; break; }
        if (ok) return true;
      }
    }
    return false;
  },

  getGuessIfConfident(){
    if (!this.possiblePairs) return null;
    const attemptsLeft = 2 - (G.guessStats.p2.count||0);
    if (attemptsLeft <= 0) return null;
    if (this.possiblePairs.size === 1) return [...this.possiblePairs][0];
    // Risiko terukur: kandidat tinggal 2, masih py kedua kesempatan tebak, & ronde mulai menipis.
    if (this.possiblePairs.size === 2 && attemptsLeft === 2 && G.turnsLeft.p2 <= 3){
      const arr = [...this.possiblePairs];
      return arr[Math.floor(Math.random()*arr.length)];
    }
    return null;
  },

  // ---------------- transisi ronde ----------------
  handleRoundTransition(){
    if (G.round === 1){
      const options = uniqueFinalSplits(DB_ATAS[this.card.topVal]);
      this.card.topSplit = options[Math.floor(Math.random()*options.length)];
    }
    G.roundReadyPeer = true;
    checkBothRoundReady();
  },

  ensurePoolForCurrentRound(){
    if (this.poolRound !== G.round){
      this.pool = [...this.card.topSplit, ...this.card.bottomSplit].map(v=>({value:v, used:false}));
      this.poolRound = G.round;
      this.resetRoundDeduction();
    }
  },

  // ---------------- ancaman terhadap Raja sendiri ----------------
  // Mengembalikan {attackerCell, kingCell} kalau Raja Biru sedang segaris & terjangkau
  // Panglima Merah (jarak <=4, lintasan bersih dari bidak lain).
  findThreatToOwnKing(){
    const ownKingEntry = Object.entries(G.boardPieces).find(([c,p])=>p.side==='p2'&&p.type==='K');
    if (!ownKingEntry) return null;
    const kCell = ownKingEntry[0];
    const enemyAttackers = Object.entries(G.boardPieces).filter(([c,p])=>p.side==='p1'&&p.type==='SR');
    for (const [ac] of enemyAttackers){
      if (rOf(ac)===rOf(kCell) || cOf(ac)===cOf(kCell)){
        if (manhattan(ac,kCell) <= 4 && !isPathBlockedByAnyPiece(G.boardPieces, ac, kCell)){
          return { attackerCell: ac, kingCell: kCell };
        }
      }
    }
    return null;
  },

  // ---------------- giliran bertempur ----------------
  takeBattleTurn(){
    if (G.phase!=='battle' || G.activeSide!=='p2') return;
    this.ensurePoolForCurrentRound();

    const guessPair = this.getGuessIfConfident();
    const freeIdx = this.pool.findIndex(s=>!s.used);
    if (guessPair && freeIdx>=0){
      this.pool[freeIdx].used = true;
      G.pendingBotGuessValue = this.pool[freeIdx].value;
      G.lastGuesser = 'p2';
      const [tv,bv] = guessPair.split('-').map(Number);
      log(`[Biru/Bot] melakukan Bongkar Kode: menebak Atas ${tv} / Bawah ${bv}.`);
      handleMessage({type:'guess', side:'p2', topVal:tv, bottomVal:bv});
      return;
    }

    this.executeBestAvailableMove();
  },

  // Menjamin bidak benar-benar bergerak selama nilai Jatah Gerak masih ada yang belum
  // dipakai dan papan memungkinkan — mencari gerakan pelengkap kalau nilai pertama
  // tak habis dipakai 1 bidak, alih-alih melewatkan sisa nilainya.
  executeBestAvailableMove(){
    const threat = this.findThreatToOwnKing();
    const first = this.chooseBestMove(threat);
    if (!first){
      // Benar-benar tidak ada gerakan legal untuk nilai manapun (kasus ekstrem/nyaris mustahil).
      const freeIdx = this.pool.findIndex(s=>!s.used);
      if (freeIdx>=0){
        this.pool[freeIdx].used = true;
        log('[Biru/Bot] tidak menemukan gerakan legal sama sekali — Jatah Gerak tetap dianggap terpakai.');
        advanceTurn('p2', this.pool[freeIdx].value);
      } else {
        advanceTurn('p2', null);
      }
      return;
    }
    this.pool[first.poolIdx].used = true;
    handleMessage({type:'move', side:'p2', src:first.src, dest:first.dest});
    if (G.gameEnded) return;

    let leftover = first.value - first.cost;
    if (leftover > 0){
      // Cari gerakan pelengkap (bidak lain) untuk menghabiskan sisa nilai Jatah Gerak ini.
      const second = this.findMoveForBudget(leftover, this.findThreatToOwnKing(), first.dest);
      if (second){
        handleMessage({type:'move', side:'p2', src:second.src, dest:second.dest});
        if (G.gameEnded) return;
      }
    }
    advanceTurn('p2', first.value);
  },

  // Cari gerakan terbaik untuk SISA langkah (leftover) dari Jatah Gerak yang sedang
  // dipakai — tidak menyentuh bookkeeping Cadangan Taktis (this.pool), karena nilainya
  // sama, cuma dibagi ke bidak berbeda dalam Operasi yang sama.
  findMoveForBudget(maxSteps, threat, excludeSrc){
    const enemyKingEntry = Object.entries(G.boardPieces).find(([c,p])=>p.side==='p1'&&p.type==='K');
    const ownKingEntry = Object.entries(G.boardPieces).find(([c,p])=>p.side==='p2'&&p.type==='K');
    const ownPieces = Object.entries(G.boardPieces).filter(([c,p])=>p.side==='p2' && c!==excludeSrc);
    let best = null;
    ownPieces.forEach(([cell,piece])=>{
      const moves = movesForPiece(G.boardPieces, 'p2', cell, maxSteps);
      moves.forEach(m=>{
        const score = this.scoreMove(cell, piece, m, enemyKingEntry, ownKingEntry, threat);
        if (!best || score > best.score) best = { src:cell, dest:m.dest, cost:m.cost, score };
      });
    });
    return best;
  },

  // excludeSrc: kalau dipanggil sbg gerakan pelengkap, hindari memakai src yang sama persis
  // (bidak yang baru saja dipindah) supaya tidak menghitung ulang dari posisi lama.
  chooseBestMove(threat){
    const enemyKingEntry = Object.entries(G.boardPieces).find(([c,p])=>p.side==='p1'&&p.type==='K');
    const ownKingEntry = Object.entries(G.boardPieces).find(([c,p])=>p.side==='p2'&&p.type==='K');
    const ownPieces = Object.entries(G.boardPieces).filter(([c,p])=>p.side==='p2');
    let best = null;
    this.pool.forEach((slot, idx)=>{
      if (slot.used) return;
      ownPieces.forEach(([cell,piece])=>{
        const moves = movesForPiece(G.boardPieces, 'p2', cell, slot.value);
        moves.forEach(m=>{
          const score = this.scoreMove(cell, piece, m, enemyKingEntry, ownKingEntry, threat);
          if (!best || score > best.score){
            best = { src:cell, dest:m.dest, poolIdx:idx, value:slot.value, cost:m.cost, score, isKingCapture:m.isKingCapture };
          }
        });
      });
    });
    return best;
  },

  scoreMove(src, piece, move, enemyKingEntry, ownKingEntry, threat){
    if (move.isKingCapture) return 1e7;
    let score = Math.random()*3; // jitter kecil biar variatif antar game

    // --- Bertahan: prioritas mutlak kalau Raja sendiri sedang terancam ---
    if (threat){
      const blocksPath = isBetweenOnLine(threat.attackerCell, move.dest, threat.kingCell);
      if (blocksPath) score += 800; // menghalangi lintasan serangan
      if (piece.type==='K'){
        const stillAligned = (rOf(move.dest)===rOf(threat.attackerCell) || cOf(move.dest)===cOf(threat.attackerCell))
          && !isPathBlockedByAnyPiece({...G.boardPieces, [move.dest]:piece}, threat.attackerCell, move.dest);
        if (!stillAligned) score += 700; // Raja kabur dari garis tembak
      }
    }

    // --- Menyerang: dekatkan & sejajarkan Panglima ke Raja lawan ---
    if (piece.type==='SR' && enemyKingEntry){
      const kCell = enemyKingEntry[0];
      const dBefore = manhattan(src, kCell);
      const dAfter = manhattan(move.dest, kCell);
      score += (dBefore-dAfter)*14;
      const aligned = rOf(move.dest)===rOf(kCell) || cOf(move.dest)===cOf(kCell);
      if (aligned){
        score += 20;
        // Bonus lebih besar kalau lintasan tembak ke Raja lawan sudah bersih (siap dieksekusi giliran depan)
        const boardAfter = {...G.boardPieces}; delete boardAfter[src]; boardAfter[move.dest] = piece;
        if (!isPathBlockedByAnyPiece(boardAfter, move.dest, kCell) && !checkAuraBlockade(boardAfter, kCell, 'p1')){
          score += 45;
        }
      }
    }
    // --- Raja: hindari posisi berbahaya kalau belum terancam langsung ---
    if (piece.type==='K' && ownKingEntry && !threat){
      score -= this.kingDangerScore(move.dest);
    }
    // --- Penjaga: condong menjaga area dekat Raja sendiri ---
    if ((piece.type==='PH'||piece.type==='PV') && ownKingEntry){
      const dNow = manhattan(move.dest, ownKingEntry[0]);
      score += Math.max(0, 6-dNow);
    }
    return score;
  },

  kingDangerScore(cell){
    const enemyAttackers = Object.entries(G.boardPieces).filter(([c,p])=>p.side==='p1'&&p.type==='SR');
    let danger = 0;
    enemyAttackers.forEach(([ac])=>{
      if (rOf(ac)===rOf(cell) || cOf(ac)===cOf(cell)) danger += 30;
    });
    return danger;
  },

  autoSacrifice(){
    const guards = Object.entries(G.boardPieces).filter(([c,p])=>p.side==='p2' && (p.type==='PH'||p.type==='PV'));
    if (guards.length){
      const [cell,p] = guards[Math.floor(Math.random()*guards.length)];
      delete G.boardPieces[cell];
      log(`[Tumbal Penjaga] Bot (Biru) kehilangan ${pieceName(p.type)} di ${cell}.`);
      renderBoard();
    }
    const usedValue = G.pendingBotGuessValue;
    G.pendingBotGuessValue = null;
    advanceTurn('p2', usedValue);
  },
};

function shuffle(arr){
  const a = [...arr];
  for (let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
  return a;
}
function manhattan(cellA, cellB){
  return Math.abs(rOf(cellA)-rOf(cellB)) + Math.abs(cOf(cellA)-cOf(cellB));
}
function isBetweenOnLine(a, mid, b){
  const ra=rOf(a), ca=cOf(a), rm=rOf(mid), cm=cOf(mid), rb=rOf(b), cb=cOf(b);
  if (ra===rb){
    if (rm!==ra) return false;
    return (cm>Math.min(ca,cb) && cm<Math.max(ca,cb));
  }
  if (ca===cb){
    if (cm!==ca) return false;
    return (rm>Math.min(ra,rb) && rm<Math.max(ra,rb));
  }
  return false;
}
function uniqueFinalSplits(rawOptions){
  const seen = new Set(); const out = [];
  rawOptions.forEach(raw=>{
    const final = [...raw].sort((a,b)=>a-b);
    const key = final.join(',');
    if (!seen.has(key)){ seen.add(key); out.push(final); }
  });
  return out;
}

if (typeof window !== 'undefined') window.Bot = Bot;
