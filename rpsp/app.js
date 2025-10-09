import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-app.js';
import { getDatabase, ref, set, onValue, update, remove, push, get, child } from 'https://www.gstatic.com/firebasejs/10.12.4/firebase-database.js';

// Initialize Firebase
let app, database;

// Emoji templates for choices
const EMOJI_TEMPLATES = {
    rock: '✊',
    paper: '🖐️',
    scissors: '✌️'
};

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

// Game state
let currentRoom = null;
let currentPlayer = null;
let gameState = null;
let roomListener = null;

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
    // Generate a 4-symbol code using R, P, S
    const symbols = ['R', 'P', 'S'];
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += symbols[Math.floor(Math.random() * symbols.length)];
    }
    return code;
}

function rpsCodeToEmoji(code) {
    const map = { R: '✊', P: '🖐️', S: '✌️' };
    return code.split('').map(c => map[c] || '').join('');
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
    const blanks = '_'.repeat(Math.max(0, 4 - joinCodeBuffer.length));
    disp.textContent = filled + blanks;
    const joinBtn = document.getElementById('joinBtn');
    if (joinBtn) joinBtn.disabled = joinCodeBuffer.length !== 4;
}

function getEnteredRpsCode() {
    return joinCodeBuffer.join('');
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
    if (!database) {
        const ok = await initializeFirebase();
        if (!ok) return;
    }
    const name = document.getElementById('hostName').value.trim();
    const playerCount = parseInt(document.getElementById('playerCount').value);
    const pointsToWin = parseInt(document.getElementById('pointsToWin').value);
    
    if (!name) {
        showError('Please enter your name');
        return;
    }
    
    if (pointsToWin < 1 || pointsToWin > 20) {
        showError('Points to win must be between 1 and 20');
        return;
    }
    
    const roomId = generateRoomId();
    const playerId = Date.now().toString();
    
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
        createdAt: Date.now()
    };
    
    try {
        await set(ref(database, `rooms/${roomId}`), roomData);
        currentRoom = roomId;
        currentPlayer = playerId;
        joinWaitingRoom(roomId, playerId);
    } catch (error) {
        console.error('Error creating room:', error);
        showError('Failed to create room: ' + error.message);
    }
}

async function joinRoom() {
    if (!database) {
        const ok = await initializeFirebase();
        if (!ok) return;
    }
    const roomId = getEnteredRpsCode();
    const name = document.getElementById('playerName').value.trim();
    
    if (!roomId || roomId.length !== 4 || !name) {
        showError('Please enter a 4-symbol room code and your name');
        return;
    }
    
    try {
        const roomSnapshot = await get(child(ref(database), `rooms/${roomId}`));
        
        if (!roomSnapshot.exists()) {
            showError('Room not found');
            return;
        }
        
        const roomData = roomSnapshot.val();
        const playerCount = Object.keys(roomData.players).length;
        
        if (playerCount >= roomData.maxPlayers) {
            showError('Room is full');
            return;
        }
        
        if (roomData.status !== 'waiting') {
            showError('Game already in progress');
            return;
        }
        
        const playerId = Date.now().toString();
        await update(ref(database, `rooms/${roomId}/players/${playerId}`), {
            name: name,
            score: 0,
            ready: false,
            choice: null
        });
        
        currentRoom = roomId;
        currentPlayer = playerId;
        joinWaitingRoom(roomId, playerId);
    } catch (error) {
        console.error('Error joining room:', error);
        showError('Failed to join room: ' + error.message);
    }
}

function joinWaitingRoom(roomId, playerId) {
    showScreen('waitingRoom');
    document.getElementById('displayRoomId').textContent = rpsCodeToEmoji(roomId);
    
    // Listen for room updates
    roomListener = onValue(ref(database, `rooms/${roomId}`), (snapshot) => {
        if (!snapshot.exists()) {
            showError('Room no longer exists');
            backToMenu();
            return;
        }
        
        const room = snapshot.val();
        gameState = room;
        
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
        }
    });
}

async function startGame(roomId) {
    try {
        await update(ref(database, `rooms/${roomId}`), {
            status: 'playing'
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
    
    document.querySelectorAll('.choice-btn').forEach(btn => {
        btn.classList.remove('selected');
    });
    document.getElementById('yourChoice').textContent = '';
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
        if (joinCodeBuffer.length >= 4) return;
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
    
    const allReady = Object.values(gameState.players).every(p => p.ready);
    
    if (allReady) {
        // Calculate results
        const choices = {};
        Object.entries(gameState.players).forEach(([id, player]) => {
            choices[id] = player.choice;
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
            if (playerCount === 2) {
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
            // If there's a winner, mark game finished for everyone and show winner screen
            const winnerEntry = Object.entries(gameState.players).find(([id, player]) => player.score >= gameState.pointsToWin);
            if (winnerEntry) {
                const [winnerId] = winnerEntry;
                await update(ref(database, `rooms/${currentRoom}`), {
                    status: 'finished',
                    winner: { id: winnerId }
                });
                const winnerPlayer = gameState.players[winnerId];
                showWinner(winnerId, winnerPlayer);
                return;
            }

            // If there's a tiebreaker pending, start it
            if (gameState.tiebreaker) {
                await resolveTiebreaker();
            } else {
                await nextRound();
            }
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
            tiebreakerActive: true
        });
        
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
            tiebreaker: null
        });
        
        showGameScreen();
    } catch (error) {
        console.error('Error starting next round:', error);
        showError('Failed to start next round');
    }
}

function showWinner(playerId, player) {
    document.getElementById('resultsSection').style.display = 'none';
    document.getElementById('winnerSection').style.display = 'block';
    
    document.getElementById('winnerName').textContent = `${player.name} Wins!`;
    
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
    setTimeout(async () => {
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
        // Reset game state
        const updates = {};
        updates['round'] = 1;
        updates['results'] = null;
        updates['tiebreaker'] = null;
        
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

async function backToMenu() {
    if (roomListener) {
        roomListener();
        roomListener = null;
    }
    
    if (currentRoom) {
        try {
            // Check if game has ended (someone won)
            const hasWinner = gameState && Object.values(gameState.players).some(p => p.score >= gameState.pointsToWin);
            
            if (hasWinner) {
                // If game ended, check if this is the last player leaving
                const remainingPlayers = Object.keys(gameState.players).filter(id => id !== currentPlayer);
                
                if (remainingPlayers.length === 0) {
                    // Last player leaving, clean up the entire room
                    await cleanupRoom(currentRoom);
                } else {
                    // Remove only this player
                    await remove(ref(database, `rooms/${currentRoom}/players/${currentPlayer}`));
                }
            } else {
                // Game still in progress, just remove player
                await remove(ref(database, `rooms/${currentRoom}/players/${currentPlayer}`));
            }
        } catch (error) {
            console.error('Error cleaning up on exit:', error);
        }
    }
    
    currentRoom = null;
    currentPlayer = null;
    gameState = null;
    
    showScreen('setup');
}

// Event listeners for navigation
document.getElementById('createRoomBtn').addEventListener('click', () => {
    showScreen('createRoom');
});

document.getElementById('joinRoomBtn').addEventListener('click', () => {
    showScreen('joinRoom');
    joinCodeBuffer = [];
    renderJoinCode();
});

document.getElementById('createBtn').addEventListener('click', createRoom);
document.getElementById('joinBtn').addEventListener('click', joinRoom);

document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        showScreen('setup');
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
}
