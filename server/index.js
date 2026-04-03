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
//  DICTIONARY CACHE
//  using local trie loaded from words.txt so no API checks needed
// ═══════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════
//  SOCKET EVENTS
// ═══════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
    console.log(`[+] Connected   : ${socket.id}`);

    // ── CREATE ROOM ──────────────────────────────────────────────
    socket.on('create_room', ({ playerName, avatar, totalRounds = 10, isSinglePlayer = false, gameMode = 'single', timeLimit = 15, maxPlayers = 6 }) => {
        if (!playerName || !playerName.trim()) {
            socket.emit('error_msg', 'Please enter a name!');
            return;
        }

        const roomId = createRoom(socket.id, playerName.trim(), totalRounds, isSinglePlayer, gameMode, timeLimit, maxPlayers, avatar);
        socket.join(roomId);

        console.log(`[R] Room created: ${roomId} by ${playerName}`);

        socket.emit('room_created', {
            roomId,
            room: getRoomSafely(roomId),
        });
    });

    // ── JOIN ROOM ────────────────────────────────────────────────
    socket.on('join_room', ({ roomId, playerName, avatar }) => {
        if (!playerName || !playerName.trim()) {
            socket.emit('error_msg', 'Please enter a name!');
            return;
        }
        if (!roomId || !roomId.trim()) {
            socket.emit('error_msg', 'Please enter a room code!');
            return;
        }

        const result = joinRoom(roomId.toUpperCase(), socket.id, playerName.trim(), avatar);

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
    socket.on('submit_word', ({ roomId, word }) => {
        if (!roomId || !word) return;

        const result = submitWord(roomId, socket.id, word);

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
                scores: getRoomSafely(roomId)?.players.map(p => ({ id: p.id, name: p.name, score: p.score })) || [],
            });
            return;
        }

        if (result.normalWin) {
            handleNormalRoundComplete(result, roomId);
            return;
        }

        if (result.limitlessValid) {
            socket.emit('word_result', {
                playerId: socket.id,
                valid: true,
                word: result.word,
                points: result.pointsAwarded,
                scores: result.scores,
            });
            // Also notify others so they see the live score update and the word history
            socket.to(roomId).emit('player_scored', {
                playerId: socket.id,
                word: result.word,
                points: result.pointsAwarded,
                scores: result.scores
            });
            return;
        }

        if (result.waitingForOthers) {
            socket.emit('word_result', {
                playerId: socket.id,
                valid: true,
                waiting: true,
                word: result.word,
            });
            return;
        }

        if (result.singleRoundComplete) {
            handleSingleRoundComplete(result, roomId);
            return;
        }
    });

    // ── CHAT MESSAGES ──────────────────────────────────────────────
    socket.on('chat_msg', ({ roomId, msg, senderName, avatar }) => {
        if (!roomId || !msg) return;
        io.to(roomId).emit('chat_msg', { senderName, avatar, msg, timestamp: Date.now() });
    });

    // ── DISCONNECT ───────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[-] Disconnected: ${socket.id}`);
        handlePlayerDisconnect(socket.id);
    });
});

function handleNormalRoundComplete(result, roomId) {
    const room = getRoom(roomId);
    if (room) clearRoomTimer(room);

    io.to(roomId).emit('round_complete_normal', result);

    setTimeout(() => {
        if (isGameOver(roomId)) endGame(roomId);
        else startNextRound(roomId);
    }, 4000);
}

// ═══════════════════════════════════════════════════════════════
//  HANDLE SINGLE ROUND COMPLETE
// ═══════════════════════════════════════════════════════════════
function handleSingleRoundComplete(result, roomId) {
    const room = getRoom(roomId);
    if (room) clearRoomTimer(room);

    io.to(roomId).emit('round_complete', result);

    setTimeout(() => {
        if (isGameOver(roomId)) {
            endGame(roomId);
        } else {
            startNextRound(roomId);
        }
    }, 4000);
}

// ═══════════════════════════════════════════════════════════════
//  ROUND TIMER
// ═══════════════════════════════════════════════════════════════
function scheduleRoundTimer(roomId) {
    const room = getRoomSafely(roomId);
    const timeLimit = room ? room.timeLimit : 15;

    setRoomTimer(roomId, () => {
        const result = handleRoundTimeout(roomId);
        if (!result) return;

        console.log(`[T] Round timed out in room ${roomId}`);

        if (result.limitlessFinish) {
            io.to(roomId).emit('round_timeout', result);
        } else if (result.timeoutNormal) {
            io.to(roomId).emit('round_timeout', result);
        } else if (result.singleRoundComplete) {
            io.to(roomId).emit('round_complete', result);
        }

        setTimeout(() => {
            if (isGameOver(roomId)) {
                endGame(roomId);
            } else {
                startNextRound(roomId);
            }
        }, 4000);

    }, timeLimit * 1000);
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
        playerHistory: results.playerHistory
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
        const room = getRoom(roomId);
        if (room && !room.isSinglePlayer && activePlayers.length < 2) {
            clearRoomTimer(room);
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

// Graceful shutdown — release port on restart/watch reload
function gracefulShutdown() {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 2000);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);