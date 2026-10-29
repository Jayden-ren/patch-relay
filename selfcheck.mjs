/**
 * One runnable check for the hunk math. `node selfcheck.mjs` prints ok or throws.
 * Invariants: the ' ' and '+' lines of every hunk reproduce its newText, the ' ' and '-'
 * lines reproduce its oldText, and changes farther apart than the context window stay apart.
 */
import assert from 'node:assert/strict'
import { buildHunks, lineAt, occurrences, sideBySide, unifiedDiff } from './diff.js'

const lines = (prefix, count) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join('\n')

assert.deepEqual(occurrences('a\nb\na', 'a'), [0, 4])
assert.equal(lineAt('a\nb\na', 4), 3)
assert.deepEqual(occurrences('abc', 'zz'), [])

// One replacement in the middle keeps 3 lines of context on each side.
{
  const before = lines('l', 9)
  const hunks = buildHunks('f.py', before, before.replace('l5', 'X'))
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0].firstLine, 2)
  assert.equal(hunks[0].removed, 1)
  assert.equal(hunks[0].added, 1)
  assert.deepEqual(hunks[0].body, [' l2', ' l3', ' l4', '-l5', '+X', ' l6', ' l7', ' l8'])
  assert.equal(unifiedDiff(hunks).split('\n')[0], '@@ -2,7 +2,7 @@')
}

// Two far-apart changes stay two hunks, each with its own line numbers.
{
  const before = lines('l', 30)
  const hunks = buildHunks('f.py', before, before.replace('l3', 'A3').replace('l25', 'B25'))
  assert.equal(hunks.length, 2, `got ${hunks.length} hunks`)
  assert.equal(hunks[0].firstLine, 1)
  assert.equal(hunks[0].removed, 1)
  assert.equal(hunks[1].firstLine, 22)
  assert.equal(hunks[1].added, 1)
  assert.equal(unifiedDiff(hunks).split('\n').filter((line) => line.startsWith('@@')).length, 2)
}

// Changes closer than the context window merge into one hunk.
{
  const before = lines('l', 20)
  const hunks = buildHunks('f.py', before, before.replace('l5', 'X').replace('l8', 'Y'))
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0].removed, 2)
  assert.equal(hunks[0].added, 2)
}

// A change on the first line has no context above it.
{
  const hunks = buildHunks('f.py', 'a\nb\nc', 'A\nb\nc')
  assert.equal(hunks[0].firstLine, 1)
  assert.deepEqual(hunks[0].body, ['-a', '+A', ' b', ' c'])
}

// Deleting text adds nothing.
{
  const hunks = buildHunks('f.py', 'a\nb\nc', 'a\nc')
  assert.equal(hunks[0].removed, 1)
  assert.equal(hunks[0].added, 0)
  assert.deepEqual(hunks[0].body, [' a', '-b', ' c'])
}

// A new file is all additions, with no old text.
{
  const hunks = buildHunks('new.py', null, 'a\nb')
  assert.equal(hunks[0].oldText, null)
  assert.equal(hunks[0].firstLine, 1)
  assert.equal(hunks[0].removed, 0)
  assert.equal(hunks[0].added, 2)
  assert.equal(unifiedDiff(hunks).split('\n')[0], '@@ -1,0 +1,2 @@')
}

// No change means no hunks; the caller rejects that proposal.
assert.deepEqual(buildHunks('f.py', 'a\nb', 'a\nb'), [])

// Reconstruction invariant over every case above.
for (const [before, after] of [
  [lines('l', 9), lines('l', 9).replace('l5', 'X')],
  ['a\nb\nc', 'A\nb\nc'],
  ['a\nb\nc', 'a\nc'],
  [lines('l', 30), lines('l', 30).replace('l3', 'A3').replace('l25', 'B25')],
]) {
  for (const hunk of buildHunks('f.py', before, after)) {
    const oldSide = hunk.body.filter((line) => line[0] !== '+').map((line) => line.slice(1)).join('\n')
    const newSide = hunk.body.filter((line) => line[0] !== '-').map((line) => line.slice(1)).join('\n')
    assert.equal(oldSide, hunk.oldText)
    assert.equal(newSide, hunk.newText)
  }
}


// Side-by-side rows: a paired change is 'modified', leftovers keep their kind, and both
// sides carry the line number an editor needs to jump to.
{
  const rows = sideBySide(buildHunks('f.py', 'a\nb\nc', 'a\nB\nc'))
  assert.deepEqual(rows, [
    { left: 'a', right: 'a', kind: 'same', leftNo: 1, rightNo: 1 },
    { left: 'b', right: 'B', kind: 'modified', leftNo: 2, rightNo: 2 },
    { left: 'c', right: 'c', kind: 'same', leftNo: 3, rightNo: 3 },
  ])
}
{
  const rows = sideBySide(buildHunks('f.py', 'a\nb\nc\nd', 'a\nZ\nd'))
  assert.deepEqual(rows.filter((row) => row.kind !== 'same'), [
    { left: 'b', right: 'Z', kind: 'modified', leftNo: 2, rightNo: 2 },
    { left: 'c', right: 'c', kind: 'removed', leftNo: 3, rightNo: 0 },
  ])
  assert.deepEqual(rows[rows.length - 1], { left: 'd', right: 'd', kind: 'same', leftNo: 4, rightNo: 3 })
}
{
  const rows = sideBySide(buildHunks('f.py', 'a', 'a\nb'))
  assert.deepEqual(rows, [
    { left: 'a', right: 'a', kind: 'same', leftNo: 1, rightNo: 1 },
    { left: '', right: 'b', kind: 'added', leftNo: 0, rightNo: 2 },
  ])
}
{
  const before = lines('l', 30)
  const rows = sideBySide(buildHunks('f.py', before, before.replace('l3', 'A3').replace('l25', 'B25')))
  assert.equal(rows.filter((row) => row.kind === 'gap').length, 1)
  assert.deepEqual(rows.filter((row) => row.kind === 'modified').map((row) => [row.leftNo, row.rightNo]), [[3, 3], [25, 25]])
}

console.log('selfcheck ok')