// #2930 Product paths: structured logger preparation and the schedule editor.
import { expect, it } from 'vitest';
import { prepareFields, normalizePaths } from '../../../../packages/session-shared/src/logger/prepare';
import { secret } from '../../../../packages/session-shared/src/secret';

it('preserves repeated log objects without losing cycle protection',()=>{const shared={status:'failed',token:secret('test-value')};const error=new Error('failed');const data={request:shared,retry:shared,errors:[error,error]};const prepared=prepareFields(data) as typeof data;expect(prepared.retry).toEqual({status:'failed',token:'[REDACTED]'});expect(prepared.errors[1]).toMatchObject({message:'failed'});const cycle:unknown[]=[];cycle.push(cycle);expect(prepareFields(cycle)).toEqual(['[Circular]']);error.cause=error;expect(prepareFields(error)).toMatchObject({cause:'[Circular]'});});
