import Phaser from 'phaser';
import MenuScene from './scenes/MenuScene.js';
import GameScene from './scenes/GameScene.js';
import LobbyScene from './scenes/LobbyScene.js';
import SpectatorScene from './scenes/SpectatorScene.js';
import { parseRoute } from './routing.js';

class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }
  create() {
    const route = parseRoute();
    this.scene.start(route.scene, route.data);
  }
}

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
  // Boot reads the real browser URL first, then starts Menu / Game / Lobby /
  // Spectator. That keeps /world/<programId> reloadable instead of falling
  // back to the menu after F5.
  scene: [BootScene, MenuScene, GameScene, LobbyScene, SpectatorScene],
};

const game = new Phaser.Game(config);

window.addEventListener('popstate', () => {
  const route = parseRoute();
  game.scene.stop('Menu');
  game.scene.stop('Game');
  game.scene.stop('Lobby');
  game.scene.stop('Spectator');
  game.scene.start(route.scene, route.data);
});
