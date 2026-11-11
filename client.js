/**
 * Client half: propose_patch as one rounded card with two columns — original code on the left,
 * proposed code on the right — a copy action and a direct-apply action in the header.
 * Direct apply sends the hunks to the Host half through the patch-relay-apply session command;
 * the browser never writes a file itself, and a file changed after the proposal is refused by
 * the Host. Hand editing stays available: the card remains a readable diff.
 */
window.__ModuleLoader__.load({
  id: 'patch-relay',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    const NUM_W = 40
    const BORDER = '1px solid var(--dsw-alias-border-l1)'
    const KIND = {
      added: { text: '#1a7f37', background: 'rgba(46,160,67,0.14)', border: '#2ea043' },
      removed: { text: '#b42318', background: 'rgba(207,34,46,0.14)', border: '#cf222e' },
      modified: { text: '#0b57d0', background: 'rgba(9,105,218,0.14)', border: '#0969da' },
      same: { text: 'var(--dsw-alias-label-primary)', background: 'transparent', border: 'transparent' },
    }
    const STATUS_COLOR = {
      ok: 'var(--dsw-alias-state-success-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      info: 'var(--dsw-alias-label-secondary)',
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

    function errorText(error) {
      if (error instanceof Error) return error.message
      return error === null || error === undefined ? 'unknown error' : String(error)
    }

    function groupRows(rows) {
      const groups = []
      let current = []
      for (const row of rows) {
        if (row.kind === 'gap') {
          if (current.length > 0) groups.push(current)
          current = []
          continue
        }
        current.push(row)
      }
      if (current.length > 0) groups.push(current)
      return groups
    }

    function numberField(side) {
      return side === 'left' ? 'leftNo' : 'rightNo'
    }

    function valueField(side) {
      return side === 'left' ? 'left' : 'right'
    }

    function sideRows(group, side) {
      const field = numberField(side)
      return group.filter((row) => Number(row[field]) > 0)
    }

    function sideText(group, side) {
      const field = valueField(side)
      return sideRows(group, side).map((row) => text(row[field])).join('\n')
    }

    function CodeLine(props) {
      const kind = KIND[props.row.kind] || KIND.same
      const number = props.row[numberField(props.side)]
      const value = text(props.row[valueField(props.side)])
      return h('div', {
        style: {
          display: 'flex',
          alignItems: 'flex-start',
          background: kind.background,
          borderLeft: '3px solid ' + kind.border,
          color: kind.text,
        },
      },
      h('span', {
        style: {
          flex: '0 0 auto', width: NUM_W, paddingRight: 8, textAlign: 'right',
          opacity: 0.45, userSelect: 'none', fontFamily: MONO, fontSize: 12, lineHeight: '1.55',
        },
      }, String(number || '')),
      h('span', {
        style: {
          flex: '1 1 auto', minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
          fontFamily: MONO, fontSize: 12, lineHeight: '1.55',
        },
      }, value.length === 0 ? ' ' : value))
    }

    function Column(props) {
      const rows = sideRows(props.group, props.side)
      if (rows.length === 0) {
        return h('div', {
          style: { padding: '10px 12px', fontFamily: MONO, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
        }, '（无内容）')
      }
      return h('div', { style: { padding: '4px 8px 4px 0', minWidth: 0 } },
        rows.map((row, index) => h(CodeLine, { key: String(index), row, side: props.side })))
    }

    function ActionButton(props) {
      return h('button', {
        type: 'button',
        title: props.title,
        onClick: props.onClick,
        disabled: props.disabled === true,
        style: {
          flex: '0 0 auto',
          fontFamily: 'inherit',
          fontSize: 12,
          lineHeight: '18px',
          padding: '2px 10px',
          borderRadius: 6,
          border: props.primary === true
            ? '1px solid var(--dsw-alias-brand-primary)'
            : '1px solid var(--dsw-alias-border-l2)',
          background: props.primary === true ? 'var(--dsw-alias-brand-primary)' : 'transparent',
          color: props.primary === true ? '#fff' : 'var(--dsw-alias-label-primary)',
          cursor: props.disabled === true ? 'default' : 'pointer',
          opacity: props.disabled === true ? 0.6 : 1,
        },
      }, props.label)
    }

    function notice(message) {
      return h('div', { style: { fontSize: 12, padding: '6px 10px', opacity: 0.75 } }, message)
    }

    function Card(props) {
      const ctx = props.ctx
      const block = props.block
      const rows = findRows(block, 0, new WeakSet())
      const statusState = React.useState(null)
      const status = statusState[0]
      const setStatus = statusState[1]
      const busyState = React.useState(false)
      const busy = busyState[0]
      const setBusy = busyState[1]
      if (!rows) {
        const shape = block && typeof block === 'object' ? Object.keys(block).join(', ') : typeof block
        return notice('propose_patch 未找到行数据；block 字段：' + shape)
      }
      const path = findString(block, 'path', 0, new WeakSet()) || ''
      const groups = groupRows(rows)
      const created = !rows.some((row) => Number(row.leftNo) > 0)
      const firstLine = rows.reduce((best, row) => {
        const number = Number(row.leftNo) || 0
        return number > 0 && (best === 0 || number < best) ? number : best
      }, 0)
      const location = path ? (firstLine > 0 ? path + ':' + firstLine : path) : 'propose_patch'
      const copyValue = groups.map((group) => sideText(group, 'right')).join('\n')

      function onCopy() {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
        if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
          setStatus({ kind: 'error', text: '当前页面不允许访问剪贴板' })
          return
        }
        clipboard.writeText(copyValue).then(
          () => setStatus({ kind: 'ok', text: '已复制修改后的代码' }),
          (error) => setStatus({ kind: 'error', text: '复制失败：' + errorText(error) }),
        )
      }

      async function onApply() {
        if (busy) return
        setBusy(true)
        setStatus({ kind: 'info', text: '正在应用…' })
        const remote = ctx && ctx.remote !== undefined ? ctx.remote : ctx && typeof ctx.get === 'function' ? ctx.get('remote') : undefined
        const owner = props.sessionId || (block && typeof block === 'object' ? block.sessionId : undefined)
        const payload = {
          path: path,
          created: created,
          ...(typeof props.cwd === 'string' && props.cwd.length > 0 ? { baseDir: props.cwd } : {}),
          hunks: groups.map((group) => ({ oldText: sideText(group, 'left'), newText: sideText(group, 'right') })),
        }
        try {
          if (!remote || !remote.commands || typeof remote.commands.execute !== 'function') {
            throw new Error('Remote 不可用，请刷新页面或重载插件')
          }
          if (!owner) throw new Error('缺少会话标识')
          // Remote methods answer with the RemoteResult envelope: { ok: true, value } or
          // { ok: false, error }. The value here is the command execution.
          const answer = await remote.commands.execute(owner, '/patch-relay-apply ' + JSON.stringify(payload), [])
          if (!answer || answer.ok !== true) {
            const failure = answer && answer.error
            throw new Error(failure ? String(failure.code || '') + ': ' + String(failure.message || '命令调用失败') : '命令调用失败')
          }
          const execution = answer.value
          if (!execution) throw new Error('命令 patch-relay-apply 未注册（请重载插件）')
          const result = execution.result
          if (!result) throw new Error('命令没有返回结果')
          if (result.kind !== 'success') throw new Error(result.text || '应用失败')
          setStatus({ kind: 'ok', text: result.text || '已应用' })
        } catch (error) {
          setStatus({ kind: 'error', text: '应用失败：' + errorText(error) })
        } finally {
          setBusy(false)
        }
      }

      return h('div', {
        style: {
          margin: '6px 0',
          border: BORDER,
          borderRadius: 10,
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-layer-1)',
        },
      },
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px',
          borderBottom: BORDER, background: 'var(--dsw-alias-bg-layer-2)',
        },
      },
      h('div', {
        style: {
          flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
          whiteSpace: 'nowrap', fontFamily: MONO, fontSize: 12, fontWeight: 600,
          color: 'var(--dsw-alias-label-primary)', userSelect: 'text',
        },
      }, location),
      h(ActionButton, { label: '复制', title: '复制修改后的代码', onClick: onCopy }),
      h(ActionButton, {
        label: busy ? '应用…' : '直接应用',
        title: '直接把提案写入文件，不需要手动粘贴',
        onClick: onApply,
        primary: true,
        disabled: busy,
      })),
      h('div', {
        style: { display: 'flex', alignItems: 'stretch', padding: '2px 10px', borderBottom: BORDER },
      },
      h('div', {
        style: { flex: '1 1 50%', minWidth: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      }, '原代码'),
      h('div', {
        style: { flex: '1 1 50%', minWidth: 0, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
      }, '修改后代码')),
      status ? h('div', {
        style: {
          padding: '3px 10px 6px', fontSize: 11, fontFamily: MONO,
          color: STATUS_COLOR[status.kind] || STATUS_COLOR.info,
        },
      }, status.text) : null,
      groups.map((group, index) => h('div', {
        key: String(index),
        style: { display: 'flex', alignItems: 'stretch', borderTop: index === 0 ? 'none' : BORDER },
      },
      h('div', {
        style: { flex: '1 1 50%', minWidth: 0, borderRight: BORDER },
      }, h(Column, { group, side: 'left' })),
      h('div', {
        style: { flex: '1 1 50%', minWidth: 0 },
      }, h(Column, { group, side: 'right' })))))
    }

    return {
      inject: ['slots', 'remote', 'remote.commands'],
      apply(ctx) {
        function ProposalView(props) {
          try {
            return h(Card, Object.assign({}, props, { ctx: ctx }))
          } catch (error) {
            return notice('propose_patch 视图异常：' + errorText(error))
          }
        }
        ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'propose_patch',
        }, ProposalView))
      },
    }
  },
})