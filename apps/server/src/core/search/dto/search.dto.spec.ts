import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SearchDTO } from './search.dto';

// `creatorId` reaches `pages.creator_id = $1` (a uuid column): a non-uuid value
// must be a 400 at the boundary, not a Postgres 22P02 answered as a 500.
async function creatorIdErrors(creatorId: unknown) {
  const dto = plainToInstance(SearchDTO, { query: 'plan', creatorId });
  const errors = await validate(dto as object);
  return errors.some((e) => e.property === 'creatorId');
}

describe('SearchDTO creatorId validation', () => {
  it('accepts a user UUID', async () => {
    expect(await creatorIdErrors('019f499a-9f8c-7d68-b7be-ce100d7c6c56')).toBe(
      false,
    );
  });

  it('accepts an absent creatorId', async () => {
    expect(await creatorIdErrors(undefined)).toBe(false);
  });

  it('rejects a non-uuid creatorId', async () => {
    expect(await creatorIdErrors('x')).toBe(true);
  });
});
