/**
 * Client half: `propose_patch` as two columns — 原代码 | 修改后 — with both line numbers in a
 * gutter, and the change kind carried by color (green added, red removed, blue modified).
 *
 * Long lines wrap inside their own cell instead of overflowing into the other column, so the
 * whole line stays visible and selectable. The header prints `path:line`, which is the string
 * an editor's "go to file:line" accepts.
 */
window.__ModuleLoader__.load({
  id: 'patch-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    const GUTTER = 46
    const KIND = {
      added: { color: '#1a7f37', background: 'rgba(46,160,67,0.14)', borderLeft: '3px solid #2ea043' },
      removed: { color: '#b42318', background: 'rgba(207,34,46,0.14)', borderLeft: '3px solid #cf222e' },
      modified: { color: '#0b57d0', background: 'rgba(9,105,218,0.14)', borderLeft: '3px solid #0969da' },
      same: { color: 'inherit', background: 'transparent', borderLeft: '3px solid transparent' },
      gap: { color: 'inherit', background: 'transparent', borderLeft: '3px solid transparent', opacity: 0.45 },
    }

    function isRowList(value) {
      return Array.isArray(value) && value.length > 0 && Boolean(value[0])
        && typeof value[0] === 'object' && 'left' in value[0] && 'right' in value[0] && 'kind' in value[0]
    }

    function findRows(value, depth, seen) {
      if (depth > 5 || value === null || typeof value !== 'object' || seen.has(value)) return undefined
      seen.add(value)
      if (isRowList(value)) return value
      const keys = Object.keys(value)
      for (let index = 0; index < keys.length; index += 1) {
        const found = findRows(value[keys[index]], depth + 1, seen)
        if (found !== undefined) return found
      }
      return undefined
    }

    function findString(value, name, depth, seen) {
      if (depth > 5 || value === null || typeof value !== 'object' || seen.has(value)) return undefined
      seen.add(value)
      if (!Array.isArray(value) && typeof value[name] === 'string') return value[name]
      const keys = Object.keys(value)
      for (let index = 0; index < keys.length; index += 1) {
        const found = findString(value[keys[index]], name, depth + 1, seen)
        if (found !== undefined) return found
      }
      return undefined
    }

    function text(value) {
      if (typeof value === 'string') return value
      return value === null || value === undefined ? '' : String(value)
    }

    function Cell({ value, kind, number }) {
      const style = KIND[kind] || KIND.same
      return h('td', {
        style: {
          padding: '0 10px 0 ' + (GUTTER + 8) + 'px',
          textIndent: '-' + GUTTER + 'px',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontFamily: MONO,
          fontSize: 12,
          lineHeight: '1.6',
          verticalAlign: 'top',
          ...style,
        },
      },
      h('span', {
        style: {
          display: 'inline-block',
          width: GUTTER,
          paddingRight: 8,
          textAlign: 'right',
          opacity: 0.5,
          userSelect: 'none',
        },
      }, number > 0 ? String(number) : ''),
      h('span', null, text(value).length === 0 ? ' ' : text(value)))
    }

    function notice(message) {
      return h('div', { style: { fontSize: 12, padding: '6px 10px', opacity: 0.75 } }, message)
    }

    function render(props) {
      const block = props && props.block
      const rows = findRows(block, 0, new WeakSet())
      const shape = block && typeof block === 'object' ? Object.keys(block).join(', ') : typeof block
      if (!rows) return notice('propose_patch 未找到行数据；block 字段：' + shape)
      const path = findString(block, 'path', 0, new WeakSet()) || ''
      const firstLine = rows.reduce((best, row) => {
        const number = Number(row.leftNo) || 0
        return number > 0 && (best === 0 || number < best) ? number : best
      }, 0)
      const location = path ? (firstLine > 0 ? path + ':' + firstLine : path) : 'propose_patch'
      return h('div', {
        style: {
          margin: '6px 0',
          border: '1px solid var(--dsw-alias-border-subtle, rgba(0,0,0,0.12))',
          borderRadius: 8,
          overflowX: 'auto',
        },
      },
      h('div', {
        style: { fontFamily: MONO, fontSize: 12, fontWeight: 600, padding: '6px 10px 4px', userSelect: 'text' },
      }, location),
      h('table', { style: { borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed', minWidth: 360 } },
        h('colgroup', null,
          h('col', { style: { width: '50%' } }),
          h('col', { style: { width: '50%' } })),
        h('tbody', null, rows.map((row, index) => h('tr', { key: String(index) },
          h(Cell, { value: row.left, kind: row.kind, number: row.leftNo }),
          h(Cell, { value: row.right, kind: row.kind, number: row.rightNo }))))))
    }

    function ProposalView(props) {
      try {
        return render(props)
      } catch (error) {
        return notice('propose_patch 视图异常：' + String((error && error.message) || error))
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'propose_patch',
        }, ProposalView))
      },
    }
  },
})