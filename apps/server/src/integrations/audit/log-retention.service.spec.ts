import { purgeInBatches, retentionCutoff } from './log-retention.service';
import { EnvironmentService } from '../environment/environment.service';

describe('retentionCutoff', () => {
  it('subtracts whole days', () => {
    const now = new Date('2026-11-12T00:00:00Z');
    expect(retentionCutoff(180, now).toISOString()).toBe('2026-05-16T00:00:00.000Z');
    expect(retentionCutoff(1, now).toISOString()).toBe('2026-11-11T00:00:00.000Z');
  });
});

describe('purgeInBatches', () => {
  it('stops at the first short batch and reports completion', async () => {
    const sizes = [5, 5, 2];
    const del = jest.fn(async () => sizes.shift() ?? 0);
    expect(await purgeInBatches(del, { batchSize: 5, maxBatches: 10 })).toEqual({ deleted: 12, complete: true });
    expect(del).toHaveBeenCalledTimes(3);
  });

  it('stops at the cap and leaves the rest for the next run', async () => {
    const del = jest.fn(async () => 5);
    expect(await purgeInBatches(del, { batchSize: 5, maxBatches: 3 })).toEqual({ deleted: 15, complete: false });
    expect(del).toHaveBeenCalledTimes(3);
  });

  it('does one query when nothing is old enough', async () => {
    const del = jest.fn(async () => 0);
    expect(await purgeInBatches(del)).toEqual({ deleted: 0, complete: true });
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe('EnvironmentService.getApiAccessLogRetentionDays', () => {
  const env = (value?: string) =>
    new EnvironmentService({ get: (_k: string, def: string) => (value === undefined ? def : value) } as any);

  it('defaults to 180', () => expect(env().getApiAccessLogRetentionDays()).toBe(180));
  it('reads a number, 0 meaning keep forever', () => {
    expect(env('30').getApiAccessLogRetentionDays()).toBe(30);
    expect(env('0').getApiAccessLogRetentionDays()).toBe(0);
  });
  it('falls back to 180 on garbage or negatives', () => {
    expect(env('abc').getApiAccessLogRetentionDays()).toBe(180);
    expect(env('-5').getApiAccessLogRetentionDays()).toBe(180);
  });
});
