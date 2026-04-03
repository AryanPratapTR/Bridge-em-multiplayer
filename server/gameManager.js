const { WORD_LIST, pairAnswers, VALID_PAIRS, LEVEL_PAIRS } = require('./wordList');

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
    if (len <= 4) return 5;
    if (len === 5) return 7;
    if (len === 6) return 9;
    if (len === 7) return 11;
    if (len === 8) return 13;
    return 15; // max at 9 or more
}

// Determine difficulty level 1-5
function getDifficultyTier() {
    const rand = Math.random() * 100;
    if (rand < 30) return 1; // 30% level 1
    if (rand < 60) return 2; // 30% level 2
    if (rand < 80) return 3; // 20% level 3
    if (rand < 93) return 4; // 13% level 4
    return 5; // 7% level 5
}

// Pick a fresh pair from the appropriate difficulty tier
function pickFreshPairByTier(usedPairs, tier) {
    const list = LEVEL_PAIRS[tier] || LEVEL_PAIRS[1];
    
    // We try multiple times to find an unused one efficiently using loop
    for (let i = 0; i < 100; i++) {
        const pair = list[Math.floor(Math.random() * list.length)];
        if (!usedPairs.has(pair)) return pair;
    }
    
    // Fallback: full dictionary
    const available = VALID_PAIRS.filter(p => !usedPairs.has(p));
    if (available.length > 0) {
        return available[Math.floor(Math.random() * available.length)];
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

function createRoom(hostId, hostName, totalRounds = 10, isSinglePlayer = false, gameMode = 'single', timeLimit = 15, maxPlayers = 6, avatar = '🦊') {
    const roomId = generateRoomCode();
    rooms[roomId] = {
        id: roomId,
        hostId: hostId,
        isSinglePlayer: isSinglePlayer,
        gameMode: gameMode,
        timeLimit: parseInt(timeLimit) || 15,
        maxPlayers: parseInt(maxPlayers) || 6,
        players: [{
            id: hostId,
            name: hostName,
            avatar: avatar,
            score: 0,
            ready: false,
            active: true
        }],
        state: 'lobby',
        currentPair: null,
        currentPairKey: null,
        roundNumber: 0,
        totalRounds: totalRounds,
        usedPairs: new Set(),
        usedWordsThisRound: new Set(),
        singleSubmissions: [],
        playerHistory: {},
        timerRef: null,
        timerStart: null,
    };
    return roomId;
}

function joinRoom(roomId, playerId, playerName, avatar = '🦊') {
    const room = rooms[roomId];

    if (!room)
        return { error: 'ROOM NOT FOUND!' };
    if (room.state !== 'lobby')
        return { error: 'GAME ALREADY IN PROGRESS!' };
    if (room.players.length >= room.maxPlayers)
        return { error: 'ROOM IS FULL!' };
    if (room.players.find(p => p.name.toUpperCase() === playerName.toUpperCase()))
        return { error: 'NAME ALREADY TAKEN IN THIS ROOM!' };

    room.players.push({
        id: playerId,
        name: playerName,
        avatar: avatar,
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
        isSinglePlayer: room.isSinglePlayer,
        gameMode: room.gameMode,
        timeLimit: room.timeLimit,
        maxPlayers: room.maxPlayers,
        players: room.players,
        state: room.state,
        currentPair: room.currentPair,
        roundNumber: room.roundNumber,
        totalRounds: room.totalRounds,
        playerHistory: room.playerHistory || {}
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
    if (!room.isSinglePlayer && activePlayers.length < MIN_PLAYERS)
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
    room.usedWordsThisRound = new Set();
    room.singleSubmissions = [];
    room.players.forEach(p => { p.hasAnswered = false; });
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
        timeLimit: room.timeLimit || 15,
        difficulty: tier,
    };
}

// ═══════════════════════════════════════════════════════════════
//  WORD SUBMISSION
// ═══════════════════════════════════════════════════════════════
function submitWord(roomId, playerId, word) {
    const room = rooms[roomId];

    if (!room) return { error: 'ROOM NOT FOUND!' };
    if (room.state !== 'playing') return { error: 'NO ACTIVE ROUND!' };

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.active) return { error: 'PLAYER NOT IN ROOM!' };

    const w = word.toLowerCase().trim();

    // ── Validation ──────────────────────────────────────────────
    if (w.length <= 3) return { invalid: 'WORD MUST BE MORE THAN 3 LETTERS!' };
    if (w[0] !== room.currentPair.start.toLowerCase()) return { invalid: `MUST START WITH "${room.currentPair.start}"!` };
    if (w[w.length - 1] !== room.currentPair.end.toLowerCase()) return { invalid: `MUST END WITH "${room.currentPair.end}"!` };
    if (room.usedWordsThisRound.has(w)) return { invalid: `"${w.toUpperCase()}" ALREADY USED THIS ROUND!` };
    if (!WORD_LIST.has(w)) return { invalid: `"${w.toUpperCase()}" NOT IN WORD LIST!` };

    const pointsAwarded = getWordPoints(w);
    room.usedWordsThisRound.add(w);

    if (!room.playerHistory[playerId]) room.playerHistory[playerId] = [];
    room.playerHistory[playerId].push(w);

    if (room.gameMode === 'limitless') {
        player.score += pointsAwarded;
        return {
            limitlessValid: true,
            playerId: playerId,
            word: w.toUpperCase(),
            pointsAwarded: pointsAwarded,
            scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar }))
        };
    } else if (room.gameMode === 'normal') {
        room.state = 'between';
        player.score += pointsAwarded;
        return {
            normalWin: true,
            winnerId: playerId,
            winnerName: player.name,
            word: w.toUpperCase(),
            pointsAwarded: pointsAwarded,
            hint: getHint(room.currentPairKey, room.usedWordsThisRound),
            scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar }))
        };
    } else {
        // Single Word Time Based
        if (player.hasAnswered) return { invalid: 'YOU ALREADY SUBMITTED A WORD THIS ROUND!' };
        player.hasAnswered = true;
        
        room.singleSubmissions.push({ playerId, word: w, points: pointsAwarded, time: Date.now() });

        const activePlayers = room.players.filter(p => p.active);
        if (room.singleSubmissions.length >= activePlayers.length) {
             return evaluateSingleRound(roomId);
        }

        return { waitingForOthers: true, word: w.toUpperCase(), playerId: playerId };
    }
}

// ═══════════════════════════════════════════════════════════════
//  ROUND TIMEOUT
// ═══════════════════════════════════════════════════════════════
function handleRoundTimeout(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== 'playing') return null;

    if (room.gameMode === 'limitless') {
        room.state = 'between';
        return {
            limitlessFinish: true,
            pair: room.currentPair,
            hint: getHint(room.currentPairKey, room.usedWordsThisRound),
            scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar }))
        };
    } else if (room.gameMode === 'normal') {
        room.state = 'between';
        return {
            timeoutNormal: true,
            pair: room.currentPair,
            hint: getHint(room.currentPairKey, room.usedWordsThisRound),
            scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar }))
        };
    } else {
        return evaluateSingleRound(roomId);
    }
}

function evaluateSingleRound(roomId) {
    const room = rooms[roomId];
    if (!room) return null;
    room.state = 'between';

    room.singleSubmissions.sort((a, b) => a.time - b.time);
    const subResult = [];
    const n = room.singleSubmissions.length;
    room.singleSubmissions.forEach((sub, idx) => {
        const player = room.players.find(p => p.id === sub.playerId);
        if (player) {
            const speedBonus = (n - idx - 1) * 3;
            const totalPts = sub.points + speedBonus;
            player.score += totalPts;
            subResult.push({ id: player.id, name: player.name, word: sub.word.toUpperCase(), pts: totalPts, speedBonus });
        }
    });

    const hint = getHint(room.currentPairKey, room.usedWordsThisRound);

    return {
        singleRoundComplete: true,
        submissions: subResult,
        pair: room.currentPair,
        hint: hint,
        scores: room.players.map(p => ({ id: p.id, name: p.name, score: p.score, avatar: p.avatar }))
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
        playerHistory: room.playerHistory
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