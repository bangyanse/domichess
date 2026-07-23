'use strict';
/* =========================================================================
   EPTA — KODE RAJA — core game logic
   Implements the finalized ruleset from "Buku Panduan Aturan Resmi & Mekanik
   Permainan" (Epta: Kode Raja).
   ========================================================================= */

const ROWS = ['A','B','C','D','E','F','G'];

// Tabel Referensi Jatah Gerak (Bab VI.3) — nilai final, sesuai booklet persis.
// Atas: total tiap kombinasi = 2 x Nilai Sisi Atas. Bawah: total = Nilai Sisi Bawah.
const DB_ATAS = {
  4: [[4,2,1,1],[3,3,1,1],[3,2,2,1],[2,2,2,2]],
  5: [[4,4,1,1],[4,3,2,1],[3,3,3,1],[4,2,2,2],[3,3,2,2]],
  6: [[4,4,3,1],[4,4,2,2],[4,3,3,2],[3,3,3,3]],
};
const DB_BAWAH = {
  4: [[2,1,1]],
  5: [[3,1,1],[2,2,1]],
  6: [[4,1,1],[3,2,1],[2,2,2]],
};

function cellId(r,c){ return `${ROWS[r]}${c}`; }
function rOf(cell){ return ROWS.indexOf(cell[0]); }
function cOf(cell){ return parseInt(cell.slice(1)); }

function zoneOfRow(r){
  if (r<=2) return 'p1';      // A,B,C = Merah
  if (r===3) return 'neutral';// D
  return 'p2';                // E,F,G = Biru
}

// ---------- Movement / rule helpers (operate on a plain {cellId:{type,side}} board) ----------

function isPathBlockedByAnyPiece(board, src, dest){
  let rStart=rOf(src), cStart=cOf(src), rEnd=rOf(dest), cEnd=cOf(dest);
  let stepR = rEnd>rStart?1:rEnd<rStart?-1:0;
  let stepC = cEnd>cStart?1:cEnd<cStart?-1:0;
  let r=rStart+stepR, c=cStart+stepC;
  while(r!==rEnd || c!==cEnd){
    if (board[cellId(r,c)]) return true;
    r+=stepR; c+=stepC;
  }
  return false;
}
function getPathCells(src,dest){
  let rStart=rOf(src), cStart=cOf(src), rEnd=rOf(dest), cEnd=cOf(dest);
  let stepR = rEnd>rStart?1:rEnd<rStart?-1:0;
  let stepC = cEnd>cStart?1:cEnd<cStart?-1:0;
  let r=rStart, c=cStart, cells=[];
  while(r!==rEnd || c!==cEnd){
    r+=stepR; c+=stepC;
    cells.push(cellId(r,c));
  }
  return cells;
}
function moveCost(src,dest){
  let rStart=rOf(src), cStart=cOf(src), rEnd=rOf(dest), cEnd=cOf(dest);
  if (rStart!==rEnd && cStart!==cEnd) return -1; // not a straight line
  return Math.abs(rEnd-rStart) + Math.abs(cEnd-cStart);
}

// Tunnel: Raja bebas horizontal di baris ujung sendiri,
// atau vertikal di Kolom 1/6 hingga batas area pertahanan sendiri (C untuk p1, E untuk p2).
function isValidKingDestination(side, targetRowIdx, targetColVal){
  if (side==='p1'){
    if (targetRowIdx===0) return true;
    if ((targetColVal===1||targetColVal===6) && targetRowIdx>=0 && targetRowIdx<=2) return true;
    return false;
  } else {
    if (targetRowIdx===6) return true;
    if ((targetColVal===1||targetColVal===6) && targetRowIdx>=4 && targetRowIdx<=6) return true;
    return false;
  }
}

// Tunnel helpers — dipakai untuk render visual & AI
function tunnelSideForCell(r,c){
  if (isValidKingDestination('p1', r, c)) return 'p1';
  if (isValidKingDestination('p2', r, c)) return 'p2';
  return null;
}

// Zona Blokade: apakah cellId sedang diradiasi Zona Blokade oleh Penjaga milik `side`
function checkAuraBlockade(board, targetCell, side){
  const tr = rOf(targetCell), tc = cOf(targetCell);
  for (const key in board){
    const p = board[key];
    if (p.side !== side) continue;
    const pr = rOf(key), pc = cOf(key);
    if (p.type==='PH' && pr===tr && Math.abs(pc-tc)===1) return true;
    if (p.type==='PV' && pc===tc && Math.abs(pr-tr)===1) return true;
  }
  return false;
}

// Celah Wajib: movingSide dilarang menutup total (6 kolom) akses ke baris Raja lawan (enemySide)
function wouldFullyBlockEnemyBackRow(board, movingSide){
  const enemySide = movingSide==='p1' ? 'p2' : 'p1';
  const enemyRowIdx = enemySide==='p2' ? 6 : 0;
  for (let c=1;c<=6;c++){
    const tc = cellId(enemyRowIdx,c);
    if (board[tc]) continue;
    if (checkAuraBlockade(board, tc, movingSide)) continue;
    return false;
  }
  return true;
}

// Full legality check for a proposed move. Returns {ok:bool, reason, isKingCapture}
function validateMove(board, side, srcCell, destCell){
  const piece = board[srcCell];
  if (!piece || piece.side!==side) return {ok:false, reason:'Bukan bidak Anda.'};
  const cost = moveCost(srcCell, destCell);
  if (cost<=0) return {ok:false, reason:'Gerakan harus lurus (horizontal/vertikal).'};

  const rEnd = rOf(destCell), cEnd = cOf(destCell);
  if (piece.type==='K' && !isValidKingDestination(side, rEnd, cEnd)){
    return {ok:false, reason:'Raja hanya boleh bergerak di Tunnel (baris ujung / kolom 1 & 6 s.d. batas pertahanan).'};
  }

  if (isPathBlockedByAnyPiece(board, srcCell, destCell)){
    return {ok:false, reason:'Lintasan terhalang bidak lain.'};
  }

  const enemy = side==='p1'?'p2':'p1';
  const destPiece = board[destCell];
  const isKingCapture = (piece.type==='SR' && destPiece && destPiece.side===enemy && destPiece.type==='K');

  const pathCells = getPathCells(srcCell, destCell);
  for (const pc of pathCells){
    if (checkAuraBlockade(board, pc, enemy)){
      if (pc===destCell && isKingCapture) continue; // pengecualian: Panglima memakan Raja
      return {ok:false, reason:`Terblokir Zona Blokade lawan di ${pc}.`};
    }
  }

  if (destPiece){
    if (destPiece.side===side) return {ok:false, reason:'Petak tujuan sudah ditempati bidak sendiri.'};
    if (!isKingCapture) return {ok:false, reason:'Hanya Panglima yang boleh menempati petak lawan, dan hanya untuk mengeliminasi Raja.'};
  }

  if (piece.type==='PH' || piece.type==='PV'){
    const saved = board[destCell];
    const origSrc = board[srcCell];
    board[destCell] = origSrc; delete board[srcCell];
    const seal = wouldFullyBlockEnemyBackRow(board, side);
    delete board[destCell]; board[srcCell] = origSrc;
    if (saved) board[destCell] = saved;
    if (seal) return {ok:false, reason:'Dilarang oleh aturan Celah Wajib: akan menutup total akses ke baris Raja lawan.'};
  }

  return {ok:true, cost, isKingCapture};
}

// Enumerate all legal destinations for a piece at srcCell, cost between 1..maxSteps.
// Returns [{dest, cost, isKingCapture}]
function movesForPiece(board, side, srcCell, maxSteps){
  const out = [];
  const r0 = rOf(srcCell), c0 = cOf(srcCell);
  for (let c=1;c<=6;c++){
    if (c===c0) continue;
    const dest = cellId(r0,c);
    const cost = moveCost(srcCell, dest);
    if (cost>=1 && cost<=maxSteps){
      const chk = validateMove(board, side, srcCell, dest);
      if (chk.ok) out.push({dest, cost, isKingCapture: !!chk.isKingCapture});
    }
  }
  for (let r=0;r<7;r++){
    if (r===r0) continue;
    const dest = cellId(r,c0);
    const cost = moveCost(srcCell, dest);
    if (cost>=1 && cost<=maxSteps){
      const chk = validateMove(board, side, srcCell, dest);
      if (chk.ok) out.push({dest, cost, isKingCapture: !!chk.isKingCapture});
    }
  }
  return out;
}

// Ikon SVG minimalis per bidak (bukan emoji, biar konsisten di semua perangkat/browser)
function pieceIcon(type){
  const icons = {
    K: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="M4 18h16M4 18l-1.3-9.5L7.5 12l4.5-7.5 4.5 7.5 4.8-3.5L20 18"/>
          <circle cx="4" cy="8" r="1.3" fill="currentColor" stroke="none"/>
          <circle cx="12" cy="4" r="1.3" fill="currentColor" stroke="none"/>
          <circle cx="20" cy="8" r="1.3" fill="currentColor" stroke="none"/>
        </svg>`,
    SR: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="3" x2="12" y2="16"/>
          <path d="M12 3l-2.3 2.3M12 3l2.3 2.3"/>
          <line x1="6.5" y1="9" x2="17.5" y2="9"/>
          <path d="M12 16l-2.1 3.2h4.2L12 16z" fill="currentColor" stroke="none"/>
        </svg>`,
    PV: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="3" x2="12" y2="21"/>
          <path d="M12 3l-3.2 3.2M12 3l3.2 3.2"/>
          <path d="M12 21l-3.2-3.2M12 21l3.2-3.2"/>
        </svg>`,
    PH: `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <line x1="3" y1="12" x2="21" y2="12"/>
          <path d="M3 12l3.2-3.2M3 12l3.2 3.2"/>
          <path d="M21 12l-3.2-3.2M21 12l-3.2 3.2"/>
        </svg>`,
  };
  return icons[type] || '?';
}
function pieceName(type){
  return { K:'Raja', PH:'Penjaga Sayap', PV:'Penjaga Poros', SR:'Panglima' }[type] || type;
}
