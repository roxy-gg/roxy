import assert from 'node:assert/strict'
import { narreteCrop, narreteDrag } from '../src/shared/narrete'

assert.deepEqual(narreteCrop({ x: 0.1, y: 0.2, width: 0.4, height: 0.5 }, 2000, 1000), {
  x: 200,
  y: 200,
  width: 800,
  height: 500
})
assert.deepEqual(narreteCrop({ x: 0, y: 0, width: 1, height: 1 }, 3200, 1800), {
  x: 0,
  y: 0,
  width: 3200,
  height: 1800
})
assert.deepEqual(
  narreteCrop({ x: 0.99, y: 0.99, width: 0.01000000000001, height: 0.01 }, 2000, 1000),
  { x: 1980, y: 990, width: 20, height: 10 }
)
for (const selection of [
  { x: -0.1, y: 0, width: 0.2, height: 0.2 },
  { x: 0.9, y: 0, width: 0.2, height: 0.2 },
  { x: 0, y: 0, width: -0.2, height: 0.2 },
  { x: 0, y: 0, width: 0.002, height: 0.2 },
  { x: NaN, y: 0, width: 0.2, height: 0.2 },
  { x: 0, y: Infinity, width: 0.2, height: 0.2 }
])
  assert.equal(narreteCrop(selection, 2000, 1000), null)
console.log(
  'NARRETE OK: normalized selection, pixel rounding, edge clipping, invalid/tiny region rejection'
)
const bounds = { x: -1500, y: 0, width: 1500, height: 750 }
assert.equal(narreteDrag({ x: -1400, y: 100 }, { x: -1390, y: 110 }, bounds), null)
assert.equal(narreteDrag({ x: -1400, y: 100 }, { x: -1000, y: 120 }, bounds), null)
assert.equal(narreteDrag({ x: -1400, y: 100 }, { x: -1380, y: 400 }, bounds), null)
assert.deepEqual(narreteDrag({ x: -900, y: 450 }, { x: -1350, y: 150 }, bounds), {
  x: 0.1,
  y: 0.2,
  width: 0.3,
  height: 0.4
})
assert.deepEqual(narreteDrag({ x: -1500, y: 0 }, { x: 100, y: 900 }, bounds), {
  x: 0,
  y: 0,
  width: 1,
  height: 1
})
