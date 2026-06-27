// FlowMap — map each interactive CONTROL in a React/JSX component to the OUTCOME its handler
// produces (toast / redirect / modal / service call), by reading the source's AST.
//
// Why this exists: when an LLM (or a person) writes an end-to-end test, the hard question is
// "I clicked THIS button — what is supposed to happen?". The result to assert (a success toast,
// a redirect, a row appearing) is usually NOT visible in a DOM snapshot, because toasts are
// transient and redirects haven't happened yet. The naive fix — grep the file for every
// `toast(...)` / `router.push(...)` string and hand them to the model — fails on any non-trivial
// component: a page with Save, Delete, and Upgrade buttons yields a dozen unrelated strings, and
// the model asserts the wrong one (e.g. the *upsell* redirect as the success of *saving* a record).
//
// FlowMap resolves the chain that regex can't:
//     control (onClick={handler})  →  the handler's body  →  the toast/redirect/calls INSIDE it
// so every action gets ITS OWN outcome. That single fact removes a whole class of wrong assertions.
//
// Design choices that make it cheap and portable:
//  • It uses the TARGET PROJECT's own TypeScript compiler, resolved at runtime from the project dir
//    (like a test runner resolves the project's own tooling). No heavy bundled dependency, and the
//    parse matches the project's TS exactly. If the project has no `typescript`, it falls back to a
//    `typescript` reachable from this module, and returns null if neither exists.
//  • It is SINGLE-FILE and best-effort. A handler that resolves to a prop or import (its real body
//    lives in another file/hook) is marked `external` with NO invented outcome — a shallow-but-
//    correct mapping beats a confident-but-wrong one. Cross-file resolution is intentionally future
//    work; the value here is correctness of what it does report.
//
// Zero dependencies beyond Node's `module` and a `typescript` resolvable at runtime.

import { createRequire } from 'module'

export interface FlowOutcome {
  toast?: { message: string; kind: 'success' | 'error' | 'info' | 'warning' }
  redirect?: string
  opensModal?: boolean   // handler calls setShowX(true)/setOpen(true) — opens a panel/modal
}

export interface FlowAction {
  control: string        // best locator hint for the triggering control (testid / visible text / aria-label)
  by: 'testid' | 'text' | 'label'
  handler: string        // handler name, or '(inline)'
  external: boolean      // handler is a prop/import — its real outcome lives in another file
  outcomes: FlowOutcome
  calls: string[]        // notable calls in the handler (services, other handlers) — intent, not assert
}

// Resolve the PROJECT's typescript (a TS project always has it), so this stays dependency-free.
function resolveTs(cwd: string): typeof import('typescript') | null {
  try {
    const req = createRequire(import.meta.url)
    const p = req.resolve('typescript', { paths: [cwd] })
    return req(p)
  } catch {
    try { const req = createRequire(import.meta.url); return req('typescript') } catch { return null }
  }
}

const HANDLER_ATTRS = new Set(['onClick', 'onSubmit', 'onPress', 'onChange'])

/**
 * Build a FlowMap from a component's source.
 * @param sourceCode the .tsx/.jsx source as a string (null → returns null)
 * @param cwd        the project directory, used to resolve the project's own `typescript`
 * @returns one FlowAction per interactive control, or null if TS can't be resolved / parsed
 */
export function buildFlowMap(sourceCode: string | null, cwd: string): FlowAction[] | null {
  if (!sourceCode) return null
  const ts = resolveTs(cwd)
  if (!ts) return null

  let sf
  try {
    sf = ts.createSourceFile('component.tsx', sourceCode, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.TSX)
  } catch { return null }

  // 1. Index top-level handler declarations by name: `function f(){}` and `const f = (...) => {}`.
  const decls = new Map<string, import('typescript').Node>()
  const propNames = new Set<string>()   // component params/destructured props — handlers that are external
  const visitTop = (node: import('typescript').Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) decls.set(node.name.text, node)
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
          decls.set(d.name.text, d.initializer)
        }
      }
    }
    // Destructured props at component scope: `({ onAddItem, onPrintMenu }) => …` or `const { x } = props`
    if (ts.isParameter(node) && ts.isObjectBindingPattern(node.name)) {
      for (const el of node.name.elements) if (ts.isIdentifier(el.name)) propNames.add(el.name.text)
    }
    ts.forEachChild(node, visitTop)
  }
  visitTop(sf)

  // 2. Walk JSX for handler attributes and build an action per control.
  const actions: FlowAction[] = []
  const seen = new Set<string>()

  const visit = (node: import('typescript').Node) => {
    if (ts.isJsxAttribute(node) && node.name && ts.isIdentifier(node.name) && HANDLER_ATTRS.has(node.name.text)) {
      const init = node.initializer
      if (init && ts.isJsxExpression(init) && init.expression) {
        const { handler, external, body } = resolveHandler(init.expression, ts, decls, propNames)
        const owner = findOwnerElement(node, ts)
        const label = owner ? controlLabel(owner, ts) : null
        if (label) {
          const outcomes: FlowOutcome = {}
          const calls: string[] = []
          if (body) extractOutcomes(body, ts, outcomes, calls)
          const key = label.value + '|' + handler
          if (!seen.has(key)) {
            seen.add(key)
            actions.push({ control: label.value, by: label.by, handler, external, outcomes, calls: dedupe(calls).slice(0, 6) })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return actions
}

// Resolve a handler expression: an inline arrow → its body; an identifier → the declared function's
// body (or external if it's a prop / not found here).
function resolveHandler(expr: import('typescript').Node, ts: typeof import('typescript'), decls: Map<string, import('typescript').Node>, propNames: Set<string>): { handler: string; external: boolean; body: import('typescript').Node | null } {
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return { handler: '(inline)', external: false, body: expr.body }
  if (ts.isIdentifier(expr)) {
    const name = expr.text
    const decl = decls.get(name)
    if (decl) return { handler: name, external: false, body: ts.isFunctionDeclaration(decl) ? (decl.body ?? null) : ((decl as import('typescript').ArrowFunction).body ?? null) }
    return { handler: name, external: propNames.has(name) || true, body: null }   // prop/import → outcome elsewhere
  }
  // e.g. onClick={() => setActiveTab(id)} already handled; member calls (handleX.bind) → name best-effort
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return { handler: expr.expression.text, external: true, body: null }
  return { handler: '(inline)', external: false, body: ts.isArrowFunction(expr) ? expr.body : null }
}

// Pull toast/redirect/modal/service signals out of a handler body.
function extractOutcomes(body: import('typescript').Node, ts: typeof import('typescript'), out: FlowOutcome, calls: string[]): void {
  const str = (n: import('typescript').Node | undefined): string | null => {
    if (!n) return null
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
    return null
  }
  const walk = (n: import('typescript').Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression
      // toast.success('x') | toast('x') | showToast('x') | enqueueSnackbar('x', {variant})
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
        const obj = callee.expression.text
        const method = callee.name.text
        if (/^(toast|message|notify|sonner)$/i.test(obj) && /^(success|error|info|warning|warn)$/i.test(method)) {
          const m = str(n.arguments[0])
          if (m && !out.toast) out.toast = { message: m, kind: method.toLowerCase().startsWith('warn') ? 'warning' : (method.toLowerCase() as 'success' | 'error' | 'info') }
        } else if (/^router$/.test(obj) && /^(push|replace)$/.test(method)) {
          const r = str(n.arguments[0]); if (r && !out.redirect) out.redirect = r
        } else {
          calls.push(obj + '.' + method)
        }
      } else if (ts.isIdentifier(callee)) {
        const fn = callee.text
        if (/^(toast|showToast|enqueueSnackbar|notify|addToast)$/i.test(fn)) {
          const m = str(n.arguments[0]); if (m && !out.toast) out.toast = { message: m, kind: classifyVariant(n, ts) }
        } else if (/^(navigate|redirect|push)$/.test(fn)) {
          const r = str(n.arguments[0]); if (r && !out.redirect) out.redirect = r
        } else if (/^set[A-Z]/.test(fn)) {
          // setShowX(true)/setOpen(true) → opens a panel/modal
          const a = n.arguments[0]
          if (a && a.kind === ts.SyntaxKind.TrueKeyword && /show|open|modal|dialog|drawer|panel/i.test(fn)) out.opensModal = true
        } else {
          calls.push(fn)
        }
      }
    }
    ts.forEachChild(n, walk)
  }
  walk(body)
}

function classifyVariant(call: import('typescript').CallExpression, ts: typeof import('typescript')): 'success' | 'error' | 'info' | 'warning' {
  // second arg { variant: 'error' } or 'error'
  const a2 = call.arguments[1]
  if (a2) {
    const t = a2.getText()
    if (/error|warn/i.test(t)) return /warn/i.test(t) ? 'warning' : 'error'
    if (/success/i.test(t)) return 'success'
  }
  const msg = call.arguments[0] && (ts.isStringLiteral(call.arguments[0]) ? call.arguments[0].text : '')
  if (msg && /error|fail|invalid|required|wrong|denied|too\s+(weak|short)/i.test(msg)) return 'error'
  return 'info'
}

// The JSX element that owns this attribute.
function findOwnerElement(attr: import('typescript').Node, ts: typeof import('typescript')): import('typescript').Node | null {
  let n: import('typescript').Node | undefined = attr.parent   // JsxAttributes
  while (n && !(ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n))) n = n.parent
  return n ?? null
}

// Best locator for the control: data-testid > visible text > aria-label.
function controlLabel(el: import('typescript').Node, ts: typeof import('typescript')): { value: string; by: 'testid' | 'text' | 'label' } | null {
  const opening = ts.isJsxElement(el) ? el.openingElement : (el as import('typescript').JsxSelfClosingElement)
  const attrs = opening.attributes.properties
  const getAttr = (name: string): string | null => {
    for (const a of attrs) {
      if (ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === name && a.initializer && ts.isStringLiteral(a.initializer)) return a.initializer.text
    }
    return null
  }
  const testid = getAttr('data-testid')
  if (testid) return { value: testid, by: 'testid' }
  if (ts.isJsxElement(el)) {
    const text = el.children.map((c) => (ts.isJsxText(c) ? c.text : '')).join(' ').replace(/\s+/g, ' ').trim()
    if (text && text.length <= 40) return { value: text, by: 'text' }
  }
  const aria = getAttr('aria-label')
  if (aria) return { value: aria, by: 'label' }
  return null
}

function dedupe(a: string[]): string[] { return [...new Set(a)] }
