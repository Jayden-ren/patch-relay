/**
 * Propose-patch: the model proposes, you apply, the model verifies.
 *
 * Three effects, all owned by this plugin's context:
 *  - the `propose_patch` tool: checks a proposed snippet against the real file and returns
 *    the actual diff. It never writes, so no change can happen behind your back.
 *  - `edit`/`write` hidden from every agent and denied if called anyway, so "just fix it"
 *    has no shortcut left.
 *  - one prompt section stating the handoff rule.
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { buildHunks, lineAt, occurrences, sideBySide, unifiedDiff } from './diff.js'

const TOOL_NAME = 'propose_patch'
/** Tools whose absence forces every change through a proposal. */
const HIDDEN_TOOLS = ['edit', 'write']
const DENY_REASON = 'patch-handoff: direct file edits are disabled. Call propose_patch with the exact old/new text (or content for a new file) so the user can apply it by hand.'
const DIFF_CONTEXT = 3

export const inject = ['tools', 'systemPrompt']

const PROMPT = `**Patch handoff 鈥?every code change goes through \`propose_patch\`.**
The user applies each change by hand, in their own editor, so that the diff stays small and reviewed.

1. Read and diagnose until you know the root cause. Never quote file content you have not read in this session.
2. Call \`propose_patch\` with the exact \`old_string\`/\`new_string\` (or \`content\` for a new file). It verifies the snippet exists exactly once and returns the real diff with line numbers; it never touches the file.
3. Answer with the problem and the root cause in at most two sentences, then show every change as a two-column table: 原代码 | 修改后, one row per line, three unchanged context lines around each change. In the right column mark added lines 🟩, deleted lines 🟥 (kept in place so the reader sees what went away), and lines changed in place 🟦. The table carries the code; do not paste the same lines again as prose.
4. End the turn with one \`ask_user_question\` card: question "应用完了吗？", options "已应用，继续" and "还要再改". That click is how the user resumes you after editing by hand — do not propose the next change before it.
5. On "已应用，继续": read the file back, run the project's own checks, say what you verified, then go on to the next change. If the question times out, stop and wait for the user instead of assuming anything.
Never state or imply that a change is in effect because you proposed it. Keep each proposal the smallest diff that fixes the cause: no drive-by refactors, no new abstractions, no reformatting.`

const TOOL_DESCRIPTION = `Propose an exact code change for the user to apply by hand. Verifies that old_string occurs exactly once in the file, returns the real diff with line numbers, and never modifies the file. Pass content instead of old_string/new_string to propose a new file or a whole-file rewrite.`

/** Register everything; each call is a Cordis effect disposed with this plugin. */
export function apply(ctx) {
  ctx.tools.register(proposePatchTool(ctx))
  // A plain-context guard applies to every agent immediately, including ones created before
  // this plugin activated; the per-agent restriction below additionally removes the tools
  // from the schema the model reads.
  ctx.tools.guard((exec) => (HIDDEN_TOOLS.includes(exec.name) ? DENY_REASON : undefined))
  ctx.systemPrompt.section({
    name: 'tool:propose-patch',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: ({ scope }) => (ctx.tools.get(TOOL_NAME, scope) === undefined ? '' : PROMPT),
  })
  ctx.on('agent/created', ({ agent }) => hideEditors(ctx, agent))
}

/**
 * Hide the mutating file tools from one agent. The restriction is owned by the agent's own
 * context so it disappears with that agent, and mirrored on ours so unloading the plugin
 * lifts it too.
 * @param ctx the plugin context, owner of the global tool registry.
 * @param agent the agent being created.
 */
function hideEditors(ctx, agent) {
  try {
    // Filter through the agent's own view: in a preset deployment the file tools live on the
    // agent plane, so the plugin's unscoped (global) view does not contain them, while the
    // agent's ancestor layers do — and those names are still restrictable from this scope.
    const deny = HIDDEN_TOOLS.filter((name) => ctx.tools.get(name, agent) !== undefined)
    if (deny.length === 0) return
    const dispose = agent.ctx.effect(() => agent.ctx.tools.restrict({ deny }))
    ctx.effect(() => dispose)
  } catch (error) {
    warn(ctx, `could not hide ${HIDDEN_TOOLS.join('/')}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Best-effort diagnostic; a silent failure here would look like the plugin doing nothing. */
function warn(ctx, message) {
  try {
    const logger = typeof ctx.logger === 'function' ? ctx.logger('propose-patch') : ctx.logger
    logger?.warn?.(message)
  } catch {}
}

/**
 * Build the tool definition. Plain object, no Harness imports, so the bundle loads with only
 * Node built-ins available.
 * @param ctx the plugin context, used for the session directory lookup.
 */
function proposePatchTool(ctx) {
  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    // Plain JSON Schema: the runtime validates what it receives, and only the internal
    // `defineTool` helper compiles the `required: true` shorthand.
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['file_path'],
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to the file, relative to the session working directory or absolute. Provide file_path first.',
        },
        old_string: {
          type: 'string',
          description: 'Exact literal text copied from the current file, indentation included. Omit when passing content.',
        },
        new_string: {
          type: 'string',
          description: 'Replacement for old_string. An empty string deletes it. Omit when passing content.',
        },
        content: {
          type: 'string',
          description: 'Full proposed file content, for a new file or a whole-file rewrite. Omit when passing old_string/new_string.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'created', 'removed', 'added', 'diff', 'hunks', 'rows'],
        properties: {
          path: { type: 'string' },
          created: { type: 'boolean' },
          removed: { type: 'integer' },
          added: { type: 'integer' },
          diff: { type: 'string' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['left', 'right', 'kind', 'leftNo', 'rightNo'],
              properties: {
                left: { type: 'string' },
                right: { type: 'string' },
                kind: { type: 'string', enum: ['same', 'added', 'removed', 'modified', 'gap'] },
                leftNo: { type: 'integer' },
                rightNo: { type: 'integer' },
              },
            },
          },
          hunks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['oldText', 'newText'],
              properties: {
                oldText: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                newText: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderProposal(value) }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        diffs: value.hunks.map((hunk) => ({ path: value.path, oldText: hunk.oldText, newText: hunk.newText })),
        rows: value.rows,
      }),
    },
    async execute(args, exec) {
      const plan = await planProposal(ctx, args, exec)
      return {
        path: plan.path,
        created: plan.created,
        removed: plan.hunks.reduce((total, hunk) => total + hunk.removed, 0),
        added: plan.hunks.reduce((total, hunk) => total + hunk.added, 0),
        diff: unifiedDiff(plan.hunks),
        hunks: plan.hunks.map((hunk) => ({ oldText: hunk.oldText, newText: hunk.newText })),
        rows: sideBySide(plan.hunks),
      }
    },
    presentCall(args) {
      const newText = typeof args.content === 'string' ? args.content : (args.new_string ?? '')
      return {
        card: 'diff',
        title: `Propose ${args.file_path}`,
        diffs: [{ path: args.file_path, oldText: typeof args.old_string === 'string' ? args.old_string : null, newText }],
        locations: [{ path: args.file_path }],
      }
    },
    presentResult(args, result) {
      if (result.isError) return undefined
      const diffs = result.meta?.diffs
      if (!Array.isArray(diffs) || diffs.length === 0) return undefined
      return { card: 'diff', title: `Propose ${args.file_path}`, diffs }
    },
  }
}

/** What the model reads back: where the change lands, and that the file is untouched. */
function renderProposal(value) {
  const status = value.created
    ? 'new file proposed'
    : 'edit proposed'
  const shape = value.created
    ? `${value.added} lines, 1 hunk`
    : `${value.hunks.length} hunk${value.hunks.length === 1 ? '' : 's'}, -${value.removed} +${value.added}`
  return `<path>${value.path}</path>
<status>${status} 鈥?the file is unchanged; the user applies it by hand</status>
<hunk>${shape}</hunk>
<diff>
${value.diff}
</diff>`
}

/**
 * Resolve the proposal against the file on disk: validate the snippet, compute the proposed
 * text, and describe the hunk. Nothing is written.
 * @param ctx the plugin context.
 * @param args raw tool arguments.
 * @param exec the calling tool execution.
 */
async function planProposal(ctx, args, exec) {
  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
  if (filePath.length === 0) throw new Error('file_path must be a non-empty string')
  const replaceSnippet = typeof args.old_string === 'string'
  const replaceFile = typeof args.content === 'string'
  if (replaceSnippet === replaceFile) {
    throw new Error('pass either old_string and new_string, or content 鈥?exactly one of them')
  }
  const absolute = absolutePath(ctx, exec, filePath)
  const raw = await readIfExists(absolute)
  // Windows checkouts are CRLF: match on a normalized copy so a proposal written with plain
  // newlines still finds its snippet, then restore the file's own endings in the diff.
  const eol = raw !== null && raw.includes("\r\n") ? "\r\n" : "\n"
  const before = raw === null ? null : normalizeEol(raw)

  let after
  if (replaceFile) {
    after = normalizeEol(args.content)
    if (before === after) throw new Error(`${filePath} already has exactly that content`)
  } else {
    const oldString = normalizeEol(args.old_string)
    let newString = args.new_string
    if (oldString.length === 0) throw new Error('old_string must be a non-empty string')
    if (typeof newString !== 'string') throw new Error('new_string is required with old_string (use "" to delete the text)')
    newString = normalizeEol(newString)
    if (oldString === newString) throw new Error('old_string and new_string must differ')
    if (before === null) {
      throw new Error(`${filePath} does not exist; to propose a new file, pass content instead of old_string`)
    }
    const found = occurrences(before, oldString)
    if (found.length === 0) {
      throw new Error(`old_string does not appear in ${filePath}; read the file and copy the exact text, indentation included`)
    }
    if (found.length > 1) {
      const lines = found.map((offset) => lineAt(before, offset)).join(', ')
      throw new Error(`old_string matches ${found.length} places in ${filePath} (lines ${lines}); include more surrounding context so it is unique`)
    }
    const at = found[0]
    after = before.slice(0, at) + newString + before.slice(at + oldString.length)
  }

  const hunks = buildHunks(filePath, before, after, DIFF_CONTEXT)
  if (hunks.length === 0) throw new Error(`${filePath} would be unchanged by this proposal`)
  if (eol === '\r\n') {
    for (const hunk of hunks) {
      if (hunk.oldText !== null) hunk.oldText = hunk.oldText.replace(/\n/g, '\r\n')
      hunk.newText = hunk.newText.replace(/\n/g, '\r\n')
    }
  }
  return { path: filePath, created: before === null, hunks }
}

/** Absolute target: an absolute argument as-is, otherwise relative to the session directory. */
function absolutePath(ctx, exec, filePath) {
  if (isAbsolute(filePath)) return filePath
  const workingDirectory = ctx.get('workingDirectory')
  const directory = workingDirectory !== undefined && exec.agent !== undefined
    ? workingDirectory.get(exec.agent.session)
    : undefined
  return resolvePath(directory ?? process.cwd(), filePath)
}

/** Normalize any line-ending flavour to LF for matching and hunk math. */
function normalizeEol(text) {
  return text.replace(/\r\n/g, "\n")
}

/** File text, or null when the file does not exist yet. */
async function readIfExists(absolute) {
  try {
    return await readFile(absolute, 'utf8')
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return null
    throw error
  }
}
