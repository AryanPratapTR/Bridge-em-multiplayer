const fs = require('fs');
const path = require('path');

let content = fs.readFileSync('server/wordList.js', 'utf8');

const newCode = `const fs = require('fs');
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
try {
    const data = fs.readFileSync(path.join(__dirname, '../words.txt'), 'utf8');
    const words = data.split(/\\r?\\n/);
    for (let w of words) {
        w = w.trim().toLowerCase();
        if (w.length > 2 && /^[a-z]+$/.test(w)) WORD_LIST.add(w);
    }
    console.log('[+] Loaded words into Trie.');
} catch(e) {
    console.error('Error loading words.txt', e);
}
`;

content = content.replace(/const WORDS = \[.*?\];/s, newCode);
content = content.replace(/const WORD_LIST = new Set\(WORDS\);/, '');

fs.writeFileSync('server/wordList.js', content, 'utf8');
console.log('done');
