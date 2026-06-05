// Shared DOM styling helpers for the Agent Arena lobby + spectator, matching
// the menu's look (Courier, yellow accents, chunky black borders + drop shadow).

export function btnCss(bg = '#ffdd55') {
  return `font-family:'Courier New',monospace; font-weight:bold; color:#222;
    background:${bg}; border:3px solid #000; border-radius:12px; cursor:pointer;
    letter-spacing:1px; box-shadow:3px 3px 0 rgba(0,0,0,.35);
    transition:transform .08s ease;`;
}

// Hover/press feedback identical to the menu START button.
export function wireBtn(el) {
  el.addEventListener('mouseenter', () => { el.style.transform = 'scale(1.04)'; });
  el.addEventListener('mouseleave', () => { el.style.transform = 'scale(1)'; });
  el.addEventListener('mousedown', () => { el.style.transform = 'scale(0.97)'; });
  el.addEventListener('mouseup', () => { el.style.transform = 'scale(1.04)'; });
  return el;
}

// Paint a roomThumbnail ({cols, rows, colors[][]}) onto a canvas at `scale` px/cell.
export function paintThumb(canvas, thumb, scale = 3) {
  const ctx = canvas.getContext('2d');
  for (let y = 0; y < thumb.rows; y++) {
    const row = thumb.colors[y];
    for (let x = 0; x < thumb.cols; x++) {
      ctx.fillStyle = '#' + (row[x] >>> 0).toString(16).padStart(6, '0');
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
}

// Tiny stable string hash → seed.
export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % 100000;
}
