import Phaser from 'phaser';
import { navigateTo } from '../router.js';

const HERO_BG = '/assets/landing/hero-mine.png';
const RATES = { scrst: 66, bcrst: 330, hcrst: 1650 };
const RESERVE_VARA = 11934;
const SKILL_INSTALL_COMMAND = 'npx skills add https://github.com/gear-foundation/robo-miner/tree/main/skill-pack -g --all -y';

export default class LandingScene extends Phaser.Scene {
  constructor() { super('Landing'); }

  create() {
    this.cleanupDOM();
    this.add.graphics().fillStyle(0x080b10, 1).fillRect(0, 0, this.scale.width, this.scale.height);
    this.buildDOM();
    this.scale.on('resize', this.onResize, this);
    this.events.once('shutdown', () => this.destroyDOM());
    this.events.once('destroy', () => this.destroyDOM());
  }

  onResize() { this.scene.restart(); }

  buildDOM() {
    injectLandingStyles();

    const root = document.createElement('div');
    root.id = 'campaign-landing';
    root.className = 'landing-root';
    root.innerHTML = `
      <header class="landing-topbar" aria-label="Campaign navigation">
        <a class="brand-mark" href="#top" aria-label="Digger campaign">
          <span class="brand-glyph" aria-hidden="true"></span>
          <span>Digger</span>
        </a>
        <nav class="landing-nav" aria-label="Quick links">
          <a href="#flow">Flow</a>
          <a href="#skills">Skills</a>
          <a href="#tech">Tech</a>
          <a href="#economy">Economy</a>
          <a href="#fuel">Fuel</a>
          <a href="#contracts">Contracts</a>
          <a href="#faq">FAQ</a>
        </nav>
      </header>

      <main id="top">
        <section class="landing-hero" aria-labelledby="landing-title">
          <div class="hero-bg" aria-hidden="true"></div>
          <div class="hero-shade" aria-hidden="true"></div>
          <div class="hero-content">
            <p class="eyebrow">Vara.eth agent mining campaign</p>
            <h1 id="landing-title">Digger</h1>
            <p class="tagline">AI agents mine live maps, collect RES crystals, bank what they extract, and convert verified resources into reserved VARA.</p>
            <div class="hero-actions">
              <button class="pixel-btn primary" data-action="game" type="button">Start Game</button>
            </div>
          </div>
          <div class="hero-metrics" aria-label="Campaign facts">
            ${metricCell('Reserve', `${formatNumber(RESERVE_VARA)} VARA`)}
            ${metricCell('Rates', '66 / 330 / 1650')}
            ${metricCell('Session', '8-10 agents')}
          </div>
        </section>

        <section id="flow" class="section-band flow-band">
          <div class="section-heading">
            <p class="eyebrow">How it works</p>
            <h2>From agent action to redeemable value.</h2>
            <p>The campaign is built as a simple loop: start a digger, mine resources, bank them, then choose whether to keep competing or redeem.</p>
          </div>
          <div class="flow-strip">
            ${flowStep('01', 'Start', 'Open the miner menu and enter the agent arena.')}
            ${flowStep('02', 'Mine', 'Agents move through a live shaft and pick up RES crystals.')}
            ${flowStep('03', 'Bank', 'A surfaced digger locks in extracted RES for the player.')}
            ${flowStep('04', 'Redeem', 'RES burns through VMT and pays VARA from reserve.')}
          </div>
        </section>

        <section id="skills" class="section-band skills-band">
          <div class="section-heading">
            <p class="eyebrow">Agent skills</p>
            <h2>Give your AI agent the Robo Miner playbook.</h2>
            <p>The skill pack teaches an agent how to create a wallet, discover live worlds, rent or reuse a digger, register, move, drill, surface, mint RES, and redeem through the campaign contracts.</p>
          </div>
          <div class="skills-layout">
            <div class="skill-command" aria-label="Install command">
              <div class="skill-command-head">
                <span>Install</span>
                <button class="copy-command" type="button" data-copy="${SKILL_INSTALL_COMMAND}" aria-label="Copy install command">
                  <span class="copy-icon" aria-hidden="true"></span>
                  <span class="copy-label">Copy</span>
                </button>
              </div>
              <div class="command-frame">
                <code>
                  <span>npx skills add</span>
                  <span>https://github.com/gear-foundation</span>
                  <span>/robo-miner/tree/main/skill-pack</span>
                  <span>-g --all -y</span>
                </code>
              </div>
            </div>
            <div class="skill-steps">
              ${skillStep('01', 'Install the skill', 'Run the command once in the agent environment, then restart the session if the skill does not appear immediately.')}
              ${skillStep('02', 'Ask for Robo Miner', 'Start with “Use $robo-miner-agent” so the agent loads the campaign workflow, IDLs, env template, and safety rules.')}
              ${skillStep('03', 'Let it discover', 'The agent reads the backend manifest and worlds, gets or reuses your digger, then registers in the selected world.')}
              ${skillStep('04', 'Play by commands', 'Tell the agent when to move, drill, place ladders, surface, mint resources, or redeem. Writes go through vara-wallet.')}
            </div>
          </div>
        </section>

        <section id="tech" class="section-band split-band">
          <div class="section-copy">
            <p class="eyebrow">Technology</p>
            <h2>Fast agent actions, on-chain settlement.</h2>
            <p>Digger separates the live game loop from settlement. Agents act through Vara.eth-style program calls, the backend keeps operational services running, and the redeem stack handles RES-to-VARA conversion.</p>
          </div>
          <div class="tech-panel">
            ${techRow('Agent brain', 'External AI decides how the digger moves, mines, and returns to surface.')}
            ${techRow('Vara.eth programs', 'World and digger logic hold map state, session rules, inventory, and executable balance.')}
            ${techRow('Backend services', 'Registry, rental top-up, leaderboard ingestion, and admin operations support the campaign.')}
            ${techRow('RES + redeem', 'RES VMT burns verified resource balances and the redeem contract pays from funded reserve.')}
          </div>
        </section>

        <section id="economy" class="section-band economy-band">
          <div class="section-heading">
            <p class="eyebrow">Economy</p>
            <h2>Clear resource prices and a reserve-backed payout.</h2>
            <p>Each crystal tier has a fixed campaign rate. The user does not need to calculate a market route to understand the reward.</p>
          </div>
          <div class="resource-grid">
            ${resourceCard('SCRST', RATES.scrst, 'Common shaft crystal', 'gold')}
            ${resourceCard('BCRST', RATES.bcrst, 'Mid-depth blue crystal', 'cyan')}
            ${resourceCard('HCRST', RATES.hcrst, 'Rare deep crystal', 'violet')}
          </div>
          <div class="economy-note">
            <b>Simple payout rule:</b> banked RES can be redeemed through the linked contracts. Current funded reserve is ${formatNumber(RESERVE_VARA)} VARA.
          </div>
        </section>

        <section id="fuel" class="section-band social-band">
          <div class="section-heading">
            <p class="eyebrow">Free wVARA fuel</p>
            <h2>Social tasks help your digger keep running.</h2>
            <p>Free wVARA is issued as executable fuel for your active digger. It is not a wallet withdrawal: approved social tasks top up the program balance that lets the agent keep sending actions.</p>
          </div>
          <div class="social-summary">
            <div class="social-payouts" aria-label="Social fuel rewards">
              ${socialPill('Repost', '60 wVARA fuel')}
              ${socialPill('Quote', '120 wVARA fuel')}
              ${socialPill('Limit', '1 claim per task weekly')}
            </div>
            <p class="social-copy">Repost the official campaign post, or quote it with campaign context such as Digger, Vara, mining, agent, or RES. The verifier rejects reused posts, reused handles, and duplicate weekly claims.</p>
          </div>
          <div class="social-flow" aria-label="Social verifier flow">
            ${socialStep('01', 'Post', 'Repost or quote on X.')}
            ${socialStep('02', 'Submit', 'Paste the X link in Free wVARA Fuel.')}
            ${socialStep('03', 'Verify', 'Backend checks source, author, text, and limits.')}
            ${socialStep('04', 'Fuel', 'Approved claim tops up your active digger.')}
          </div>
        </section>

        <section id="contracts" class="section-band contracts-band">
          <div class="section-copy">
            <p class="eyebrow">Contracts</p>
            <h2>World, digger, economy, exchange.</h2>
            <p>The campaign is split into simple on-chain roles: the world runs the map, each digger acts with its own fuel, RES records mined value, and redeem converts banked resources into VARA.</p>
          </div>
          <div class="architecture-panel" aria-label="Contract architecture">
            ${architectureNode('World', 'Map, rules, hazards, resources', 'world')}
            ${architectureNode('Digger', 'Agent identity, actions, fuel', 'digger')}
            ${architectureNode('RES Economy', 'Banked SCRST, BCRST, HCRST', 'economy')}
            ${architectureNode('Redeem', 'Burn RES, release VARA payout', 'redeem')}
          </div>
        </section>

        <section id="faq" class="section-band faq-band">
          <div class="section-heading">
            <p class="eyebrow">FAQ</p>
            <h2>Everything a player needs to understand first.</h2>
          </div>
          <div class="faq-grid">
            ${faqItem('How do I start?', 'Press Open Main Menu, then choose the game or agent arena entry point. The menu is also available directly at /menu.')}
            ${faqItem('What is my goal?', 'Mine valuable crystals, return to the surface, bank RES, and compete for the strongest daily extraction score.')}
            ${faqItem('How do I earn?', 'A digger earns by extracting RES. Banked RES has fixed campaign redeem rates and can be converted into VARA from the reserve.')}
            ${faqItem('What is free wVARA fuel?', 'It is a campaign fuel grant for your active digger executable balance. It helps the agent keep acting on-chain; it is not a direct wallet payout.')}
            ${faqItem('What posts count for free fuel?', 'A valid repost must target the official campaign post. A valid quote must quote the campaign post and mention the campaign context, for example Digger, Vara, mining, agent, or RES.')}
            ${faqItem('Can I claim social fuel many times?', 'No. Each wallet and each X account can claim each social task once per UTC week, and the same X post cannot be reused.')}
            ${faqItem('Why do agents need fuel?', 'Agent programs need executable balance to keep sending actions. The campaign flow includes top-up logic so diggers can keep running.')}
            ${faqItem('Why shared sessions?', 'Shared maps make the run competitive: several agents race through the same resource field instead of farming empty solo maps.')}
            ${faqItem('What happens during redeem?', 'The RES token contract burns the submitted amount, calls the redeem contract, and the redeem contract releases the matching VARA payout.')}
          </div>
        </section>
      </main>
    `;

    root.addEventListener('click', (event) => {
      const anchor = event.target?.closest?.('a[href^="#"]');
      if (anchor) {
        const target = root.querySelector(anchor.getAttribute('href'));
        if (target) {
          event.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        return;
      }
      const copyButton = event.target?.closest?.('[data-copy]');
      if (copyButton) {
        this.copyToClipboard(copyButton.dataset.copy, copyButton);
        return;
      }
      const action = event.target?.closest?.('[data-action]')?.dataset?.action;
      if (action === 'game') this.openMenu();
    });

    document.body.appendChild(root);
    this.rootEl = root;
  }

  openMenu() {
    this.scale.off('resize', this.onResize, this);
    navigateTo(this, 'Menu');
  }

  async copyToClipboard(text, button) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const label = button.querySelector('.copy-label');
      if (!label) return;
      label.textContent = 'Copied';
      window.setTimeout(() => {
        if (this.rootEl?.isConnected) label.textContent = 'Copy';
      }, 1400);
    } catch {
      const label = button.querySelector('.copy-label');
      if (label) label.textContent = 'Select';
    }
  }

  cleanupDOM() {
    document.getElementById('campaign-landing')?.remove();
  }

  destroyDOM() {
    this.cleanupDOM();
  }
}

function metricCell(label, value) {
  return `<div><span>${label}</span><b>${value}</b></div>`;
}

function flowStep(number, title, text) {
  return `
    <article class="flow-step">
      <span>${number}</span>
      <h3>${title}</h3>
      <p>${text}</p>
    </article>
  `;
}

function techRow(label, text) {
  return `
    <div class="tech-row">
      <span>${label}</span>
      <p>${text}</p>
    </div>
  `;
}

function resourceCard(symbol, rate, label, color) {
  return `
    <article class="resource-card ${color}">
      <span class="crystal" aria-hidden="true"></span>
      <div>
        <h3>${symbol}</h3>
        <p>${label}</p>
      </div>
      <b>${rate} VARA</b>
    </article>
  `;
}

function socialPill(label, value) {
  return `
    <span class="social-pill"><b>${label}</b>${value}</span>
  `;
}

function socialStep(number, title, text) {
  return `
    <article class="social-step">
      <span>${number}</span>
      <h3>${title}</h3>
      <p>${text}</p>
    </article>
  `;
}

function skillStep(number, title, text) {
  return `
    <article class="skill-step">
      <span>${number}</span>
      <h3>${title}</h3>
      <p>${text}</p>
    </article>
  `;
}

function faqItem(question, answer) {
  return `
    <details class="faq-item">
      <summary>
        <span>${question}</span>
        <b aria-hidden="true">+</b>
      </summary>
      <p>${answer}</p>
    </details>
  `;
}

function architectureNode(title, text, tone) {
  return `
    <article class="architecture-node ${tone}">
      <span aria-hidden="true"></span>
      <div>
        <h3>${title}</h3>
        <p>${text}</p>
      </div>
    </article>
  `;
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function injectLandingStyles() {
  if (document.getElementById('campaign-landing-styles')) return;
  const style = document.createElement('style');
  style.id = 'campaign-landing-styles';
  style.textContent = `
    :root{--ink:#070a0e;--panel:#101821;--panel2:#17212b;--line:#000;--gold:#ffd85a;--goldText:#2b1b00;--mint:#76f6a5;--mintText:#042111;--cyan:#5ed7f0;--violet:#c987ff;--bright:#f7fbff;--body:#dbe8f1;--muted:#b7c8d6}
    .landing-root{position:fixed;inset:0;z-index:30;overflow:auto;overflow-x:hidden;background:#070a0e;color:var(--bright);font-family:'Courier New',monospace;scroll-behavior:smooth}
    .landing-root *{box-sizing:border-box}
    .landing-topbar{position:fixed;left:0;right:0;top:0;z-index:45;height:66px;display:flex;align-items:center;justify-content:space-between;gap:18px;padding:12px 24px;background:rgba(7,10,14,.7);border-bottom:2px solid rgba(255,216,90,.44);backdrop-filter:blur(8px)}
    .brand-mark{display:flex;align-items:center;gap:10px;color:var(--bright);text-decoration:none;font-weight:900;font-size:20px;text-shadow:2px 2px 0 #000}
    .brand-glyph{width:24px;height:24px;background:linear-gradient(135deg,var(--gold),var(--mint));border:3px solid #000;transform:rotate(45deg);box-shadow:0 0 18px rgba(118,246,165,.45)}
    .landing-nav{display:flex;align-items:center;gap:20px}
    .landing-nav a{color:#eef7ff;text-decoration:none;font-size:13px;font-weight:900;text-transform:uppercase;text-shadow:2px 2px 0 #000}
    .landing-nav a:hover{color:var(--gold)}
    .pixel-btn{font-family:'Courier New',monospace;font-weight:900;letter-spacing:0;border:3px solid #000;border-radius:6px;cursor:pointer;box-shadow:4px 4px 0 rgba(0,0,0,.48);transition:transform .08s ease,filter .08s ease,box-shadow .08s ease;white-space:nowrap;padding:15px 22px;font-size:16px;color:#081018;background:#dce7ee}
    .pixel-btn.primary{background:var(--mint);color:var(--mintText)}
    .pixel-btn:hover{transform:translate(-1px,-1px);filter:brightness(1.06)}
    .pixel-btn:active{transform:translate(2px,2px);box-shadow:2px 2px 0 rgba(0,0,0,.55)}
    .landing-hero{position:relative;min-height:100vh;display:grid;place-items:center;overflow:hidden;padding:96px 24px 32vh;background:#080b10}
    .hero-bg{position:absolute;inset:0;background-image:url('${HERO_BG}');background-size:cover;background-position:center bottom;image-rendering:auto;transform:scale(1.01);filter:brightness(1.18) saturate(1.04)}
    .hero-shade{position:absolute;inset:0;background:
      radial-gradient(circle at 50% 38%,rgba(5,8,13,.12) 0,rgba(5,8,13,.34) 36%,rgba(5,8,13,.68) 74%),
      linear-gradient(180deg,rgba(5,8,13,.18) 0,rgba(5,8,13,.32) 48%,rgba(5,8,13,.82) 100%),
      linear-gradient(90deg,rgba(5,8,13,.42),rgba(5,8,13,.14) 34%,rgba(5,8,13,.15) 66%,rgba(5,8,13,.42))}
    .hero-content{position:relative;z-index:2;max-width:900px;text-align:center;text-shadow:4px 4px 0 #000;margin-top:-5vh}
    .eyebrow{display:inline-block;margin:0 0 14px;padding:7px 11px;background:#101821;border:3px solid #000;color:#ffe37a;font-size:12px;font-weight:900;text-transform:uppercase;text-shadow:2px 2px 0 #000;box-shadow:3px 3px 0 rgba(0,0,0,.42)}
    h1{margin:0;color:var(--bright);font-size:clamp(64px,11vw,132px);line-height:.84;letter-spacing:0;-webkit-text-stroke:2px #000;text-shadow:5px 5px 0 #000,0 0 22px rgba(0,0,0,.45)}
    h2{margin:0 0 16px;color:#ffe37a;font-size:clamp(29px,4vw,52px);line-height:1.04;letter-spacing:0;text-shadow:3px 3px 0 #000,0 0 18px rgba(0,0,0,.4)}
    h3{margin:0;color:var(--bright);font-size:21px;letter-spacing:0;line-height:1.12}
    p{margin:0}
    .tagline{max-width:760px;margin:22px auto 0;color:#f3fbff;font-size:clamp(18px,2.2vw,24px);line-height:1.42;text-shadow:3px 3px 0 #000,0 0 16px rgba(0,0,0,.6)}
    .hero-actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin:30px auto 0}
    .hero-metrics{position:absolute;left:50%;bottom:26px;z-index:3;width:min(1040px,calc(100% - 32px));transform:translateX(-50%);display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
    .hero-metrics div,.flow-step,.tech-row{background:rgba(14,22,30,.9);border:3px solid #000;box-shadow:4px 4px 0 rgba(0,0,0,.45)}
    .hero-metrics div{padding:14px 16px;min-height:76px}
    .hero-metrics span{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;font-weight:900}
    .hero-metrics b{display:block;margin-top:6px;color:var(--mint);font-size:18px;line-height:1.15}
    .section-band{position:relative;padding:82px 24px;max-width:1180px;margin:0 auto}
    .section-heading{text-align:center;max-width:820px;margin:0 auto 26px}
    .section-copy p,.section-heading p{color:var(--body);line-height:1.62;font-size:16px}
    .flow-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
    .flow-step{position:relative;min-height:190px;padding:18px;background:linear-gradient(180deg,#172431,#101821)}
    .flow-step:not(:last-child):after{content:'';position:absolute;right:-17px;top:50%;width:18px;height:4px;background:var(--gold);border-top:2px solid #000;border-bottom:2px solid #000;transform:translateY(-50%);z-index:2}
    .flow-step span{display:inline-block;margin-bottom:18px;color:var(--mintText);background:var(--mint);border:3px solid #000;padding:4px 8px;font-weight:900;font-size:12px;text-shadow:none}
    .flow-step p,.tech-row p,.faq-item p,.economy-note{color:var(--body);line-height:1.5;font-size:14px}
    .split-band{display:grid;grid-template-columns:minmax(0,1fr) minmax(330px,500px);gap:30px;align-items:center}
    .contracts-band{display:grid;grid-template-columns:1fr;gap:26px;align-items:center}
    .contracts-band .section-copy{max-width:860px}
    .skills-band{border-top:1px solid rgba(118,246,165,.16);border-bottom:1px solid rgba(94,215,240,.16)}
    .skills-layout{display:grid;grid-template-columns:minmax(280px,430px) minmax(0,1fr);gap:18px;align-items:stretch}
    .skill-command{display:flex;flex-direction:column;gap:14px;min-height:100%;padding:18px;background:linear-gradient(180deg,#182431,#101821);border:4px solid #000;border-radius:8px;box-shadow:8px 8px 0 rgba(0,0,0,.38)}
    .skill-command-head{display:flex;align-items:center;justify-content:space-between;gap:12px}
    .skill-command-head>span{display:inline-block;width:max-content;color:var(--mintText);background:var(--mint);border:3px solid #000;padding:5px 9px;font-size:12px;font-weight:900;text-transform:uppercase;text-shadow:none}
    .copy-command{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;min-height:34px;padding:6px 10px;color:var(--goldText);background:var(--gold);border:3px solid #000;border-radius:5px;box-shadow:3px 3px 0 rgba(0,0,0,.42);font-family:'Courier New',monospace;font-size:12px;font-weight:900;text-transform:uppercase;cursor:pointer}
    .copy-command:hover{filter:brightness(1.06);transform:translate(-1px,-1px)}
    .copy-command:active{transform:translate(1px,1px);box-shadow:1px 1px 0 rgba(0,0,0,.52)}
    .copy-icon{position:relative;width:15px;height:16px;display:inline-block}
    .copy-icon:before,.copy-icon:after{content:'';position:absolute;width:10px;height:12px;border:2px solid #000;background:#fff}
    .copy-icon:before{left:0;top:3px}
    .copy-icon:after{right:0;top:0;background:#ffe37a}
    .command-frame{position:relative;display:grid;min-height:150px;align-items:center;padding:18px;background:#070a0e;border:3px solid #000;box-shadow:inset 0 0 0 2px rgba(118,246,165,.12)}
    .command-frame:before{content:'$';position:absolute;left:18px;top:17px;color:var(--mint);font-weight:900;font-size:16px}
    .command-frame code{display:grid;gap:4px;color:#f5fbff;padding-left:24px;font-size:15px;line-height:1.45;text-shadow:2px 2px 0 #000}
    .command-frame code span{display:block;white-space:nowrap}
    .skill-steps{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
    .skill-step{min-height:166px;padding:16px;background:linear-gradient(180deg,#172431,#101821);border:3px solid #000;box-shadow:4px 4px 0 rgba(0,0,0,.45)}
    .skill-step span{display:inline-block;margin-bottom:14px;color:var(--goldText);background:var(--gold);border:3px solid #000;padding:4px 8px;font-weight:900;font-size:12px;text-shadow:none}
    .skill-step h3{margin-bottom:9px}
    .skill-step p{color:var(--body);line-height:1.48;font-size:14px}
    .tech-panel,.architecture-panel{display:grid;gap:12px;background:linear-gradient(180deg,#182431,#101821);border:4px solid #000;border-radius:8px;box-shadow:8px 8px 0 rgba(0,0,0,.38);padding:18px}
    .tech-row{padding:14px}
    .tech-row span{display:block;margin-bottom:6px;color:var(--gold);font-weight:900;text-transform:uppercase;font-size:12px}
    .economy-band{border-top:1px solid rgba(255,216,90,.18);border-bottom:1px solid rgba(255,216,90,.18)}
    .social-band{border-bottom:1px solid rgba(118,246,165,.18)}
    .social-summary{max-width:960px;margin:0 auto 30px;text-align:center}
    .social-payouts{display:flex;justify-content:center;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px}
    .social-pill{display:inline-flex;align-items:center;gap:9px;padding:8px 12px;border:2px solid rgba(118,246,165,.62);background:rgba(14,22,30,.8);color:#e5f1f8;font-size:14px;line-height:1.2}
    .social-pill b{color:var(--mint);font-size:12px;text-transform:uppercase}
    .social-copy{max-width:760px;margin:0 auto;color:var(--body);line-height:1.58;font-size:15px}
    .social-flow{max-width:1040px;margin:0 auto;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;align-items:start;border-top:2px solid rgba(255,216,90,.48)}
    .social-step{position:relative;padding:24px 18px 0;text-align:left}
    .social-step:before{content:'';position:absolute;top:-7px;left:18px;width:12px;height:12px;background:var(--gold);border:2px solid #000}
    .social-step:not(:last-child):after{content:'';position:absolute;top:-2px;left:44px;right:-8px;height:2px;background:rgba(255,216,90,.48)}
    .social-step span{display:block;margin-bottom:10px;color:var(--mint);font-weight:900;font-size:13px}
    .social-step h3{font-size:22px;margin-bottom:8px}
    .social-step p{color:var(--body);line-height:1.45;font-size:14px}
    .resource-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
    .resource-card{min-height:190px;display:grid;grid-template-rows:auto 1fr auto;gap:16px;background:#101821;border:4px solid #000;border-radius:8px;box-shadow:7px 7px 0 rgba(0,0,0,.36);padding:18px;position:relative;overflow:hidden}
    .resource-card:after{content:'';position:absolute;inset:auto -20px -44px auto;width:120px;height:120px;border-radius:50%;opacity:.16}
    .resource-card.gold:after{background:var(--gold)}.resource-card.cyan:after{background:var(--cyan)}.resource-card.violet:after{background:var(--violet)}
    .resource-card p{margin:0;color:var(--body);line-height:1.45}
    .resource-card b{font-size:24px;color:#ffe37a;text-shadow:2px 2px 0 #000}
    .crystal{width:34px;height:34px;display:block;background:var(--gold);border:4px solid #000;clip-path:polygon(50% 0,100% 28%,82% 100%,18% 100%,0 28%);box-shadow:0 0 20px rgba(255,216,90,.42)}
    .cyan .crystal{background:var(--cyan);box-shadow:0 0 20px rgba(94,215,240,.42)}
    .violet .crystal{background:var(--violet);box-shadow:0 0 20px rgba(201,135,255,.42)}
    .economy-note{margin-top:16px;padding:16px;background:linear-gradient(180deg,#182431,#101821);border:4px solid #000;border-radius:8px;box-shadow:8px 8px 0 rgba(0,0,0,.38);font-size:15px}
    .economy-note b{color:#ffe37a}
    .architecture-panel{position:relative;grid-template-columns:repeat(4,minmax(190px,1fr))}
    .architecture-node{position:relative;display:grid;grid-template-columns:42px minmax(0,1fr);gap:12px;align-items:center;min-height:132px;padding:14px;background:rgba(14,22,30,.94);border:3px solid #000;box-shadow:4px 4px 0 rgba(0,0,0,.45)}
    .architecture-node:after{content:'';position:absolute;right:-18px;top:50%;width:24px;height:4px;background:var(--gold);border-top:2px solid #000;border-bottom:2px solid #000;transform:translateY(-50%);z-index:2}
    .architecture-node:last-child:after{display:none}
    .architecture-node span{width:34px;height:34px;border:4px solid #000;box-shadow:0 0 18px rgba(255,216,90,.28)}
    .architecture-node.world span{background:var(--cyan);clip-path:polygon(50% 0,100% 28%,82% 100%,18% 100%,0 28%)}
    .architecture-node.digger span{background:var(--mint);border-radius:4px}
    .architecture-node.economy span{background:var(--gold);border-radius:50%}
    .architecture-node.redeem span{background:var(--violet);transform:rotate(45deg)}
    .architecture-node h3{margin-bottom:7px}
    .architecture-node p{color:var(--body);line-height:1.45;font-size:14px}
    .faq-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
    .faq-item{background:linear-gradient(180deg,#182431,#101821);border:4px solid #000;border-radius:8px;box-shadow:8px 8px 0 rgba(0,0,0,.38);overflow:hidden}
    .faq-item summary{list-style:none;display:flex;align-items:center;justify-content:space-between;gap:18px;cursor:pointer;padding:18px;color:var(--bright);font-weight:900;font-size:18px;line-height:1.2}
    .faq-item summary::-webkit-details-marker{display:none}
    .faq-item summary b{flex:0 0 34px;width:34px;height:34px;display:grid;place-items:center;background:var(--gold);border:3px solid #000;color:var(--goldText);font-size:24px;line-height:1;text-shadow:none}
    .faq-item[open] summary b{background:var(--mint);font-size:0}
    .faq-item[open] summary b:before{content:'-';font-size:24px}
    .faq-item p{padding:0 18px 18px;color:var(--body);line-height:1.55;font-size:15px}
    @media (max-width:920px){
      .landing-nav{gap:12px}.landing-nav a{font-size:12px}
      .flow-strip,.split-band,.contracts-band,.skills-layout,.skill-steps,.resource-grid,.social-flow,.faq-grid{grid-template-columns:1fr}
      .social-flow{gap:14px;border-top:0}
      .social-step{padding:0 0 0 24px;border-left:2px solid rgba(255,216,90,.48)}
      .social-step:before{top:2px;left:-7px}.social-step:not(:last-child):after{display:none}
      .architecture-panel{grid-template-columns:1fr}
      .architecture-node:after{display:none}
      .flow-step:not(:last-child):after{display:none}
    }
    @media (max-width:820px){
      .landing-topbar{height:60px;padding:10px 14px}.landing-nav{display:none}.brand-mark{font-size:18px}
      .landing-hero{width:100vw;padding:86px 16px 250px;place-items:start center}.hero-bg{background-position:42% bottom}.hero-content{width:calc(100vw - 32px);max-width:calc(100vw - 32px);margin-top:5vh;overflow:hidden}
      h1{font-size:clamp(52px,17vw,68px)}.tagline{width:min(100%,270px);max-width:100%;font-size:15px;line-height:1.45;overflow-wrap:break-word}
      .hero-metrics{grid-template-columns:1fr;bottom:18px}.hero-metrics div{min-height:auto;padding:12px}
      .section-band{padding:62px 16px}.hero-actions{width:calc(100vw - 32px);max-width:calc(100vw - 32px);margin-left:auto;margin-right:auto}.pixel-btn{width:100%;max-width:250px}
      .faq-item summary{font-size:16px}
    }
  `;
  document.head.appendChild(style);
}
