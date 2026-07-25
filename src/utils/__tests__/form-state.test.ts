import { stableSerialize } from '@/utils/form-state';

describe('stableSerialize', () => {
  it('ignores the order a selection set was assembled in', () => {
    // The transaction and recurring sheets rebuild `tagIds` by filter-then-append,
    // so removing a tag and adding it back reverses the array. That used to read as
    // an unsaved edit and prompted to discard changes the user never made.
    expect(stableSerialize({ tagIds: ['b', 'a'] })).toBe(stableSerialize({ tagIds: ['a', 'b'] }));
    expect(stableSerialize({ selectedCategories: ['x', 'y', 'z'] }))
      .toBe(stableSerialize({ selectedCategories: ['z', 'x', 'y'] }));
  });

  it('ignores object key insertion order', () => {
    expect(stableSerialize({ categoryLimits: { b: '10', a: '20' } }))
      .toBe(stableSerialize({ categoryLimits: { a: '20', b: '10' } }));
  });

  it('still reports genuine edits', () => {
    expect(stableSerialize({ tagIds: ['a', 'b'] })).not.toBe(stableSerialize({ tagIds: ['a'] }));
    expect(stableSerialize({ tagIds: ['a', 'b'] })).not.toBe(stableSerialize({ tagIds: ['a', 'c'] }));
    expect(stableSerialize({ categoryLimits: { a: '20' } }))
      .not.toBe(stableSerialize({ categoryLimits: { a: '21' } }));
    expect(stableSerialize({ name: 'Rent' })).not.toBe(stableSerialize({ name: 'rent' }));
  });

  it('does not conflate a missing field with an empty one', () => {
    expect(stableSerialize({ note: '' })).not.toBe(stableSerialize({}));
    expect(stableSerialize({ note: null })).not.toBe(stableSerialize({ note: '' }));
    expect(stableSerialize({ tagIds: [] })).not.toBe(stableSerialize({ tagIds: [''] }));
  });

  it('keeps the order of arrays holding objects, which would be ordered lists', () => {
    expect(stableSerialize([{ id: 'b' }, { id: 'a' }]))
      .not.toBe(stableSerialize([{ id: 'a' }, { id: 'b' }]));
  });

  it('does not let a key collide with a value across field boundaries', () => {
    expect(stableSerialize({ a: 'b:c' })).not.toBe(stableSerialize({ 'a:b': 'c' }));
    expect(stableSerialize({ note: '["x"]' })).not.toBe(stableSerialize({ note: ['x'] }));
  });

  it('handles undefined and nested structures', () => {
    expect(stableSerialize(undefined)).toBe('null');
    expect(stableSerialize({ filters: { tagIds: ['b', 'a'], accountIds: [] } }))
      .toBe(stableSerialize({ filters: { accountIds: [], tagIds: ['a', 'b'] } }));
  });
});
