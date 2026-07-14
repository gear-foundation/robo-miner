import assert from 'node:assert/strict';
import test from 'node:test';
import { robotVisualAnchor } from '../src/render/robot.js';

test('robot visual anchor follows the rendered hat and digging shake', () => {
  assert.deepEqual(
    robotVisualAnchor(120, 220, 48, { hat: 'party', shake: { x: 1, y: -1 } }),
    { x: 121, top: 191, bottom: 243 },
  );
  assert.deepEqual(
    robotVisualAnchor(120, 220, 48, { hat: 'none' }),
    { x: 120, top: 198, bottom: 244 },
  );
});
