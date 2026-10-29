/**
 * Pure line math for `propose_patch` — no I/O, so `selfcheck.mjs` can exercise it directly.
 *
 * A proposal is diffed line by line: the common prefix and suffix are trimmed, the changed
 * middle goes through an LCS, and every changed op plus `context` equal lines becomes its own
 * hunk. One ceiling: a middle larger than MAX_DIFF_CELLS is emitted as a single replace block.
 */

const CONTEXT = 3
/** Above this many DP cells the changed middle is emitted as one replace block. */
const MAX_DIFF_CELLS = 400000

/** 1-based line number that contains a character offset. */
export function lineAt(text, offset) {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

/** Every offset where `needle` occurs in `text`, left to right and non-overlapping. */
export function occurrences(text, needle) {
  const found = []
  let index = text.indexOf(needle)
  while (index !== -1) {
    found.push(index)
    index = text.indexOf(needle, index + needle.length)
  }
  return found
}

/** Op list for two line arrays: ' ' equal, '-' removed, '+' added; removals precede additions. */
function diffLines(oldLines, newLines) {
  const n = oldLines.length
  const m = newLines.length
  if (n === 0) return newLines.map((text) => ({ kind: '+', text }))
  if (m === 0) return oldLines.map((text) => ({ kind: '-', text }))
  if (n * m > MAX_DIFF_CELLS) return replaceBlock(oldLines, newLines)
  const width = m + 1
  const dp = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * width + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * width + j + 1] + 1
        : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }
  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: ' ', text: oldLines[i] })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      ops.push({ kind: '-', text: oldLines[i] })
      i += 1
    } else {
      ops.push({ kind: '+', text: newLines[j] })
      j += 1
    }
  }
  while (i < n) { ops.push({ kind: '-', text: oldLines[i] }); i += 1 }
  while (j < m) { ops.push({ kind: '+', text: newLines[j] }); j += 1 }
  return orderChangeRuns(ops)
}

/** Fallback for an oversized middle: one removal block followed by one addition block. */
function replaceBlock(oldLines, newLines) {
  return [
    ...oldLines.map((text) => ({ kind: '-', text })),
    ...newLines.map((text) => ({ kind: '+', text })),
  ]
}

/** Emit the removals of one change run before its additions, like a conventional diff. */
function orderChangeRuns(ops) {
  const ordered = []
  let index = 0
  while (index < ops.length) {
    if (ops[index].kind === ' ') {
      ordered.push(ops[index])
      index += 1
      continue
    }
    const removed = []
    const added = []
    while (index < ops.length && ops[index].kind !== ' ') {
      if (ops[index].kind === '-') removed.push(ops[index])
      else added.push(ops[index])
      index += 1
    }
    ordered.push(...removed, ...added)
  }
  return ordered
}

/** Merge each changed op plus `context` neighbours into non-overlapping [from, to) ranges. */
function hunkRanges(ops, context) {
  const ranges = []
  let from = -1
  let to = -1
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].kind === ' ') continue
    const low = Math.max(0, index - context)
    const high = Math.min(ops.length, index + context + 1)
    if (from === -1) {
      from = low
      to = high
      continue
    }
    if (low <= to) {
      to = Math.max(to, high)
      continue
    }
    ranges.push([from, to])
    from = low
    to = high
  }
  if (from !== -1) ranges.push([from, to])
  return ranges
}

/**
 * All hunks of one proposal.
 * @param path display path, carried for the diff card.
 * @param before current file text, or null when the file does not exist yet.
 * @param after proposed text.
 * @param context unchanged lines kept on each side of every change.
 */
export function buildHunks(path, before, after, context = CONTEXT) {
  if (before === null) {
    const lines = after.split('\n')
    return [{
      path,
      oldText: null,
      newText: after,
      firstLine: 1,
      removed: 0,
      added: lines.length,
      body: lines.map((line) => `+${line}`),
    }]
  }
  const oldLines = before.split('\n')
  const newLines = after.split('\n')
  let head = 0
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head += 1
  let tail = 0
  while (
    tail < oldLines.length - head
    && tail < newLines.length - head
    && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) tail += 1
  const lead = Math.max(0, head - context)
  const trail = Math.min(oldLines.length, oldLines.length - tail + context)
  const ops = [
    ...oldLines.slice(lead, head).map((text) => ({ kind: ' ', text })),
    ...diffLines(
      oldLines.slice(head, oldLines.length - tail),
      newLines.slice(head, newLines.length - tail)),
    ...oldLines.slice(oldLines.length - tail, trail).map((text) => ({ kind: ' ', text })),
  ]
  if (!ops.some((op) => op.kind !== ' ')) return []
  const oldIndexAt = []
  let oldIndex = lead
  for (const op of ops) {
    oldIndexAt.push(oldIndex)
    if (op.kind !== '+') oldIndex += 1
  }
  return hunkRanges(ops, context).map(([from, to]) => {
    const slice = ops.slice(from, to)
    return {
      path,
      oldText: slice.filter((op) => op.kind !== '+').map((op) => op.text).join('\n'),
      newText: slice.filter((op) => op.kind !== '-').map((op) => op.text).join('\n'),
      firstLine: oldIndexAt[from] + 1,
      removed: slice.filter((op) => op.kind === '-').length,
      added: slice.filter((op) => op.kind === '+').length,
      body: slice.map((op) => `${op.kind}${op.text}`),
    }
  })
}

/** Render every hunk as one unified diff, so the model can quote exact lines instead of retyping. */
export function unifiedDiff(hunks) {
  return hunks.map((hunk) => {
    const oldCount = hunk.oldText === null ? 0 : hunk.oldText.split('\n').length
    const newCount = hunk.newText.split('\n').length
    return [
      `@@ -${hunk.firstLine},${oldCount} +${hunk.firstLine},${newCount} @@`,
      ...hunk.body,
    ].join('\n')
  }).join('\n')
}/** Side-by-side rows with both line numbers; 0 means "no line on that side". */
export function sideBySide(hunks) {
  const rows = []
  hunks.forEach((hunk, index) => {
    if (index > 0) rows.push({ left: '…', right: '…', kind: 'gap', leftNo: 0, rightNo: 0 })
    let oldNo = hunk.firstLine
    let newNo = hunk.firstLine
    const ops = hunk.body.map((line) => ({ kind: line[0], text: line.slice(1) }))
    let at = 0
    while (at < ops.length) {
      if (ops[at].kind === ' ') {
        rows.push({ left: ops[at].text, right: ops[at].text, kind: 'same', leftNo: oldNo, rightNo: newNo })
        oldNo += 1
        newNo += 1
        at += 1
        continue
      }
      const removed = []
      const added = []
      while (at < ops.length && ops[at].kind === '-') {
        removed.push({ text: ops[at].text, no: oldNo })
        oldNo += 1
        at += 1
      }
      while (at < ops.length && ops[at].kind === '+') {
        added.push({ text: ops[at].text, no: newNo })
        newNo += 1
        at += 1
      }
      const paired = Math.min(removed.length, added.length)
      for (let k = 0; k < paired; k += 1) {
        rows.push({ left: removed[k].text, right: added[k].text, kind: 'modified',
          leftNo: removed[k].no, rightNo: added[k].no })
      }
      for (let k = paired; k < removed.length; k += 1) {
        rows.push({ left: removed[k].text, right: removed[k].text, kind: 'removed',
          leftNo: removed[k].no, rightNo: 0 })
      }
      for (let k = paired; k < added.length; k += 1) {
        rows.push({ left: '', right: added[k].text, kind: 'added',
          leftNo: 0, rightNo: added[k].no })
      }
    }
  })
  return rows
}
