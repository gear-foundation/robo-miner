import Phaser from 'phaser';
import LandingScene from './scenes/LandingScene.js';
import MenuScene from './scenes/MenuScene.js';
import GameScene from './scenes/GameScene.js';
import LobbyScene from './scenes/LobbyScene.js';
import LeaderboardScene from './scenes/LeaderboardScene.js';
import RedeemScene from './scenes/RedeemScene.js';
import SocialFuelScene from './scenes/SocialFuelScene.js';
import SpectatorScene from './scenes/SpectatorScene.js';
import { initialRoute, installHistoryRouter, normalizeInitialRoute } from './router.js';

normalizeInitialRoute();

class BootScene extends Phaser.Scene {
  constructor() { super('Boot'); }

  create() {
    const route = initialRoute();
    this.scene.start(route.scene, route.data);
  }
}

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0a0a0a',
  pixelArt: true,
  audio: {
    disableWebAudio: true,
  },
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  scene: [
    BootScene,
    LandingScene,
    MenuScene,
    GameScene,
    LobbyScene,
    LeaderboardScene,
    RedeemScene,
    SocialFuelScene,
    SpectatorScene,
  ],
};

const game = new Phaser.Game(config);
installHistoryRouter(game);
