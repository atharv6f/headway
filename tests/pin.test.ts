import { expect, test } from 'claude-code/testing'
import { absolutePath, parsePinArgs, readFailure } from '../plugin/hooks/pin.ts'

const CWD = '/home/dev/project'

test('a pin is a file, a quoted section and rule tokens', async () => {
  const r = parsePinArgs('plan/release-table.md "Release 2 tasks" column=landed partial=published', CWD)
  expect(r).toEqual({
    ok: true,
    filter: { file: CWD + '/plan/release-table.md', section: 'Release 2 tasks', doneRule: 'column=landed', partial: 'published' },
    typed: { file: 'plan/release-table.md' },
  })
})

test('the section and every rule are optional; auto, check= and groups= are read', async () => {
  expect(parsePinArgs('/abs/plan.md', CWD)).toEqual({ ok: true, filter: { file: '/abs/plan.md' }, typed: { file: '/abs/plan.md' } })
  expect(parsePinArgs('/abs/plan.md auto', CWD)).toEqual({ ok: true, filter: { file: '/abs/plan.md', doneRule: 'auto' }, typed: { file: '/abs/plan.md' } })
  expect(parsePinArgs('p.md check=verified groups=groups.json', CWD)).toEqual({
    ok: true,
    filter: { file: CWD + '/p.md', doneRule: 'check=verified', groupMap: CWD + '/groups.json' },
    typed: { file: 'p.md', groupMap: 'groups.json' },
  })
})

test('the section may come after the rules', async () => {
  const r = parsePinArgs('p.md column=live "Release 2 tasks"', CWD)
  expect(r).toEqual({ ok: true, filter: { file: CWD + '/p.md', section: 'Release 2 tasks', doneRule: 'column=live' }, typed: { file: 'p.md' } })
})

test('no file, a second quoted token, an empty rule or an unknown token is refused', async () => {
  for (const bad of ['', '   ', '"Release 2"', 'p.md "a" "b"', 'p.md column=', 'p.md banana', 'p.md "unclosed']) {
    const r = parsePinArgs(bad, CWD)
    expect(r.ok).toBe(false)
  }
  expect(parsePinArgs('p.md banana', CWD)).toEqual({ ok: false, error: 'unknown argument: banana' })
})

test('paths are made absolute against the cwd', async () => {
  expect(absolutePath('/a/b', 'c/d.md')).toBe('/a/b/c/d.md')
  expect(absolutePath('/a/b', './c.md')).toBe('/a/b/c.md')
  expect(absolutePath('/a/b', '../c.md')).toBe('/a/c.md')
  expect(absolutePath('/a/b/', 'c.md')).toBe('/a/b/c.md')
  expect(absolutePath('/a/b', '/x/y.md')).toBe('/x/y.md')
  // Windows-style paths: either separator, the drive kept, `.` and `..` resolved, never above the drive
  expect(absolutePath('C:\\Users\\u\\proj', 'plan\\p.md')).toBe('C:\\Users\\u\\proj\\plan\\p.md')
  expect(absolutePath('C:\\Users\\u\\proj', '..\\.claude/plans\\.\\x.md')).toBe('C:\\Users\\u\\.claude\\plans\\x.md')
  expect(absolutePath('/a/b', 'D:/w/x.md')).toBe('D:\\w\\x.md')
  expect(absolutePath('C:\\a\\b', '\\x\\y.md')).toBe('C:\\x\\y.md')
  expect(absolutePath('c:\\', '..\\..\\x.md')).toBe('c:\\x.md')
})

test('a read failure is a plain sentence with the path as typed', async () => {
  expect(readFailure(new Error('headway: $.fs.read(/w/nope.md) failed: ENOENT'), 'nope.md')).toBe('file not found: nope.md')
  expect(readFailure(Object.assign(new Error('x'), { code: 'ENOENT' }), '../nope.md')).toBe('file not found: ../nope.md')
  expect(readFailure(new Error('headway: $.fs.read(/w/p.md) failed: EACCES'), 'p.md')).toBe('cannot read p.md')
  expect(readFailure('boom', 'p.md')).toBe('cannot read p.md')
})
