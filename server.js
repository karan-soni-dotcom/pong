const WebSocket = require('ws');
const express = require('express');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(__dirname));

// Game state
let gameRooms = new Map();
let waitingPlayers = [];

class GameRoom {
    constructor(id) {
        this.id = id;
        this.players = [];
        this.gameState = {
            ball: { x: 400, y: 200, dx: 5, dy: 3, radius: 10 },
            paddles: {
                left: { x: 20, y: 150, width: 10, height: 100 },
                right: { x: 770, y: 150, width: 10, height: 100 }
            },
            score: { left: 0, right: 0 },
            gameRunning: false
        };
        this.gameLoop = null;
    }
    
    addPlayer(player) {
        if (this.players.length < 2) {
            this.players.push(player);
            player.room = this;
            player.side = this.players.length === 1 ? 'left' : 'right';
            player.isHost = this.players.length === 1;
            
            // Notify player of assignment
            player.send(JSON.stringify({
                type: 'playerAssigned',
                playerId: player.id,
                side: player.side,
                isHost: player.isHost
            }));
            
            // Start game if room is full
            if (this.players.length === 2) {
                this.startGame();
            }
            
            return true;
        }
        return false;
    }
    
    removePlayer(player) {
        this.players = this.players.filter(p => p !== player);
        if (this.gameLoop) {
            clearInterval(this.gameLoop);
            this.gameLoop = null;
        }
        
        // Notify remaining player
        if (this.players.length === 1) {
            this.players[0].send(JSON.stringify({
                type: 'playerLeft',
                message: 'Opponent disconnected'
            }));
        }
    }
    
    startGame() {
        this.gameState.gameRunning = true;
        
        // Notify all players
        this.broadcast({
            type: 'gameStart',
            gameState: this.gameState
        });
        
        // Start game loop (60 FPS)
        this.gameLoop = setInterval(() => {
            this.updateGame();
        }, 16);
    }
    
    updateGame() {
        this.updateBall();
        this.checkCollisions();
        
        // Broadcast game state
        this.broadcast({
            type: 'gameState',
            gameState: this.gameState
        });
    }
    
    updateBall() {
        const ball = this.gameState.ball;
        ball.x += ball.dx;
        ball.y += ball.dy;
        
        // Top/bottom collision
        if (ball.y <= ball.radius || ball.y >= 400 - ball.radius) {
            ball.dy = -ball.dy;
        }
        
        // Score detection
        if (ball.x < 0) {
            this.gameState.score.right++;
            this.resetBall();
        } else if (ball.x > 800) {
            this.gameState.score.left++;
            this.resetBall();
        }
    }
    
    checkCollisions() {
        const ball = this.gameState.ball;
        const leftPaddle = this.gameState.paddles.left;
        const rightPaddle = this.gameState.paddles.right;
        
        // Left paddle collision
        if (ball.x - ball.radius <= leftPaddle.x + leftPaddle.width &&
            ball.y >= leftPaddle.y &&
            ball.y <= leftPaddle.y + leftPaddle.height &&
            ball.dx < 0) {
            ball.dx = -ball.dx;
            ball.x = leftPaddle.x + leftPaddle.width + ball.radius;
        }
        
        // Right paddle collision
        if (ball.x + ball.radius >= rightPaddle.x &&
            ball.y >= rightPaddle.y &&
            ball.y <= rightPaddle.y + rightPaddle.height &&
            ball.dx > 0) {
            ball.dx = -ball.dx;
            ball.x = rightPaddle.x - ball.radius;
        }
    }
    
    resetBall() {
        const ball = this.gameState.ball;
        ball.x = 400;
        ball.y = 200;
        ball.dx = (Math.random() > 0.5 ? 1 : -1) * 5;
        ball.dy = (Math.random() - 0.5) * 6;
    }
    
    handlePaddleMove(player, y) {
        if (player.side && this.gameState.paddles[player.side]) {
            this.gameState.paddles[player.side].y = Math.max(0, Math.min(y, 300));
            
            // Broadcast paddle movement to other players
            this.broadcast({
                type: 'paddleMove',
                side: player.side,
                y: this.gameState.paddles[player.side].y
            }, player);
        }
    }
    
    broadcast(message, excludePlayer = null) {
        this.players.forEach(player => {
            if (player !== excludePlayer && player.readyState === WebSocket.OPEN) {
                player.send(JSON.stringify(message));
            }
        });
    }
}

// WebSocket connection handling
wss.on('connection', (ws) => {
    ws.id = Math.random().toString(36).substr(2, 9);
    console.log(`Player ${ws.id} connected`);
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            handleMessage(ws, message);
        } catch (error) {
            console.error('Invalid message format:', error);
        }
    });
    
    ws.on('close', () => {
        console.log(`Player ${ws.id} disconnected`);
        if (ws.room) {
            ws.room.removePlayer(ws);
        }
        // Remove from waiting list
        waitingPlayers = waitingPlayers.filter(p => p !== ws);
    });
});

function handleMessage(ws, message) {
    switch (message.type) {
        case 'join':
            joinGame(ws);
            break;
        case 'paddleMove':
            if (ws.room) {
                ws.room.handlePaddleMove(ws, message.y);
            }
            break;
    }
}

function joinGame(player) {
    // Try to find an existing room with space
    for (let room of gameRooms.values()) {
        if (room.addPlayer(player)) {
            console.log(`Player ${player.id} joined room ${room.id}`);
            return;
        }
    }
    
    // Create new room
    const roomId = Math.random().toString(36).substr(2, 9);
    const room = new GameRoom(roomId);
    gameRooms.set(roomId, room);
    room.addPlayer(player);
    console.log(`Player ${player.id} created room ${roomId}`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} to play`);
});