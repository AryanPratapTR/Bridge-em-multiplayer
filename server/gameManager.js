const { WORD_LIST, pairAnswers, VALID_PAIRS } = require('./wordList');

// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════
const ROUND_TIME = 15;   // seconds per round
const BETWEEN_ROUND = 4000; // ms pause between rounds
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;
const POINTS_PER_WIN = 10;

// ═══════════════════════════════════════════════════════════════
//  IN-MEMORY ROOM STORE
//  rooms = {
//    "ABC123": {
//      id, hostId, players, state,
//      currentPair, currentPairKey,
//      roundWon, roundNumber, totalRounds,
//      usedPairs, timerRef
//    }
//  }
// ═══════════════════════════════════════════════════════════════
const rooms = {};

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

// Generate a random 6-character uppercase room code
function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    // Ensure uniqueness
    return rooms[code] ? generateRoomCode() : code;
}

// Pick a random pair that hasn't been used this game
function pickFreshPair(usedPairs) {
    const available = VALID_PAIRS.filter(p => !usedPairs.has(p));
    // If we've exhausted all pairs just reset and reuse
    const pool = available.length > 0 ? available : VALID_PAIRS;
    return pool[Math.floor(Math.random() * pool.length)];
}

// Get a hint word for a given pair key, excluding already-used words
function getHint(pairKey, usedWords) {
    const answers = pairAnswers[pairKey] || [];
    const unused = answers.filter(w => !usedWords.has(w));
    if (unused.length === 0) return null;
    return unused[Math.floor(Math.random() * unused.length)].toUpperCase();
}

// ═══════════════════════════════════════════════════════════════
//  ROOM MANAGEMENT
// ═══════════════════════════════════════════════════════════════

function createRoom(hostId, hostName, totalRounds = 10) {
    const roomId = generateRoomCode();
    rooms[roomId] = {
        id: roomId,
        hostId: hostId,
        players: [{
            id: hostId,
            name: hostName,
            score: 0,
            ready: false,
            active: true
        }],
        state: 'lobby',      // lobby | playing | between | ended
        currentPair: null,     // { start, end }
        currentPairKey: null,     // e.g. "ae"
        roundWon: false,
        roundNumber: 0,
        totalRounds: totalRounds,
        usedPairs: new Set(),
        usedWordsThisRound: new Set(),
        timerRef: null,
        timerStart: null,     // Date.now() when round started
    };
    return roomId;
}

function joinRoom(roomId, playerId, playerName) {
    const room = rooms[roomId];

    if (!room)
        return { error: 'ROOM NOT FOUND!' };
    if (room.state !== 'lobby')
        return { error: 'GAME ALREADY IN PROGRESS!' };
    if (room.players.length >= MAX_PLAYERS)
        return { error: 'ROOM IS FULL!' };
    if (room.players.find(p => p.name.toUpperCase() === playerName.toUpperCase()))
        return { error: 'NAME ALREADY TAKEN IN THIS ROOM!' };

    room.players.push({
        id: playerId,
        name: playerName,
        score: 0,
        ready: false,
        active: true
    });

    return { success: true };
}

function leaveRoom(roomId, playerId) {
    const room = rooms[roomId];
    if (!room) return null;

    // Mark player inactive
    const player = room.players.find(p => p.id === playerId);
    if (player) player.active = false;

    // If host left, assign next active player as host
    if (room.hostId === playerId) {
        const nextHost = room.players.find(p => p.active);
        if (nextHost) room.hostId = nextHost.id;
    }

    // Clean up room if everyone left
    const anyoneLeft = room.players.some(p => p.active);
    if (!anyoneLeft) {
        clearRoomTimer(room);
        delete rooms[roomId];
        return { roomDeleted: true };
    }

    return { room };
}

function getRoom(roomId) {
    return rooms[roomId] || null;
}

function getRoomSafely(roomId) {
    const room = rooms[roomId];
    if (!room) return null;
    // Return a copy without the timer ref (not serialisable)
    return {
        id: room.id,
        hostId: room.hostId,
        players: room.players,
        state: room.state,
        currentPair: room.currentPair,
        roundNumber: room.roundNumber,
        totalRounds: room.totalRounds,
    };
}

// ═══════════════════════════════════════════════════════════════
//  GAME FLOW
// ═══════════════════════════════════════════════════════════════

function canStartGame(roomId, requesterId) {
    const room = rooms[roomId];
    if (!room) return { error: 'ROOM NOT FOUND!' };
    if (room.hostId !== requesterId) return { error: 'ONLY THE HOST CAN START!' };
    if (room.state !== 'lobby') return { error: 'GAME ALREADY STARTED!' };

    const activePlayers = room.players.filter(p => p.active);
    if (activePlayers.length < MIN_PLAYERS)
        return { error: `NEED AT LEAST ${MIN_PLAYERS} PLAYERS TO START!` };

    return { success: true };
}

// Called by index.js — returns the first round's pair data
function startGame(roomId) {
    const room = rooms[roomId];
    room.state = 'playing';
    room.roundNumber = 0;
    room.players.forEach(p => { p.score = 0; });
    return advanceRound(roomId);
}

// Moves to the next round, returns round info to broadcast
function advanceRound(roomId) {
    const room = rooms[roomId];

    room.roundNumber++;
    room.roundWon = false;
    room.usedWordsThisRound = new Set();
    room.state = 'playing';

    const pairKey = pickFreshPair(room.usedPairs);
    room.usedPairs.add(pairKey);
    room.currentPairKey = pairKey;
    room.currentPair = {
        start: pairKey[0].toUpperCase(),
        end: pairKey[1].toUpperCase()
    };
    room.timerStart = Date.now();

    return {
        roundNumber: room.roundNumber,
        totalRounds: room.totalRounds,
        pair: room.currentPair,
        timeLimit: ROUND_TIME,
    };
}

// ═══════════════════════════════════════════════════════════════
//  WORD SUBMISSION
//  Returns an object describing the outcome
// ═══════════════════════════════════════════════════════════════
function submitWord(roomId, playerId, word) {
    const room = rooms[roomId];

    if (!room)
        return { error: 'ROOM NOT FOUND!' };
    if (room.state !== 'playing')
        return { error: 'NO ACTIVE ROUND!' };
    if (room.roundWon)
        return { error: 'ROUND ALREADY WON!' };

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.active)
        return { error: 'PLAYER NOT IN ROOM!' };

    const w = word.toLowerCase().trim();

    // ── Validation ──────────────────────────────────────────────
    if (w.length <= 3)
        return { invalid: 'WORD MUST BE MORE THAN 3 LETTERS!' };

    if (w[0] !== room.currentPair.start.toLowerCase())
        return { invalid: `MUST START WITH "${room.currentPair.start}"!` };

    if (w[w.length - 1] !== room.currentPair.end.toLowerCase())
        return { invalid: `MUST END WITH "${room.currentPair.end}"!` };

    if (room.usedWordsThisRound.has(w))
        return { invalid: `"${w.toUpperCase()}" ALREADY USED THIS ROUND!` };

    if (!WORD_LIST.has(w))
        return { invalid: `"${w.toUpperCase()}" NOT IN WORD LIST!` };

    // ── Valid & first! ───────────────────────────────────────────
    room.roundWon = true;   // lock immediately — Node is single-threaded
    room.usedWordsThisRound.add(w);
    player.score += POINTS_PER_WIN;

    return {
        won: true,
        winnerId: playerId,
        winnerName: player.name,
        word: w.toUpperCase(),
        scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    };
}

// ═══════════════════════════════════════════════════════════════
//  ROUND TIMEOUT (called by index.js when server timer fires)
// ═══════════════════════════════════════════════════════════════
function handleRoundTimeout(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return null;

    room.state = 'between';

    const hint = getHint(room.currentPairKey, room.usedWordsThisRound);

    return {
        timedOut: true,
        pair: room.currentPair,
        hint: hint,
        scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    };
}

// ═══════════════════════════════════════════════════════════════
//  GAME OVER CHECK
// ═══════════════════════════════════════════════════════════════
function isGameOver(roomId) {
    const room = rooms[roomId];
    return room && room.roundNumber >= room.totalRounds;
}

function getFinalResults(roomId) {
    const room = rooms[roomId];
    if (!room) return null;

    const sorted = [...room.players]
        .filter(p => p.active)
        .sort((a, b) => b.score - a.score);

    return {
        players: sorted,
        winner: sorted[0],
    };
}

// ═══════════════════════════════════════════════════════════════
//  TIMER HELPERS (refs stored so index.js can clear them)
// ═══════════════════════════════════════════════════════════════
function setRoomTimer(roomId, fn, ms) {
    const room = rooms[roomId];
    if (!room) return;
    clearRoomTimer(room);
    room.timerRef = setTimeout(fn, ms);
}

function clearRoomTimer(room) {
    if (room && room.timerRef) {
        clearTimeout(room.timerRef);
        room.timerRef = null;
    }
}
// Finds which roomId a given socket/player ID belongs to
function findRoomByPlayer(playerId) {
    for (const [roomId, room] of Object.entries(rooms)) {
        if (room.players.find(p => p.id === playerId)) {
            return roomId;
        }
    }
    return null;
}
// ═══════════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════════
module.exports = {
    createRoom,
    joinRoom,
    leaveRoom,
    getRoom,
    findRoomByPlayer,
    getRoomSafely,
    canStartGame,
    startGame,
    advanceRound,
    submitWord,
    handleRoundTimeout,
    isGameOver,
    getFinalResults,
    setRoomTimer,
    clearRoomTimer,
    ROUND_TIME,
    BETWEEN_ROUND,
};