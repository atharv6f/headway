// hand-written workflow script (SPEC 16, flow): two phases, three labelled agent() calls, one with a
// template label, one without model/effort, one inside parallel
export const text: string = `export const meta = { name: 'flow', description: 'Build then verify', phases: ['Build', 'Verify'] }
const built = await agent('Reply ok', { label: 'build core', phase: 'Build', model: 'haiku', effort: 'low' })
const checks = await parallel([
  () => agent('Reply ok', { label: \`verify \${built}\`, phase: 'Verify', model: 'haiku', effort: 'low' }),
  () => agent('Reply ok', { label: 'verify docs', phase: 'Verify' }),
])
return [built, checks]
`

// the same shape with object phases and no phases at all
export const objects: string = text.replace("phases: ['Build', 'Verify']", "phases: [{ title: 'Build' }, { title: 'Verify' }]")
export const bare: string = text.replace(", phases: ['Build', 'Verify']", '').replace(/, phase: '\w+'/g, '')
