// hand-written `report` sequences (SPEC 16): the tool inputs of 4.3 and what each one must give
export const noIds = { title: 'Fruit files', tasks: [{ title: 'Create a.txt' }, { title: 'Create b.txt' }, { title: 'List them' }] }

export const withIds = {
  title: 'Release',
  tasks: [
    { id: 'R1', title: 'Tag', status: 'done' },
    { id: 'R2', title: 'Publish', status: 'partial' },
    { id: 'R3', title: 'Announce' },
  ],
}

export const mixedIds = { tasks: [{ id: 'B', title: 'first' }, { title: 'second' }, { title: 'third', status: 'done' }] }

export const duplicateIds = { tasks: [{ id: 'A', title: 'one' }, { id: 'A', title: 'two' }] }

export const unknownUpdate = { updates: [{ id: 'R3', status: 'partial' }, { id: 'R9', status: 'done' }] }

export const doneIds = { done: ['R2', 'R3'] }

export const both = { tasks: [{ title: 'x' }], updates: [{ id: '1', status: 'done' }] }
