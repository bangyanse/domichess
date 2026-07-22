'use strict';
/* =========================================================================
   THE HIDDEN CODE — PvP core game logic
   Implements the finalized ruleset from "Buku Panduan Aturan Resmi — Edisi Revisi"
   ========================================================================= */

const ROWS = ['A','B','C','D','E','F','G'];

const DB_ATAS = {
  4: [[1,1,2,4],[1,1,3,3],[1,2,2,3],[2,2,2,2]],
  5: [[1,1,4,4],[1,2,3,4],[1,3,3,3],[2,2,2,4],[2,2,3,3]],
  6: [[1,3,4,4],[2,2,4,4],[2,3,3,4],[3,3,3,3]],
};
const DB_BAWAH = {
  4: [[1,1,2]],
  5: [[1,1,3],[1,2,2]],
  6: [[1,1,4],[1,2,3],[2,2,2]],
};

function applyBonus(splitArr, topVal){
  let bonus = topVal===4?2:topVal===5?1:0;
  let temp = [...splitArr];
  while(bonus>0){
    let added=false;
    for(let i=0;i<temp.length;i++){ if(temp[i]<4){temp[i]++;bonus--;added=true;break;} }
    if(!added) break;
  }
  return temp;
}

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

// Koridor Tepi: Raja bebas horizontal di baris ujung sendiri,
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

// Tunnel (Koridor Tepi) helpers — dipakai untuk render visual & AI
function tunnelSideForCell(r,c){
  if (isValidKingDestination('p1', r, c)) return 'p1';
  if (isValidKingDestination('p2', r, c)) return 'p2';
  return null;
}

// Aura Penjaga: apakah cellId sedang diradiasi aura oleh Penjaga milik `side`
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
    return {ok:false, reason:'Raja hanya boleh bergerak di Koridor Tepi (baris ujung / kolom 1 & 6 s.d. batas pertahanan).'};
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
      if (pc===destCell && isKingCapture) continue; // pengecualian: Penyerang memakan Raja
      return {ok:false, reason:`Terblokir Aura Penjaga lawan di ${pc}.`};
    }
  }

  if (destPiece){
    if (destPiece.side===side) return {ok:false, reason:'Petak tujuan sudah ditempati bidak sendiri.'};
    if (!isKingCapture) return {ok:false, reason:'Hanya Penyerang yang boleh menempati petak lawan, dan hanya untuk memakan Raja.'};
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

function pieceIcon(type){
  return { K:'👑', PH:'↔️', PV:'↕️', SR:'⚔️' }[type] || '?';
}
function pieceName(type){
  return { K:'Raja', PH:'Penjaga Horizontal', PV:'Penjaga Vertikal', SR:'Penyerang' }[type] || type;
}
