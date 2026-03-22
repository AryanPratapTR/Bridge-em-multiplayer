require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const {
    createRoom,
    joinRoom,
    leaveRoom,
    getRoom,
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
    findRoomByPlayer,
    ROUND_TIME,
    BETWEEN_ROUND,
} = require('./gameManager');

// ═══════════════════════════════════════════════════════════════
//  SERVER SETUP
// ═══════════════════════════════════════════════════════════════
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '../client')));
app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, '../client/index.html'));
});

// ═══════════════════════════════════════════════════════════════
//  API WORD CACHE
//  Stores words confirmed valid by the dictionary API this session
//  so repeat words don't hit the API again
// ═══════════════════════════════════════════════════════════════
const apiWordCache = new Set();

// Tracks players currently awaiting an API check
// Prevents spam submissions while a check is in progress
const pendingApiCheck = new Set();

async function checkWordWithApi(word) {
    try {
        const fetch = (await import('node-fetch')).default;
        const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
        if (!res.ok) return false;
        const data = await res.json();
        return Array.isArray(data) && data.length > 0;
    } catch (err) {
        console.error(`[API] Dictionary check failed for "${word}":`, err.message);
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
    console.log(`[+] Connected   : ${socket.id}`);

    // ── CREATE ROOM ──────────────────────────────────────────────
    socket.on('create_room', ({ playerName, totalRounds = 10 }) => {
        if (!playerName || !playerName.trim()) {
            socket.emit('error_msg', 'Please enter a name!');
            return;
        }

        const roomId = createRoom(socket.id, playerName.trim(), totalRounds);
        socket.join(roomId);

        console.log(`[R] Room created: ${roomId} by ${playerName}`);

        socket.emit('room_created', {
            roomId,
            room: getRoomSafely(roomId),
        });
    });

    // ── JOIN ROOM ────────────────────────────────────────────────
    socket.on('join_room', ({ roomId, playerName }) => {
        if (!playerName || !playerName.trim()) {
            socket.emit('error_msg', 'Please enter a name!');
            return;
        }
        if (!roomId || !roomId.trim()) {
            socket.emit('error_msg', 'Please enter a room code!');
            return;
        }

        const result = joinRoom(roomId.toUpperCase(), socket.id, playerName.trim());

        if (result.error) {
            socket.emit('error_msg', result.error);
            return;
        }

        socket.join(roomId.toUpperCase());
        const safeRoom = getRoomSafely(roomId.toUpperCase());

        socket.emit('room_joined', {
            roomId: roomId.toUpperCase(),
            room: safeRoom,
        });

        socket.to(roomId.toUpperCase()).emit('player_joined', {
            player: safeRoom.players.find(p => p.id === socket.id),
            room: safeRoom,
        });

        console.log(`[J] ${playerName} joined room ${roomId.toUpperCase()}`);
    });

    // ── HOST START ───────────────────────────────────────────────
    socket.on('host_start', ({ roomId }) => {
        const check = canStartGame(roomId, socket.id);
        if (check.error) {
            socket.emit('error_msg', check.error);
            return;
        }

        const roundData = startGame(roomId);
        io.to(roomId).emit('game_start', {
            ...roundData,
            totalRounds: getRoom(roomId).totalRounds,
        });

        console.log(`[G] Game started: ${roomId} — Round 1 | ${roundData.pair.start} ► ${roundData.pair.end}`);

        scheduleRoundTimer(roomId);
    });

    // ── SUBMIT WORD ──────────────────────────────────────────────
    socket.on('submit_word', async ({ roomId, word }) => {
        if (!roomId || !word) return;

        // Block spam submissions while API check is in progress
        if (pendingApiCheck.has(socket.id)) return;

        const result = submitWord(roomId, socket.id, word);

        // Hard errors (room not found, no active round, etc.)
        if (result.error) {
            socket.emit('error_msg', result.error);
            return;
        }

        // Soft invalid — check if the reason is "NOT IN WORD LIST"
        // If so, try the dictionary API as a fallback
        if (result.invalid) {
            const w = word.toLowerCase().trim();
            const isNotInList = result.invalid.includes('NOT IN WORD LIST');

            if (isNotInList) {
                // Check if we already confirmed this word via API this session
                if (apiWordCache.has(w)) {
                    // Word is API-confirmed, inject it into the word list and resubmit
                    const { WORD_LIST } = require('./wordList');
                    WORD_LIST.add(w);
                    const retryResult = submitWord(roomId, socket.id, word);
                    handleSubmitResult(retryResult, roomId, socket, word);
                    return;
                }

                // Lock this player from submitting again until check is done
                pendingApiCheck.add(socket.id);
                socket.emit('checking_word', { word: w.toUpperCase() });

                console.log(`[API] Checking "${w}" via dictionary API...`);
                const isValid = await checkWordWithApi(w);

                pendingApiCheck.delete(socket.id);

                if (isValid) {
                    // Cache it and add to the live word list
                    apiWordCache.add(w);
                    const { WORD_LIST } = require('./wordList');
                    WORD_LIST.add(w);

                    console.log(`[API] "${w}" confirmed valid — added to session cache`);

                    const retryResult = submitWord(roomId, socket.id, word);
                    handleSubmitResult(retryResult, roomId, socket, word);
                } else {
                    console.log(`[API] "${w}" rejected by dictionary API`);
                    socket.emit('word_result', {
                        playerId: socket.id,
                        valid: false,
                        word: w.toUpperCase(),
                        reason: result.invalid,
                        scores: getRoomSafely(roomId)?.players.map(p => ({
                            id: p.id,
                            name: p.name,
                            score: p.score,
                        })) || [],
                    });
                }
                return;
            }

            // Any other invalid reason (wrong letters, already used, too short)
            socket.emit('word_result', {
                playerId: socket.id,
                valid: false,
                word: word.toUpperCase(),
                reason: result.invalid,
                scores: getRoomSafely(roomId)?.players.map(p => ({
                    id: p.id,
                    name: p.name,
                    score: p.score,
                })) || [],
            });
            return;
        }

        if (result.won) {
            handleSubmitResult(result, roomId, socket, word);
        }
    });

    // ── DISCONNECT ───────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[-] Disconnected: ${socket.id}`);
        pendingApiCheck.delete(socket.id);
        handlePlayerDisconnect(socket.id);
    });
});

// ═══════════════════════════════════════════════════════════════
//  HANDLE SUBMIT RESULT
//  Shared logic for both direct wins and API-confirmed wins
// ═══════════════════════════════════════════════════════════════
function handleSubmitResult(result, roomId, socket, word) {
    if (result.error) {
        socket.emit('error_msg', result.error);
        return;
    }

    if (result.invalid) {
        socket.emit('word_result', {
            playerId: socket.id,
            valid: false,
            word: word.toUpperCase(),
            reason: result.invalid,
            scores: getRoomSafely(roomId)?.players.map(p => ({
                id: p.id,
                name: p.name,
                score: p.score,
            })) || [],
        });
        return;
    }

    if (result.won) {
        const room = getRoom(roomId);
        if (room) clearRoomTimer(room);

        console.log(`[W] ${result.winnerName} won round with "${result.word}" in room ${roomId} (+${result.pointsAwarded}pts)`);

        socket.emit('word_result', {
            playerId: socket.id,
            valid: true,
            word: result.word,
            points: result.pointsAwarded,
            scores: result.scores,
        });

        io.to(roomId).emit('round_won', {
            winnerId: result.winnerId,
            winnerName: result.winnerName,
            word: result.word,
            points: result.pointsAwarded,
            scores: result.scores,
        });

        setTimeout(() => {
            if (isGameOver(roomId)) {
                endGame(roomId);
            } else {
                startNextRound(roomId);
            }
        }, BETWEEN_ROUND);
    }
}

// ═══════════════════════════════════════════════════════════════
//  ROUND TIMER
// ═══════════════════════════════════════════════════════════════
function scheduleRoundTimer(roomId) {
    setRoomTimer(roomId, () => {
        const result = handleRoundTimeout(roomId);
        if (!result) return;

        console.log(`[T] Round timed out in room ${roomId}`);
        io.to(roomId).emit('round_timeout', result);

        setTimeout(() => {
            if (isGameOver(roomId)) {
                endGame(roomId);
            } else {
                startNextRound(roomId);
            }
        }, BETWEEN_ROUND);

    }, ROUND_TIME * 1000);
}

// ═══════════════════════════════════════════════════════════════
//  NEXT ROUND
// ═══════════════════════════════════════════════════════════════
function startNextRound(roomId) {
    const room = getRoom(roomId);
    if (!room) return;

    const roundData = advanceRound(roomId);
    io.to(roomId).emit('next_round', {
        ...roundData,
        totalRounds: room.totalRounds,
    });

    console.log(`[R] Next round  : ${roomId} — Round ${roundData.roundNumber} | ${roundData.pair.start} ► ${roundData.pair.end}`);

    scheduleRoundTimer(roomId);
}

// ═══════════════════════════════════════════════════════════════
//  GAME OVER
// ═══════════════════════════════════════════════════════════════
function endGame(roomId) {
    const room = getRoom(roomId);
    if (!room) return;

    const results = getFinalResults(roomId);
    if (!results) return;

    const lastPairKey = room.currentPairKey;
    const { pairAnswers } = require('./wordList');
    const hintPool = pairAnswers[lastPairKey] || [];
    const hint = hintPool.length > 0
        ? hintPool[Math.floor(Math.random() * hintPool.length)].toUpperCase()
        : null;

    const payload = {
        winner: results.winner,
        scores: results.players.map(p => ({ id: p.id, name: p.name, score: p.score })),
        hint,
    };

    console.log(`[E] Game over   : ${roomId} | Winner: ${results.winner?.name}`);
    io.to(roomId).emit('game_over', payload);
}

// ═══════════════════════════════════════════════════════════════
//  DISCONNECT HANDLER
// ═══════════════════════════════════════════════════════════════
function handlePlayerDisconnect(socketId) {
    const roomId = findRoomByPlayer(socketId);
    if (!roomId) return;

    const result = leaveRoom(roomId, socketId);
    if (!result) return;

    if (result.roomDeleted) {
        console.log(`[D] Room deleted: ${roomId} (all players left)`);
        return;
    }

    const safeRoom = getRoomSafely(roomId);
    io.to(roomId).emit('player_left', {
        playerId: socketId,
        room: safeRoom,
    });

    console.log(`[D] Player left : ${socketId} from room ${roomId}`);

    if (safeRoom && safeRoom.state === 'playing') {
        const activePlayers = safeRoom.players.filter(p => p.active);
        if (activePlayers.length < 2) {
            const room = getRoom(roomId);
            if (room) clearRoomTimer(room);
            endGame(roomId);
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  START SERVER
// ═══════════════════════════════════════════════════════════════
server.listen(PORT, () => {
    console.log(`\n  ██████╗ ██████╗ ██╗██████╗  ██████╗ ███████╗`);
    console.log(`  ██╔══██╗██╔══██╗██║██╔══██╗██╔════╝ ██╔════╝`);
    console.log(`  ██████╔╝██████╔╝██║██║  ██║██║  ███╗█████╗  `);
    console.log(`  ██╔══██╗██╔══██╗██║██║  ██║██║   ██║██╔══╝  `);
    console.log(`  ██████╔╝██║  ██║██║██████╔╝╚██████╔╝███████╗`);
    console.log(`  ╚═════╝ ╚═╝  ╚═╝╚═╝╚═════╝  ╚═════╝ ╚══════╝`);
    console.log(`\n  Server running on http://localhost:${PORT}\n`);
});