// Runnable demo: `npx tsx demo.mts` (or compile + run with node).
// Shows FlowMap resolving control → outcome on a representative component with multiple buttons —
// the case where grep-the-file approaches misattribute outcomes.

import { buildFlowMap } from './flowmap.ts'

const sample = `
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

export default function AdminPage({ onAddItem }: { onAddItem: () => void }) {
  const router = useRouter()

  function handleUpgrade() {
    toast.info('Redirecting to upgrade page...')
    router.push('/upgrade')
  }

  const handleSave = async () => {
    await menuService.create()
    toast.success('Menu item saved!')
  }

  const handleLogout = () => signOut()   // imported — body lives elsewhere

  return (
    <div>
      <button onClick={handleUpgrade}>Upgrade to Pro</button>
      <button onClick={handleSave} data-testid="save-item">Save</button>
      <button onClick={onAddItem}>Add Item</button>
      <button aria-label="Sign out" onClick={handleLogout}>Logout</button>
    </div>
  )
}
`

const map = buildFlowMap(sample, process.cwd())
if (!map) {
  console.error('Could not resolve a typescript compiler from this directory.')
  process.exit(1)
}

for (const a of map) {
  const out: string[] = []
  if (a.outcomes.redirect) out.push(`redirect=${a.outcomes.redirect}`)
  if (a.outcomes.toast) out.push(`toast[${a.outcomes.toast.kind}]=${JSON.stringify(a.outcomes.toast.message)}`)
  if (a.outcomes.opensModal) out.push('opensModal')
  console.log(
    `[${a.by}] ${JSON.stringify(a.control)} → ${a.handler}${a.external ? ' (external)' : ''}` +
      (out.length ? `  ⇒ ${out.join(', ')}` : '') +
      (a.calls.length ? `   calls: ${a.calls.join(', ')}` : ''),
  )
}

// Expected output — note that the "/upgrade" outcome is attributed ONLY to "Upgrade to Pro",
// and "Menu item saved!" ONLY to Save. "Add Item" resolves to a prop (external) so it gets NO
// invented outcome. Visible text wins over aria-label, so the last button is located by "Logout":
//
// [text]  "Upgrade to Pro" → handleUpgrade  ⇒ redirect=/upgrade, toast[info]="Redirecting to upgrade page..."
// [testid] "save-item"     → handleSave     ⇒ toast[success]="Menu item saved!"   calls: menuService.create
// [text]  "Add Item"       → onAddItem (external)
// [text]  "Logout"         → handleLogout   calls: signOut
