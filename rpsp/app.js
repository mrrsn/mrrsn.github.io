import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import { getDatabase, ref, set, onValue, update, remove, push, get, child, serverTimestamp, query, orderByChild, endAt, limitToFirst, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js';

// Initialize Firebase
let app, database;

// Emoji templates for choices
const EMOJI_TEMPLATES = {
    rock: '✊',
    paper: '🖐️',
    scissors: '✌️'
};

// Room code length (number of symbols)
const ROOM_CODE_LEN = 4;

// Try to initialize Firebase if config is valid
async function initializeFirebase() {
    try {
        if (database) return true; // already initialized

        // Check if config is set up
        if (
            !firebaseConfig ||
            firebaseConfig.apiKey === 'YOUR_API_KEY' ||
            !firebaseConfig.projectId
        ) {
            showError('Please configure Firebase in firebase-config.js');
            setConnectionStatus('offline', 'Not configured');
            return false;
        }

        if (!firebaseConfig.databaseURL || firebaseConfig.databaseURL.includes('YOUR_DATABASE_URL')) {
            showError('Add your Realtime Database URL to firebase-config.js');
            setConnectionStatus('offline', 'Missing databaseURL');
            return false;
        }

        app = initializeApp(firebaseConfig);
        database = getDatabase(app, firebaseConfig.databaseURL);

        // Mark as connecting until .info/connected confirms
        setConnectionStatus('connecting', 'Connecting…');

        // Listen to Realtime Database connection state
        const connRef = ref(database, '.info/connected');
        onValue(connRef, (snap) => {
            const isConnected = !!snap.val();
            if (isConnected) {
                setConnectionStatus('online', 'Connected');
            } else {
                setConnectionStatus('offline', 'Offline');
            }
        });
        return true;
    } catch (error) {
        console.error('Firebase initialization error:', error);
        showError('Failed to initialize Firebase: ' + error.message);
        setConnectionStatus('offline', 'Init failed');
        return false;
    }
}

// Persisted session helpers
const SESSION_KEY = 'rpsp_session_v1';
function saveSession() {
    try {
        if (currentRoom && currentPlayer) {
            localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId: currentRoom, playerId: currentPlayer }));
        }
    } catch (_) {}
}
function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}
function getSavedSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
}
// Game state
let currentRoom = null;
let currentPlayer = null;
let gameState = null;
let roomListener = null;
let heartbeatInterval = null;
let cleanupTimeoutId = null;
let suppressAutoNav = false; // when true, ignore automatic screen changes to non-setup screens

// DOM elements
const screens = {
    setup: document.getElementById('setupScreen'),
    createRoom: document.getElementById('createRoomScreen'),
    joinRoom: document.getElementById('joinRoomScreen'),
    waitingRoom: document.getElementById('waitingRoomScreen'),
    game: document.getElementById('gameScreen')
};

// Utility functions
function showScreen(screenName) {
    if (suppressAutoNav && screenName !== 'setup') return;
    Object.values(screens).forEach(screen => screen.classList.remove('active'));
    screens[screenName].classList.add('active');
}

function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    errorDiv.textContent = message;
    errorDiv.classList.add('show');
    setTimeout(() => {
        errorDiv.classList.remove('show');
    }, 5000);
}
function generateRoomId() {
    // Generate a code using R, P, S of length ROOM_CODE_LEN
    const symbols = ['R', 'P', 'S'];
    let code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
        code += symbols[Math.floor(Math.random() * symbols.length)];
    }
    return code;
}

function rpsCodeToEmoji(code) {
    const map = { R: '✊', P: '🖐️', S: '✌️' };
    return code.split('').map(c => map[c] || '').join('');
}

function emojiToRpsCode(emojiStr) {
    const map = { '✊': 'R', '🖐️': 'P', '✌️': 'S' };
    return emojiStr.split('').map(e => map[e] || '').join('');
}

function getChoiceIcon(choice) {
    const emoji = EMOJI_TEMPLATES[choice];
    return emoji ? `<span aria-hidden="true" style="font-size: 1.8rem; line-height: 1">${emoji}</span>` : '';
}

// --- Join room code via emoji buttons ---
let joinCodeBuffer = [];
function renderJoinCode() {
    const disp = document.getElementById('codeDisplay');
    if (!disp) return;
    const map = { R: '✊', P: '🖐️', S: '✌️' };
    const filled = joinCodeBuffer.map(c => map[c]).join('');
    const blanks = '_'.repeat(Math.max(0, ROOM_CODE_LEN - joinCodeBuffer.length));
    disp.textContent = filled + blanks;
    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) joinBtn.disabled = joinCodeBuffer.length !== ROOM_CODE_LEN;
    const hint = document.getElementById('codeHint');
    if (hint) hint.style.display = joinCodeBuffer.length === ROOM_CODE_LEN ? 'none' : 'block';
}

function getEnteredRpsCode() {
    return joinCodeBuffer.join('');
}

function setJoinCodeFromString(code) {
    joinCodeBuffer = [];
    const valid = ['R', 'P', 'S'];
    for (let i = 0; i < Math.min(code.length, ROOM_CODE_LEN); i++) {
        const c = code[i].toUpperCase();
        if (valid.includes(c)) joinCodeBuffer.push(c);
    }
    renderJoinCode();
}

// Game logic
function determineWinner(choices) {
    const players = Object.keys(choices);
    const uniqueChoices = [...new Set(Object.values(choices))];
    
    // All same or all different (3-way impasse for 3 players)
    if (uniqueChoices.length === 1) {
        return { type: 'tie', players: players };
    }
    
    if (players.length === 3 && uniqueChoices.length === 3) {
        return { type: 'impasse', players: [] };
    }
    
    // Determine winners
    const winners = [];
    const losers = [];
    
    players.forEach(player => {
        const choice = choices[player];
    let wins = 0;
    let losses = 0;
        
        players.forEach(opponent => {
            if (player !== opponent) {
                const opponentChoice = choices[opponent];
                if (beats(choice, opponentChoice)) {
                    wins++;
                } else if (beats(opponentChoice, choice)) {
                    losses++;
                }
            }
        });
        
        if (wins > 0 && losses === 0) {
            winners.push(player);
        } else if (losses > 0 && wins === 0) {
            losers.push(player);
        }
    });
    
    if (winners.length === 1) {
        return { type: 'winner', players: winners };
    } else if (winners.length > 1) {
        return { type: 'tie', players: winners };
    }
    
    return { type: 'unclear', players: [] };
}

function beats(choice1, choice2) {
    const rules = {
        rock: 'scissors',
        scissors: 'paper',
        paper: 'rock'
    };
    return rules[choice1] === choice2;
}

// Room management
async function createRoom() {
    // entering a create flow is a user action; allow navigation again
    suppressAutoNav = false;
    if (!database) {
        const ok = await initializeFirebase();
        if (!ok) return;
    }
    const name = document.getElementById('hostName').value.trim();
    const playerCountBtn = document.querySelector('.player-count-btn.active');
    const playerCount = playerCountBtn ? parseInt(playerCountBtn.dataset.count) : 2;
    const pointsToWin = parseInt(document.getElementById('pointsToWin').value);

    if (!name) {
        showError('Please enter your name');
        return;
    }

    if (Number.isNaN(pointsToWin) || pointsToWin < 1 || pointsToWin > 20) {
        showError('Points to win must be between 1 and 20');
        return;
    }

    const playerId = Date.now().toString();
    try {
        // Atomically claim a unique room code and create the room
        let claimed = false;
        let roomId = '';
        for (let attempts = 0; attempts < 50 && !claimed; attempts++) {
            roomId = generateRoomId();
            const roomRef = ref(database, `rooms/${roomId}`);
            const roomData = {
                id: roomId,
                maxPlayers: playerCount,
                pointsToWin: pointsToWin,
                status: 'waiting',
                round: 1,
                players: {
                    [playerId]: {
                        name: name,
                        score: 0,
                        ready: false,
                        choice: null
                    }
                },
                choices: {},
                results: null,
                createdAt: Date.now(),
                // Use client time inside transaction; heartbeat will update with server time shortly after
                lastActivity: Date.now()
            };
            const result = await runTransaction(roomRef, (current) => {
                // If already exists, abort this code; else create it
                if (current) return current;
                return roomData;
            });
            if (result.committed) {
                claimed = true;
                // bump lastActivity to server time outside transaction
                await update(roomRef, { lastActivity: serverTimestamp() }).catch(() => {});
                currentRoom = roomId;
                currentPlayer = playerId;
                saveSession();
                joinWaitingRoom(roomId, playerId);
                startRoomHeartbeat(roomId);
            }
        }
        if (!claimed) {
            showError('Unable to generate a room code right now. Please try again.');
        }
    } catch (error) {
        console.error('Error creating room:', error);
        showError('Failed to create room: ' + error.message);
    }
}

async function joinRoom() {
    // entering a join flow is a user action; allow navigation again
    suppressAutoNav = false;
    if (!database) {
        const ok = await initializeFirebase();
        if (!ok) return;
    }
    const name = document.getElementById('playerName').value.trim();
    const roomId = getEnteredRpsCode();
    if (!roomId || roomId.length !== ROOM_CODE_LEN) {
        showError(`Enter a ${ROOM_CODE_LEN}-symbol room code`);
        return;
    }
    if (!name) {
        showError('Please enter your name');
        return;
    }

    const playerId = Date.now().toString();
    const roomRef = ref(database, `rooms/${roomId}`);
    try {
        // Atomically add the player if the room exists, is waiting, and not full
        const result = await runTransaction(roomRef, (room) => {
            if (!room) return room; // room doesn't exist
            const players = room.players || {};
            const playerCount = Object.keys(players).length;
            if (room.status !== 'waiting') return room; // already started or finished
            if (playerCount >= room.maxPlayers) return room; // full
            // add player
            room.players = players;
            room.players[playerId] = {
                name: name,
                score: 0,
                ready: false,
                choice: null
            };
            room.lastActivity = Date.now();
            return room;
        });

        const committed = result.committed;
        const finalRoom = result.snapshot && result.snapshot.val();
        if (!committed || !finalRoom || !finalRoom.players || !finalRoom.players[playerId]) {
            // Determine a friendly error
            if (!finalRoom) {
                showError('Room not found');
            } else if (finalRoom.status !== 'waiting') {
                showError('Game already started');
            } else if (Object.keys(finalRoom.players || {}).length >= finalRoom.maxPlayers) {
                showError('Room is full');
            } else {
                showError('Failed to join room. Please try again.');
            }
            return;
        }

        // bump lastActivity to server time outside transaction
        await update(roomRef, { lastActivity: serverTimestamp() }).catch(() => {});

        currentRoom = roomId;
        currentPlayer = playerId;
        saveSession();
        joinWaitingRoom(roomId, playerId);
        startRoomHeartbeat(roomId);
    } catch (error) {
        console.error('Error joining room:', error);
        showError('Failed to join room: ' + error.message);
    }
}

function joinWaitingRoom(roomId, playerId) {
    showScreen('waitingRoom');
    const disp = document.getElementById('displayRoomId');
    if (disp) {
        disp.textContent = rpsCodeToEmoji(roomId);
        // Store canonical room code to avoid emoji parsing issues
        disp.dataset.code = roomId;
    }
    
    // Listen for room updates
    roomListener = onValue(ref(database, `rooms/${roomId}`), (snapshot) => {
        if (!snapshot.exists()) {
            showError('Room no longer exists');
            backToMenu();
            return;
        }
        
        const room = snapshot.val();
        gameState = room;
    // keep session current
    saveSession();
        
        const playerCount = Object.keys(room.players).length;
        document.getElementById('currentPlayers').textContent = playerCount;
        document.getElementById('maxPlayers').textContent = room.maxPlayers;
        
        // Update players list
        const playersList = document.getElementById('playersList');
        playersList.innerHTML = '';
        Object.entries(room.players).forEach(([id, player]) => {
            const div = document.createElement('div');
            div.className = 'player-item';
            div.textContent = player.name + (id === playerId ? ' (You)' : '');
            playersList.appendChild(div);
        });
        
        // If game finished, show winner for all players
        if (room.status === 'finished' && room.winner) {
            const winnerId = room.winner.id;
            const winnerPlayer = room.players[winnerId];
            if (winnerPlayer) {
                // Ensure we're on the game screen (unless suppressed)
                showScreen('game');
                showWinner(winnerId, winnerPlayer);
                return;
            }
        }

        // Start game when room is full
        if (playerCount === room.maxPlayers && room.status === 'waiting') {
            setTimeout(() => startGame(roomId), 1000);
        } else if (room.status === 'playing') {
            // Ensure all players see the game and results updates
            showGameScreen();
            // If results are available, show them (and Next/Ready button) for everyone
            if (room.results && document.getElementById('resultsSection').style.display === 'none') {
                displayRoundResults(room.results);
            }
            // Always refresh scores while playing
            updateGameDisplay();
        } else if (room.status === 'finished') {
            // Defensive: keep waiting/results hidden when finished but no winner object yet
            const waitingEl = document.getElementById('waitingForPlayers');
            if (waitingEl) waitingEl.style.display = 'none';
            const resultsEl = document.getElementById('resultsSection');
            if (resultsEl) resultsEl.style.display = 'none';
        }
    });
}

async function startGame(roomId) {
    try {
        await update(ref(database, `rooms/${roomId}`), {
            status: 'playing',
            lastActivity: serverTimestamp()
        });
    } catch (error) {
        console.error('Error starting game:', error);
    }
}

function showGameScreen() {
    showScreen('game');
    updateGameDisplay();
    
    // Reset choice UI
    document.getElementById('choiceSection').style.display = 'block';
    document.getElementById('waitingForPlayers').style.display = 'none';
    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('winnerSection').style.display = 'none';
    // Ensure score tiles are visible for active games
    const scoresEl = document.getElementById('scoresDisplay');
    if (scoresEl) scoresEl.style.display = '';
    
    document.querySelectorAll('.choice-btn').forEach(btn => {
        btn.classList.remove('selected');
    });
    document.getElementById('yourChoice').textContent = '';

    // Respect current player's ready state and tiebreaker participation
    const you = gameState && currentPlayer ? gameState.players?.[currentPlayer] : null;
    const isTbActive = !!(gameState && gameState.tiebreakerActive && Array.isArray(gameState.tiebreaker));
    const tbPlayers = isTbActive ? gameState.tiebreaker : [];
    const youInTb = isTbActive ? tbPlayers.includes(currentPlayer) : true;
    const choiceSection = document.getElementById('choiceSection');
    const waiting = document.getElementById('waitingForPlayers');
    const results = document.getElementById('resultsSection');
    const winner = document.getElementById('winnerSection');
    const waitingMsg = waiting ? waiting.querySelector('p') : null;

    if (results) results.style.display = 'none';
    if (winner) winner.style.display = 'none';

    if (isTbActive && !youInTb) {
        // Not part of the tiebreaker: kindly ask to wait
        if (choiceSection) choiceSection.style.display = 'none';
        if (waiting) waiting.style.display = 'block';
        if (waitingMsg) waitingMsg.textContent = 'Please wait while the tiebreaker is resolved…';
    } else if (you && you.ready) {
        if (choiceSection) choiceSection.style.display = 'none';
        if (waiting) waiting.style.display = 'block';
        if (waitingMsg) waitingMsg.textContent = 'Waiting…';
    } else {
        if (choiceSection) choiceSection.style.display = 'block';
        if (waiting) waiting.style.display = 'none';
        // Clear prior visual selection when showing choices
        document.querySelectorAll('.choice-btn').forEach(btn => btn.classList.remove('selected'));
        const yourChoice = document.getElementById('yourChoice');
        if (yourChoice) yourChoice.textContent = '';
    }
}

function updateGameDisplay() {
    if (!gameState) return;
    
    document.getElementById('roundNumber').textContent = gameState.round;
    
    // Update scores
    const scoresDiv = document.getElementById('scoresDisplay');
    scoresDiv.innerHTML = '';
    const compactNames = window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
    function getInitials(name) {
        if (!name) return '';
        const parts = name.trim().split(/\s+/);
        const initials = parts.slice(0, 2).map(p => p[0].toUpperCase()).join('');
        return initials || name[0]?.toUpperCase() || '';
    }

    Object.entries(gameState.players).forEach(([id, player]) => {
        const scoreItem = document.createElement('div');
        scoreItem.className = 'score-item';
        const displayName = compactNames ? getInitials(player.name) : player.name;
        const you = id === currentPlayer ? (compactNames ? ' *' : ' (You)') : '';
        scoreItem.innerHTML = `
            <div class="player-name" title="${player.name}">${displayName}${you}</div>
            <div class="player-score">${player.score}</div>
        `;
        scoresDiv.appendChild(scoreItem);
    });
}

// Choice handling
document.querySelectorAll('.choice-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        // Only handle game choices when on the game screen
        if (!screens.game.classList.contains('active')) return;
        if (!currentRoom || !currentPlayer) return;
        // During a tiebreaker, only participants can pick
        const isTbActive = !!(gameState && gameState.tiebreakerActive && Array.isArray(gameState.tiebreaker));
        if (isTbActive && !gameState.tiebreaker.includes(currentPlayer)) {
            const waiting = document.getElementById('waitingForPlayers');
            const waitingMsg = waiting ? waiting.querySelector('p') : null;
            if (waiting) waiting.style.display = 'block';
            if (waitingMsg) waitingMsg.textContent = 'Please wait while the tiebreaker is resolved…';
            return;
        }
        
        const choice = btn.dataset.choice;
        
        // Update UI
        document.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        document.getElementById('yourChoice').textContent = `You chose: ${choice.charAt(0).toUpperCase() + choice.slice(1)}`;
        
        // Save choice to database
        try {
            await update(ref(database, `rooms/${currentRoom}/players/${currentPlayer}`), {
                choice: choice,
                ready: true
            });
            // mark activity
            await update(ref(database, `rooms/${currentRoom}`), { lastActivity: serverTimestamp() });
            
            // Hide choice section and show waiting
            document.getElementById('choiceSection').style.display = 'none';
            document.getElementById('waitingForPlayers').style.display = 'block';
            
            // Check if all players are ready
            checkAllPlayersReady();
        } catch (error) {
            console.error('Error saving choice:', error);
            showError('Failed to save choice');
        }
    });
});

// Code entry buttons on Join screen
document.querySelectorAll('.code-choice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (joinCodeBuffer.length >= ROOM_CODE_LEN) return;
        const code = btn.dataset.code;
        if (code === 'R' || code === 'P' || code === 'S') {
            joinCodeBuffer.push(code);
            renderJoinCode();
        }
    });
});

const clearBtn = document.getElementById('codeClearBtn');
if (clearBtn) {
    clearBtn.addEventListener('click', () => {
        joinCodeBuffer = [];
        renderJoinCode();
    });
}

async function checkAllPlayersReady() {
    if (!gameState) return;
    const isTbActive = !!(gameState && gameState.tiebreakerActive && Array.isArray(gameState.tiebreaker));
    const participantIds = isTbActive ? gameState.tiebreaker : Object.keys(gameState.players);
    const allReady = participantIds.every(id => gameState.players[id]?.ready);
    
    if (allReady) {
        // Calculate results
        const choices = {};
        participantIds.forEach(id => {
            const player = gameState.players[id];
            choices[id] = player ? player.choice : null;
        });
        
        const result = determineWinner(choices);
        await processRoundResult(result, choices);
    }
}

async function processRoundResult(result, choices) {
    try {
        const updates = {};
        
        // Prepare result display data
        const resultData = {
            type: result.type,
            choices: choices,
            winners: result.players
        };
        
        // Check if this is a tiebreaker resolution round
        const wasTiebreaker = gameState.tiebreakerActive;
        const playerCount = Object.keys(gameState.players).length;
        
        // Update scores based on result type
        if (result.type === 'winner') {
            // Check if this was a tiebreaker round
            if (wasTiebreaker && gameState.tiebreaker) {
                // Tiebreaker resolved: winner gets 2 pts
                result.players.forEach(playerId => {
                    const currentScore = gameState.players[playerId].score;
                    updates[`players/${playerId}/score`] = currentScore + 2;
                });
                
                // Runner-up (other player who was in tiebreaker but didn't win) gets 1 pt
                gameState.tiebreaker.forEach(playerId => {
                    if (!result.players.includes(playerId)) {
                        const currentScore = gameState.players[playerId].score;
                        updates[`players/${playerId}/score`] = currentScore + 1;
                    }
                });
                
                resultData.message = 'Tiebreaker resolved! Winner gets 2 pts, runner-up gets 1 pt';
                resultData.tiebreakerParticipants = [...gameState.tiebreaker];
                updates['tiebreaker'] = null;
                updates['tiebreakerActive'] = false;
            } else {
                // Clear winner gets 1 point
                result.players.forEach(playerId => {
                    const currentScore = gameState.players[playerId].score;
                    updates[`players/${playerId}/score`] = currentScore + 1;
                });
            }
        } else if (result.type === 'tie') {
            if (wasTiebreaker && gameState.tiebreaker && Array.isArray(gameState.tiebreaker)) {
                // Tiebreaker tied again: no points, try again with same participants
                updates['tiebreaker'] = [...gameState.tiebreaker];
                updates['tiebreakerActive'] = false; // next round will flip to active
                resultData.tiebreakerParticipants = [...gameState.tiebreaker];
                resultData.message = 'Tiebreaker tied! Try again.';
            } else if (playerCount === 2) {
                // With only 2 players, a tie clears all points
                Object.keys(gameState.players).forEach(playerId => {
                    updates[`players/${playerId}/score`] = 0;
                });
                updates['tiebreaker'] = null;
                updates['tiebreakerActive'] = false;
                resultData.message = 'Tie with 2 players! All points cleared.';
            } else if (playerCount === 3) {
                if (result.players.length === 2) {
                    // Two of three tied (they both beat/lose together) -> tiebreaker next round
                    updates['tiebreaker'] = result.players;
                    updates['tiebreakerActive'] = false;
                    resultData.tiebreakerParticipants = [...result.players];
                    resultData.message = '2-way tie! Next round is a tiebreaker: Winner +2, runner-up +1.';
                } else {
                    // All three tied (all chose the same) -> no tiebreaker, just replay
                    updates['tiebreaker'] = null;
                    updates['tiebreakerActive'] = false;
                    resultData.message = 'All chose the same. No points awarded—replay the round.';
                }
            }
        } else if (result.type === 'impasse') {
            // 3-way impasse resets all scores to 0
            Object.keys(gameState.players).forEach(playerId => {
                updates[`players/${playerId}/score`] = 0;
            });
            resultData.message = '3-way impasse! All scores reset to 0';
            updates['tiebreaker'] = null;
            updates['tiebreakerActive'] = false;
        }
        
        // Reset ready and choice for next round
        Object.keys(gameState.players).forEach(playerId => {
            updates[`players/${playerId}/ready`] = false;
            updates[`players/${playerId}/choice`] = null;
        });
        
    updates['results'] = resultData;
    updates['lastActivity'] = serverTimestamp();
        
        await update(ref(database, `rooms/${currentRoom}`), updates);
        
        // Show results
        displayRoundResults(resultData);
        
    } catch (error) {
        console.error('Error processing result:', error);
        showError('Failed to process round result');
    }
}

function displayRoundResults(resultData) {
    document.getElementById('waitingForPlayers').style.display = 'none';
    document.getElementById('resultsSection').style.display = 'block';
    
    const resultsDiv = document.getElementById('roundResults');
    resultsDiv.innerHTML = '';
    
    // Show message if exists
    if (resultData.message) {
        const messageDiv = document.createElement('div');
        messageDiv.style.padding = '15px';
        messageDiv.style.background = '#ffc107';
        messageDiv.style.borderRadius = '8px';
        messageDiv.style.marginBottom = '15px';
        messageDiv.style.fontWeight = 'bold';
        messageDiv.textContent = resultData.message;
        resultsDiv.appendChild(messageDiv);
    }
    
    // Show each player's choice and outcome
    Object.entries(resultData.choices).forEach(([playerId, choice]) => {
        const player = gameState.players[playerId];
        const isWinner = resultData.winners.includes(playerId);
        const wasTiebreaker = resultData.message && resultData.message.includes('Tiebreaker resolved');
        const tiebreakerList = resultData.tiebreakerParticipants || gameState.tiebreaker || [];
        const wasInTiebreaker = Array.isArray(tiebreakerList) && tiebreakerList.includes(playerId);
        
        const resultItem = document.createElement('div');
        resultItem.className = 'result-item';
        
        let outcomeClass = 'tie';
        let outcomeText = 'Tie';
        
        if (resultData.type === 'winner') {
            if (wasTiebreaker && wasInTiebreaker) {
                // Tiebreaker resolution: winner gets +2, runner-up gets +1
                outcomeClass = isWinner ? 'winner' : 'winner';
                outcomeText = isWinner ? 'Winner +2' : 'Runner-up +1';
            } else {
                outcomeClass = isWinner ? 'winner' : 'loser';
                outcomeText = isWinner ? 'Winner +1' : 'Lost';
            }
        } else if (resultData.type === 'impasse') {
            outcomeClass = 'tie';
            outcomeText = 'Impasse';
        }
        
        resultItem.innerHTML = `
            <div>
                <strong>${player.name}${playerId === currentPlayer ? ' (You)' : ''}</strong>
                <span class="result-choice">${getChoiceIcon(choice)}</span>
            </div>
            <span class="result-outcome ${outcomeClass}">${outcomeText}</span>
        `;
        resultsDiv.appendChild(resultItem);
    });

    // Auto-progress after a short delay
    setTimeout(async () => {
        if (!currentRoom || !gameState) return;
        try {
            await advanceRoundTransaction(currentRoom);
        } catch (e) {
            console.error('Auto-progress failed:', e);
        }
    }, 5000);
}

async function resolveTiebreaker() {
    // For tiebreaker, we need another round with only tied players
    // The implementation continues the game normally but applies special scoring
    try {
        await update(ref(database, `rooms/${currentRoom}`), {
            round: gameState.round + 1,
            results: null,
            tiebreakerActive: true,
            lastActivity: serverTimestamp()
        });
        // Update local state and refresh UI
        // Note: actual gameState will be refreshed via listener; this ensures immediate UI feedback
        if (gameState) {
            gameState.round += 1;
            gameState.results = null;
            gameState.tiebreakerActive = true;
            Object.keys(gameState.players || {}).forEach(id => {
                if (gameState.players[id]) {
                    gameState.players[id].ready = false;
                    gameState.players[id].choice = null;
                }
            });
        }
        showGameScreen();
    } catch (error) {
        console.error('Error resolving tiebreaker:', error);
        showError('Failed to start tiebreaker');
    }
}

async function nextRound() {
    try {
        await update(ref(database, `rooms/${currentRoom}`), {
            round: gameState.round + 1,
            results: null,
            tiebreaker: null,
            lastActivity: serverTimestamp()
        });
        
        showGameScreen();
    } catch (error) {
        console.error('Error starting next round:', error);
        showError('Failed to start next round');
    }
}

function showWinner(playerId, player) {
    // Hide any waiting/choice/results UI, show final results
    const waitingEl = document.getElementById('waitingForPlayers');
    if (waitingEl) waitingEl.style.display = 'none';
    const choiceEl = document.getElementById('choiceSection');
    if (choiceEl) choiceEl.style.display = 'none';
    const scoresEl = document.getElementById('scoresDisplay');
    if (scoresEl) scoresEl.style.display = 'none';
    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('winnerSection').style.display = 'block';
    
    document.getElementById('winnerName').textContent = `${player.name} Wins!`;

    // Game is finished: expire saved local session so refresh won't auto-rejoin
    try { clearSession(); } catch (_) {}
    
    const finalScoresDiv = document.getElementById('finalScores');
    finalScoresDiv.innerHTML = '';
    
    // Sort players by score
    const sortedPlayers = Object.entries(gameState.players)
        .sort(([, a], [, b]) => b.score - a.score);
    
    sortedPlayers.forEach(([id, p]) => {
        const scoreItem = document.createElement('div');
        scoreItem.className = 'final-score-item';
        scoreItem.innerHTML = `
            <span>${p.name}${id === currentPlayer ? ' (You)' : ''}</span>
            <span class="final-score-value">${p.score}</span>
        `;
        finalScoresDiv.appendChild(scoreItem);
    });
    
    // Schedule room cleanup after 5 minutes to give players time to see results
    scheduleRoomCleanup();
}

async function scheduleRoomCleanup() {
    // Wait 5 minutes before cleaning up the room
    if (cleanupTimeoutId) clearTimeout(cleanupTimeoutId);
    cleanupTimeoutId = setTimeout(async () => {
        if (currentRoom) {
            try {
                await cleanupRoom(currentRoom);
                console.log(`Room ${currentRoom} cleaned up after game ended`);
            } catch (error) {
                console.error('Error cleaning up room:', error);
            }
        }
    }, 5 * 60 * 1000); // 5 minutes
}

async function cleanupRoom(roomId) {
    try {
        // Remove the entire room from the database
        await remove(ref(database, `rooms/${roomId}`));
    } catch (error) {
        console.error('Error removing room:', error);
        throw error;
    }
}

// Play again / back to menu
document.getElementById('playAgainBtn').addEventListener('click', async () => {
    if (!currentRoom) return;
    
    try {
        // Cancel any pending cleanup
        if (cleanupTimeoutId) {
            clearTimeout(cleanupTimeoutId);
            cleanupTimeoutId = null;
        }

        // Reset game state in-place and restart
        const updates = {
            round: 1,
            results: null,
            tiebreaker: null,
            tiebreakerActive: false,
            status: 'playing',
            winner: null,
            lastActivity: serverTimestamp()
        };

        Object.keys(gameState.players).forEach(playerId => {
            updates[`players/${playerId}/score`] = 0;
            updates[`players/${playerId}/ready`] = false;
            updates[`players/${playerId}/choice`] = null;
        });

        await update(ref(database, `rooms/${currentRoom}`), updates);
        showGameScreen();
    } catch (error) {
        console.error('Error restarting game:', error);
        showError('Failed to restart game');
    }
});

document.getElementById('backToMenuBtn').addEventListener('click', () => {
    backToMenu();
});

// Home button: keep joined but return to setup; block auto-nav until user acts
const homeBtn = document.getElementById('homeBtn');
if (homeBtn) {
    homeBtn.addEventListener('click', () => {
        suppressAutoNav = true;
        showScreen('setup');
    });
}

async function backToMenu() {
    if (roomListener) {
        roomListener();
        roomListener = null;
    }
    
    if (currentRoom) {
        try {
            // If you're the last player in the room, delete the entire room; otherwise remove just you
            const playersCount = gameState ? Object.keys(gameState.players || {}).length : 0;
            if (playersCount <= 1) {
                await cleanupRoom(currentRoom);
            } else {
                await remove(ref(database, `rooms/${currentRoom}/players/${currentPlayer}`));
            }
        } catch (error) {
            console.error('Error cleaning up on exit:', error);
        }
    }
    
    currentRoom = null;
    currentPlayer = null;
    gameState = null;
    stopRoomHeartbeat();
    clearSession();
    
    showScreen('setup');
}

// Event listeners for navigation
document.getElementById('createRoomBtn').addEventListener('click', () => {
    suppressAutoNav = false;
    showScreen('createRoom');
});

document.getElementById('joinRoomBtn').addEventListener('click', () => {
    suppressAutoNav = false;
    showScreen('joinRoom');
    joinCodeBuffer = [];
    renderJoinCode();
});

document.getElementById('createBtn').addEventListener('click', createRoom);
document.getElementById('joinBtn').addEventListener('click', joinRoom);

document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        suppressAutoNav = false;
        showScreen('setup');
    });
});

// Player count button toggle handlers
document.querySelectorAll('.player-count-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.player-count-btn').forEach(b => {
            b.classList.remove('active');
            b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-pressed', 'true');
    });
});

// Listen for room updates during game
function setupRoomListener() {
    if (!currentRoom) return;
    
    roomListener = onValue(ref(database, `rooms/${currentRoom}`), (snapshot) => {
        if (!snapshot.exists()) {
            showError('Room no longer exists');
            backToMenu();
            return;
        }
        
        gameState = snapshot.val();
        
        // If game finished, show winner for all players
        if (gameState.status === 'finished' && gameState.winner) {
            const winnerId = gameState.winner.id;
            const winnerPlayer = gameState.players[winnerId];
            if (winnerPlayer) {
                showWinner(winnerId, winnerPlayer);
                return;
            }
        }

        // Update display if in game
        if (screens.game.classList.contains('active')) {
            updateGameDisplay();

            // Keep choice/wait UI aligned to tiebreaker status
            const isTbActive = !!(gameState && gameState.tiebreakerActive && Array.isArray(gameState.tiebreaker));
            const tbPlayers = isTbActive ? gameState.tiebreaker : [];
            const you = gameState.players && currentPlayer ? gameState.players[currentPlayer] : null;
            const youInTb = isTbActive ? tbPlayers.includes(currentPlayer) : true;
            const choiceSection = document.getElementById('choiceSection');
            const waiting = document.getElementById('waitingForPlayers');
            const waitingMsg = waiting ? waiting.querySelector('p') : null;
            if (isTbActive && !youInTb) {
                if (choiceSection) choiceSection.style.display = 'none';
                if (waiting) waiting.style.display = 'block';
                if (waitingMsg) waitingMsg.textContent = 'Please wait while the tiebreaker is resolved…';
            } else if (you && you.ready) {
                if (choiceSection) choiceSection.style.display = 'none';
                if (waiting) waiting.style.display = 'block';
                if (waitingMsg) waitingMsg.textContent = 'Waiting…';
            } else {
                if (choiceSection) choiceSection.style.display = 'block';
                if (waiting) waiting.style.display = 'none';
            }

            // Check if results are ready
            if (gameState.results && document.getElementById('resultsSection').style.display === 'none') {
                displayRoundResults(gameState.results);
            }
        }
    });
}

// Initialize app
(async function init() {
    const initialized = await initializeFirebase();
    if (!initialized) {
        console.warn('Firebase not initialized. Please configure firebase-config.js');
    }
    // Start periodic cleanup sweeper to remove idle rooms
    startCleanupSweeper();
    // Auto-minimize the connection badge after a short delay on mobile to free space
    const conn = document.getElementById('connectionStatus');
    if (conn) {
        setTimeout(() => {
            conn.classList.add('minimized');
        }, 2500);
        // Reveal on hover or tap
        conn.addEventListener('mouseenter', () => conn.classList.remove('minimized'));
        conn.addEventListener('mouseleave', () => conn.classList.add('minimized'));
        conn.addEventListener('click', () => conn.classList.toggle('minimized'));
    }

    // Register service worker (PWA)
    try {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js').catch(() => {});
        }
    } catch (_) {}

    // Deep link: ?room=RRRR or emojis; or auto-rejoin saved session
    try {
        const url = new URL(window.location.href);
        const roomParam = url.searchParams.get('room');
        let handledDeepLink = false;
        if (roomParam) {
            const code = /^[RPS]{1,4}$/i.test(roomParam)
                ? roomParam.toUpperCase()
                : emojiToRpsCode(roomParam);
            if (code && code.length === ROOM_CODE_LEN) {
                showScreen('joinRoom');
                setJoinCodeFromString(code);
                const hint = document.getElementById('codeHint');
                if (hint) hint.style.display = 'none';
                handledDeepLink = true;
            }
        }
        if (!handledDeepLink) {
            const saved = getSavedSession();
            if (saved && saved.roomId && saved.playerId) {
                try {
                    const snap = await get(ref(database, `rooms/${saved.roomId}`));
                    if (snap.exists()) {
                        const room = snap.val();
                        if (room.players && room.players[saved.playerId]) {
                            currentRoom = saved.roomId;
                            currentPlayer = saved.playerId;
                            joinWaitingRoom(currentRoom, currentPlayer);
                            startRoomHeartbeat(currentRoom);
                        }
                    }
                } catch (_) {}
            }
        }
    } catch (_) {}
    // Deep link: ?room=RRRR or emojis; or auto-rejoin saved session
    try {
        const url = new URL(window.location.href);
        const roomParam = url.searchParams.get('room');
        let handled = false;
        if (roomParam) {
            const code = /^[RPS]{1,4}$/i.test(roomParam)
                ? roomParam.toUpperCase()
                : emojiToRpsCode(roomParam);
            if (code && code.length === ROOM_CODE_LEN) {
                showScreen('joinRoom');
                setJoinCodeFromString(code);
                const hint = document.getElementById('codeHint');
                if (hint) hint.style.display = 'none';
                handled = true;
            }
        }
        if (!handled) {
            const saved = getSavedSession();
            if (saved && saved.roomId && saved.playerId) {
                try {
                    const snap = await get(ref(database, `rooms/${saved.roomId}`));
                    if (snap.exists()) {
                        const room = snap.val();
                        if (room.players && room.players[saved.playerId]) {
                            currentRoom = saved.roomId;
                            currentPlayer = saved.playerId;
                            joinWaitingRoom(currentRoom, currentPlayer);
                            startRoomHeartbeat(currentRoom);
                        } else {
                            // Player missing from room; clear stale session
                            clearSession();
                        }
                    } else {
                        // Room missing; clear stale session
                        clearSession();
                    }
                } catch (e) {
                    console.debug('Auto-rejoin skipped:', e?.message || e);
                    // On any error, clear to avoid retry loops
                    try { clearSession(); } catch (_) {}
                }
            }
        }
    } catch (_) {}
})();

// Connection status helpers
function setConnectionStatus(state, text) {
    const el = document.getElementById('connectionStatus');
    if (!el) return;
    el.classList.remove('conn-status--online', 'conn-status--offline', 'conn-status--connecting');
    const map = {
        online: 'conn-status--online',
        offline: 'conn-status--offline',
        connecting: 'conn-status--connecting'
    };
    el.classList.add(map[state] || 'conn-status--connecting');
    const textEl = el.querySelector('.conn-text');
    if (textEl) textEl.textContent = text;

    // Compact/icon-only behavior
    const isMobile = window.matchMedia && window.matchMedia('(max-width: 600px)').matches;
    if (isMobile) {
        // On mobile, always icon-only
        el.classList.add('compact');
    } else {
        if (state === 'online') {
            // briefly show text, then switch to compact dot-only
            el.classList.remove('compact');
            setTimeout(() => {
                if (el.classList.contains('conn-status--online')) {
                    el.classList.add('compact');
                }
            }, 2500);
        } else if (state === 'offline') {
            el.classList.add('compact');
        } else {
            el.classList.remove('compact');
        }
    }
}

// Prevent double-tap zoom on quick repeated button taps (for iOS Safari)
let __lastTouchEndTs = 0;
document.addEventListener('touchend', (e) => {
    const target = e.target && e.target.closest && e.target.closest('button, .choice-btn, .code-choice-btn');
    if (!target) return;
    const now = Date.now();
    if (now - __lastTouchEndTs < 400) {
        // Prevent zoom
        e.preventDefault();
    }
    __lastTouchEndTs = now;
}, { passive: false });

// Advance round atomically so only one client progresses the game
async function advanceRoundTransaction(roomId) {
    const roomRef = ref(database, `rooms/${roomId}`);
    await runTransaction(roomRef, (room) => {
        if (!room) return room;
        // If results already cleared or game not playing, do nothing
        if (room.status !== 'playing' || !room.results) return room;

        // Determine if someone already won
        const players = room.players || {};
        const winnerEntry = Object.entries(players).find(([, p]) => (p && typeof p.score === 'number') && p.score >= room.pointsToWin);
        if (winnerEntry) {
            const [winnerId] = winnerEntry;
            room.status = 'finished';
            room.winner = { id: winnerId };
            room.results = null;
            room.lastActivity = Date.now();
            return room;
        }

        // Start next round; if tiebreaker queued, mark active
        room.round = (room.round || 1) + 1;
        room.results = null;
        if (room.tiebreaker) {
            room.tiebreakerActive = true;
        } else {
            room.tiebreaker = null;
            room.tiebreakerActive = false;
        }
        room.lastActivity = Date.now();
        return room;
    });
}

// --- Idle cleanup & heartbeat ---
function startRoomHeartbeat(roomId) {
    stopRoomHeartbeat();
    if (!database || !roomId) return;
    // immediate bump
    update(ref(database, `rooms/${roomId}`), { lastActivity: serverTimestamp() }).catch(() => {});
    heartbeatInterval = setInterval(() => {
        update(ref(database, `rooms/${roomId}`), { lastActivity: serverTimestamp() }).catch(() => {});
    }, 120000); // every 2 minutes
}

function stopRoomHeartbeat() {
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
}

function startCleanupSweeper() {
    // Run immediately and then every minute
    cleanExpiredRooms();
    setInterval(cleanExpiredRooms, 60000);
}

async function cleanExpiredRooms() {
    try {
        if (!database) return;
        const tenMinutes = 10 * 60 * 1000;
        const cutoff = Date.now() - tenMinutes;
        const roomsRef = ref(database, 'rooms');
    const q = query(roomsRef, orderByChild('lastActivity'), endAt(cutoff), limitToFirst(200));
        const snap = await get(q);
        if (!snap.exists()) {
            // No expired rooms found
            return;
        }
        const rooms = snap.val();
        const roomIds = Object.keys(rooms || {});
        if (roomIds.length > 0) {
            console.debug(`[sweeper] Removing ${roomIds.length} expired room(s) with lastActivity <= ${cutoff}`);
        }
        const results = await Promise.allSettled(roomIds.map(roomId => remove(ref(database, `rooms/${roomId}`))));
        results.forEach((res, i) => {
            const roomId = roomIds[i];
            if (res.status === 'rejected') {
                console.warn(`[sweeper] Failed to remove room ${roomId}:`, res.reason && res.reason.message ? res.reason.message : res.reason);
            } else {
                console.debug(`[sweeper] Removed room ${roomId}`);
            }
        });
    } catch (e) {
        console.warn('Cleanup sweep error:', e);
    }
}

// Expose a minimal debug helper in the console to trigger a sweep on demand
// Usage in dev tools: rpsp.forceSweep()
if (typeof window !== 'undefined') {
    window.rpsp = Object.assign({}, window.rpsp || {}, { forceSweep: cleanExpiredRooms });
}

// Share invite button handler
const shareBtn = document.getElementById('shareInviteBtn');
if (shareBtn) {
    shareBtn.addEventListener('click', async () => {
        try {
            const disp = document.getElementById('displayRoomId');
            const datasetCode = disp && disp.dataset ? disp.dataset.code : '';
            let code = datasetCode;
            if (!code) {
                // Fallback to parsing text (handles older sessions), normalize variation selectors
                const codeEmoji = (disp?.textContent || '').replace(/\uFE0F/g, '').trim();
                code = emojiToRpsCode(codeEmoji);
            }
            if (!code || code.length !== ROOM_CODE_LEN) {
                showError('No room code to share yet.');
                return;
            }
            const url = new URL(window.location.href);
            // Ensure root app URL (strip any query/hash)
            url.search = '';
            url.hash = '';
            url.searchParams.set('room', code);
            const link = url.toString();
            if (navigator.share && typeof navigator.share === 'function') {
                // Pass only the URL (some share targets duplicate content if both text and url provided)
                await navigator.share({ title: 'Rock Paper Scissors Plus', url: link });
            } else if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(link);
                showError('Invite link copied to clipboard!');
            } else {
                prompt('Copy this invite link:', link);
            }
        } catch (e) {
            console.error('Share failed:', e);
            showError('Failed to share invite');
        }
    });
}
