# FlowMap

**Map every interactive control in a React/JSX component to the outcome it actually produces — by reading the AST, not guessing.**

FlowMap answers the one question that makes or breaks an auto-generated end-to-end test:

> "I clicked **this** button — what is supposed to happen?"

It resolves, statically, the chain:

```
control  (onClick={handleUpgrade})
   │
   ▼  resolve the handler's body
handleUpgrade() {
   toast.info('Redirecting to upgrade page...')   ──►  toast outcome
   router.push('/upgrade')                         ──►  redirect outcome
}
```

…and emits one compact record per control:

```jsonc
{
  "control": "Upgrade to Pro",          // the locator hint (testid > visible text > aria-label)
  "by": "text",
  "handler": "handleUpgrade",
  "external": false,
  "outcomes": {
    "toast": { "message": "Redirecting to upgrade page...", "kind": "info" },
    "redirect": "/upgrade"
  },
  "calls": []
}
```

Zero runtime dependencies of its own — it borrows the **target project's own** `typescript` compiler at runtime.

---

## Why this exists

When an LLM writes a Playwright/Cypress test, the *action* is easy ("click Save"); the **assertion** is the hard part. The expected result — a success toast, a redirect, a new row — is almost never visible in a DOM snapshot, because toasts are transient and redirects haven't happened yet.

The obvious shortcut is to grep the source for every `toast(...)` / `router.push(...)` string and feed them to the model. **This fails on any real component.** A page with Save, Delete, and Upgrade buttons produces a dozen unrelated strings, and the model confidently asserts the wrong one — e.g. asserting the *upsell* redirect (`/upgrade`) as the success of *saving a menu item*. (We shipped that bug. It's why FlowMap exists.)

Regex can find the strings but **cannot tell which control owns which outcome**:

```tsx
<Button onClick={saveMenu}>Save</Button>

async function saveMenu() {
  await api.createMenu()
  toast.success('Menu created')      // belongs to Save
  if (isTrial) router.push('/upgrade')  // an edge of Save — NOT the Upgrade button
}
```

An AST walks `onClick → saveMenu → the calls inside saveMenu`, so each control's assertion uses **its own** result. That single fact removes a whole class of wrong assertions.

---

## What it detects

Inside each resolved handler body:

| Outcome | Patterns recognised |
| --- | --- |
| **toast** | `toast.success('…')`, `toast.error/info/warning(…)`, bare `toast('…')`, `showToast`, `enqueueSnackbar('…', { variant })`, `notify`, `addToast`, `message.*`, `sonner.*`. Kind is inferred from the method, the `variant` arg, or the message wording. |
| **redirect** | `router.push('…')` / `router.replace('…')`, and bare `navigate/redirect/push('…')`. |
| **opensModal** | `setShowX(true)` / `setOpen(true)` / `setModal…(true)` — a state setter that opens a panel/dialog/drawer. |
| **calls** | Other notable calls in the handler (e.g. `menuService.create`) — surfaced as *intent*, not something to assert. |

Each control is located by the best available hook: **`data-testid` > visible text > `aria-label`**, with `by` telling you which, so a consumer emits the matching locator (`getByTestId` vs `getByText` vs `getByLabel`).

### Honest about its limits

- **Single-file.** A handler passed in as a prop or imported from a hook (its body lives in another file) is reported with `external: true` and **no invented outcome**. A shallow-but-correct mapping beats a confident-but-wrong one. Cross-file/hook resolution is future work.
- **Static literals only.** `router.push(dynamicVar)` yields no redirect string (it can't be known statically) rather than a wrong guess.
- It reports controls, not a full state machine. Multi-step wizards are out of scope.

---

## Usage

```ts
import { buildFlowMap, type FlowAction } from './flowmap.js'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/app/admin/page.tsx', 'utf8')
const actions = buildFlowMap(source, process.cwd())   // cwd = the project dir (to find its typescript)

if (actions) {
  for (const a of actions) {
    console.log(a.control, '→', a.outcomes)
  }
}
```

`buildFlowMap(sourceCode, cwd)` returns `FlowAction[]`, or `null` if the source is empty or no `typescript` can be resolved (it tries the project at `cwd` first, then its own).

### Run the demo

```bash
npx tsx demo.mts
```

```
[text] "Upgrade to Pro" → handleUpgrade  ⇒ redirect=/upgrade, toast[info]="Redirecting to upgrade page..."
[testid] "save-item" → handleSave  ⇒ toast[success]="Menu item saved!"   calls: menuService.create
[text] "Add Item" → onAddItem (external)
[text] "Logout" → handleLogout   calls: signOut
```

---

## Feeding it to an LLM

The whole point is to inject these outcomes into a test-generation prompt **scoped per control**, so the model never cross-applies one control's result to another:

```
CONTROL → OUTCOME MAP (the real result of clicking each control; assert it ONLY for that control):
- The control with text "Upgrade to Pro" → navigates to "/upgrade" (assert toHaveURL); shows an info toast "Redirecting to upgrade page..."
- The control with testid 'save-item'    → shows a success toast "Menu item saved!"
A control not listed has no statically-known outcome — assert the visible UI change. Never invent a toast/redirect.
```

Filter to `external === false` and to actions that actually have an outcome (`toast || redirect || opensModal`) before injecting, so the prompt stays tight and trustworthy.

This is also a **token win**: instead of pasting an entire monolithic component into the prompt, you pass a handful of compact control→outcome lines.

---

## Status & roadmap

Built and validated as part of [lacuna](https://github.com/Octagon-simon/lacuna) (an AI test-generation CLI), where it feeds the `--e2e` generation prompt. Candidate enhancements:

1. **Cross-file handler resolution** — follow a prop/imported handler into its hook/file (lifts most `external` entries).
2. **Validation extraction** — pull Zod/`min`/`max`/`required` rules from a handler to generate negative-path assertions with exact error strings.
3. **Framework breadth** — Vue/Svelte handler conventions; `window.location` redirects; more toast libraries.
4. **Feature boundaries** — segment a monolithic page (tabs/sections) so each region maps independently.

PRs and pattern contributions welcome.

## License

MIT.
