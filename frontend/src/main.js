import Phaser from 'phaser';
import MenuScene from './scenes/MenuScene.js';
import GameScene from './scenes/GameScene.js';
import LobbyScene from './scenes/LobbyScene.js';
import SpectatorScene from './scenes/SpectatorScene.js';

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0a0a0a',
  pixelArt: true,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  // Menu boots first; "Start Game" → Game (single-player), "Agent Arena" →
  // Lobby → Spectator (watch the bots).
  scene: [MenuScene, GameScene, LobbyScene, SpectatorScene],
};

new Phaser.Game(config);
