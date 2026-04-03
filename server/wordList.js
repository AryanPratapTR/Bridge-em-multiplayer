const fs = require('fs');
const path = require('path');

class TrieNode {
    constructor() {
        this.children = {};
        this.isWord = false;
    }
}

class Trie {
    constructor() { this.root = new TrieNode(); }
    add(word) {
        let node = this.root;
        for (const char of word) {
            if (!node.children[char]) node.children[char] = new TrieNode();
            node = node.children[char];
        }
        node.isWord = true;
    }
    has(word) {
        let node = this.root;
        for (const char of word) {
            if (!node.children[char]) return false;
            node = node.children[char];
        }
        return node.isWord;
    }
}

const WORD_LIST = new Trie();
const pairAnswers = {};

try {
    const data = fs.readFileSync(path.join(__dirname, '../words.txt'), 'utf8');
    const words = data.split(/\r?\n/);
    for (let w of words) {
        w = w.trim().toLowerCase();
        // Allow words with length > 2 (original game logic) and containing only a-z letters
        if (w.length > 2 && /^[a-z]+$/.test(w)) {
            WORD_LIST.add(w);

            // Build pair mapping directly here for fast indexing (start char + end char)
            const key = w[0] + w[w.length - 1];
            if (!pairAnswers[key]) pairAnswers[key] = [];
            pairAnswers[key].push(w);
        }
    }
    console.log('[+] Loaded words into Trie and mapped valid pairs seamlessly.');
} catch (e) {
    console.error('Error loading words.txt', e);
}

const VALID_PAIRS = Object.keys(pairAnswers);

// ═══════════════════════════════════════════════════════════════
//  DIFFICULTY TIERS (LEVEL 1-5)
//  Calculated dynamically using quantiles of word counts
//  Level 1: Easiest (Most words) -> Level 5: Hardest (Fewest words)
// ═══════════════════════════════════════════════════════════════
const counts = VALID_PAIRS.map(k => pairAnswers[k].length).sort((a, b) => a - b);
const q1 = counts[Math.floor(counts.length * 0.2)];
const q2 = counts[Math.floor(counts.length * 0.4)];
const q3 = counts[Math.floor(counts.length * 0.6)];
const q4 = counts[Math.floor(counts.length * 0.8)];

const LEVEL_PAIRS = { 1: [], 2: [], 3: [], 4: [], 5: [] };

for (const [key, answers] of Object.entries(pairAnswers)) {
    const count = answers.length;
    if (count >= q4) LEVEL_PAIRS[1].push(key);
    else if (count >= q3) LEVEL_PAIRS[2].push(key);
    else if (count >= q2) LEVEL_PAIRS[3].push(key);
    else if (count >= q1) LEVEL_PAIRS[4].push(key);
    else LEVEL_PAIRS[5].push(key);
}

module.exports = { WORD_LIST, pairAnswers, VALID_PAIRS, LEVEL_PAIRS };