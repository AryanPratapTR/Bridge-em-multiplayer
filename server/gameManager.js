const { WORD_LIST, pairAnswers, VALID_PAIRS, EASY_PAIRS, MEDIUM_PAIRS, HARD_PAIRS } = require('./wordList');

// ═══════════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════════
const ROUND_TIME = 15;       // seconds per round
const BETWEEN_ROUND = 4000;  // ms pause between rounds
const MAX_PLAYERS = 6;
const MIN_PLAYERS = 2;

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
    return rooms[code] ? generateRoomCode() : code;
}

// Returns points based on word length
function getWordPoints(word) {
    const len = word.length;
    if (len >= 10) return 25;
    if (len >= 8) return 20;
    if (len >= 6) return 15;
    return 10;
}

// Determine difficulty tier based on current round number
function getDifficultyTier() {
    const rand = Math.random() * 100;
    if (rand < 80) return 'easy';
    if (rand < 95) return 'medium';
    return 'hard';
}

// Pick a fresh pair from the appropriate difficulty tier
function pickFreshPairByTier(usedPairs, tier) {
    const tierMap = {
        easy: EASY_PAIRS,
        medium: MEDIUM_PAIRS,
        hard: HARD_PAIRS,
    };

    // Try the intended tier first, then fall back to others if exhausted
    const order = tier === 'easy'
        ? ['easy', 'medium', 'hard']
        : tier === 'medium'
            ? ['medium', 'easy', 'hard']
            : ['hard', 'medium', 'easy'];

    for (const t of order) {
        const available = tierMap[t].filter(p => !usedPairs.has(p));
        if (available.length > 0) {
            return available[Math.floor(Math.random() * available.length)];
        }
    }

    // Absolute fallback — reuse any pair
    return VALID_PAIRS[Math.floor(Math.random() * VALID_PAIRS.length)];
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
        state: 'lobby',
        currentPair: null,
        currentPairKey: null,
        roundWon: false,
        roundNumber: 0,
        totalRounds: totalRounds,
        usedPairs: new Set(),
        usedWordsThisRound: new Set(),
        timerRef: null,
        timerStart: null,
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

    const player = room.players.find(p => p.id === playerId);
    if (player) player.active = false;

    if (room.hostId === playerId) {
        const nextHost = room.players.find(p => p.active);
        if (nextHost) room.hostId = nextHost.id;
    }

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

function startGame(roomId) {
    const room = rooms[roomId];
    room.state = 'playing';
    room.roundNumber = 0;
    room.players.forEach(p => { p.score = 0; });
    return advanceRound(roomId);
}

function advanceRound(roomId) {
    const room = rooms[roomId];

    room.roundNumber++;
    room.roundWon = false;
    room.usedWordsThisRound = new Set();
    room.state = 'playing';

    const tier = getDifficultyTier();
    const pairKey = pickFreshPairByTier(room.usedPairs, tier);
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
        difficulty: tier,
    };
}

// ═══════════════════════════════════════════════════════════════
//  WORD SUBMISSION
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
    room.roundWon = true;
    room.usedWordsThisRound.add(w);

    const pointsAwarded = getWordPoints(w);
    player.score += pointsAwarded;

    return {
        won: true,
        winnerId: playerId,
        winnerName: player.name,
        word: w.toUpperCase(),
        pointsAwarded: pointsAwarded,
        scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
    };
}

// ═══════════════════════════════════════════════════════════════
//  ROUND TIMEOUT
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
//  TIMER HELPERS
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