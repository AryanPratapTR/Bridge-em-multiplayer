# 🌉 Bridge-Em Multiplayer

A real-time, fast-paced multiplayer word puzzle game. Players race to find words that **start** with one letter and **end** with another. Features live chat, avatars, multiple game modes, and dynamic difficulty scaling.

---

## ✨ Features

- **3 Game Modes:**
  - 🏎️ **Limitless** — Submit as many valid words as possible before the timer runs out.
  - 🏁 **Single Word** — One answer per player per round; fastest correct answer gets a speed bonus.
  - ⚡ **Normal** — First valid submission instantly wins the round.
- **Dynamic Difficulty (Level 1–5):** Letter pairs are graded by word availability using quantile analysis.
- **Length-Based Scoring:** Longer words = more points (5 → 7 → 9 → 11 → 13 → 15 max).
- **Real-Time Chat:** In-game messaging with emoji avatars.
- **Avatar Selection:** Choose your mascot emoji before joining a game.
- **Configurable Rooms:** Set time limits, max players, game mode, and round count.
- **Dark Mode:** Toggle between light and dark themes (persisted in localStorage).
- **Solo Mode:** Practice alone without needing other players.
- **Post-Game Insights:** See possible answers you missed after each round.

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, Express.js |
| Real-Time | Socket.IO |
| Frontend | HTML5, CSS3, Vanilla JS |
| Dictionary | Local Trie from `words.txt` (~370k words) |

---

## 📋 Prerequisites

- [Node.js](https://nodejs.org/) v16 or higher
- npm (comes with Node.js)

---

## 🚀 Getting Started

### 1. Clone the repository

```bash
git clone <repository_url>
cd Bridge-em-multiplayer
```

### 2. Install dependencies

```bash
npm install
```

### 3. (Optional) Configure environment

Create a `.env` file in the project root:

```env
PORT=3000
```

### 4. Start the server

**Development mode** (auto-reloads on file changes):
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

### 5. Open in browser

Navigate to **http://localhost:3000** — that's it!

---

## 🎮 How to Play

1. **Pick a name** and select your **avatar emoji**.
2. **Create a room** (you're the host) or **Join** with a 6-character room code.
3. The host can open **⚙️ Settings** to configure:
   - Game Mode (Limitless / Single Word / Normal)
   - Time Limit per round
   - Max Players
   - Number of Rounds
4. Each round shows a **Start Letter** and **End Letter** — type a real English word that starts and ends with those letters.
5. Points are awarded based on word length. Longer words = more points.
6. After all rounds, see the final leaderboard and play again!

---

## 📁 Project Structure

```
Bridge-em-multiplayer/
├── client/                  # Frontend static files
│   ├── index.html           # Single-page app (HTML + CSS + JS)
│   ├── mascot.webm          # Animated mascot asset
│   └── mascot1.webm         # Alternative mascot asset
├── server/                  # Backend source code
│   ├── index.js             # Express & Socket.IO server
│   ├── gameManager.js       # Room/round/scoring logic
│   └── wordList.js          # Trie dictionary + difficulty tiers
├── words.txt                # Word list (~370k English words)
├── package.json             # Dependencies & scripts
├── .env                     # Environment config (optional)
└── .gitignore               # Git ignored files
```

---

## 🔧 Troubleshooting

### `EADDRINUSE: address already in use :::3000`

A previous Node process is still holding the port. Fix it:

**Windows:**
```bash
netstat -ano | findstr :3000
taskkill /F /PID <PID_NUMBER>
```

**Mac/Linux:**
```bash
lsof -i :3000
kill -9 <PID>
```

Then restart with `npm run dev`.

---

## 📄 License

ISC License
