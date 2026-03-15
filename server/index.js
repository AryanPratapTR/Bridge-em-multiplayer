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
    // NOTE: client emits 'host_start', NOT 'start_game'
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

        // Hard errors (room not found, no active round, etc.)
        if (result.error) {
            socket.emit('error_msg', result.error);
            return;
        }

        // Soft invalid (wrong letters, not in word list, already used, etc.)
        // Emit word_result to the submitting player only
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

        // Valid word — someone won the round
        if (result.won) {
            const room = getRoom(roomId);
            if (room) clearRoomTimer(room);

            console.log(`[W] ${result.winnerName} won round with "${result.word}" in room ${roomId}`);

            // Tell the winner their result first
            socket.emit('word_result', {
                playerId: socket.id,
                valid: true,
                word: result.word,
                points: 10,
                scores: result.scores,
            });

            // Tell everyone the round is over
            io.to(roomId).emit('round_won', {
                winnerId: result.winnerId,
                winnerName: result.winnerName,
                word: result.word,
                scores: result.scores,
            });

            // Advance after pause
            setTimeout(() => {
                if (isGameOver(roomId)) {
                    endGame(roomId);
                } else {
                    startNextRound(roomId);
                }
            }, BETWEEN_ROUND);
        }
    });

    // ── DISCONNECT ───────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[-] Disconnected: ${socket.id}`);
        handlePlayerDisconnect(socket.id);
    });
});

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

    // Get a hint for the last pair as a bonus fact
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

    // If mid-game and not enough players remain, abort
    if (safeRoom && safeRoom.state === 'playing') {
        const activePlayers = safeRoom.players.filter(p => p.active);
        if (activePlayers.length < 2) {
            const room = getRoom(roomId);
            if (room) clearRoomTimer(room);
            // End the game properly rather than just aborting
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