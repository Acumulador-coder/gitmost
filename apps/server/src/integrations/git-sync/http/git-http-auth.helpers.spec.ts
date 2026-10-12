// Unit tests for the framework-free /git auth helpers: the failed-login limiter
// (driven with an explicit `now`, so no timers are involved), the HTTP-Basic
// header parser and the client-IP extractor.
import {
  clientIp,
  FailedLoginLimiter,
  parseBasicAuth,
} from './git-http-auth.helpers';

/** The limiter's private bucket map, for the sweep assertions. */
function bucketsOf(limiter: FailedLoginLimiter): Map<string, unknown> {
  return (limiter as unknown as { buckets: Map<string, unknown> }).buckets;
}

describe('FailedLoginLimiter', () => {
  it('reserves exactly `threshold` attempts per window, then blocks', () => {
    const limiter = new FailedLoginLimiter(3, 1000);
    expect(limiter.tryReserve('k', 0)).toBe(true);
    expect(limiter.tryReserve('k', 10)).toBe(true);
    expect(limiter.tryReserve('k', 20)).toBe(true);
    expect(limiter.tryReserve('k', 30)).toBe(false);
    // Keys are independent.
    expect(limiter.tryReserve('other', 30)).toBe(true);
  });

  it('a window expires exactly windowMs after it started', () => {
    const limiter = new FailedLoginLimiter(2, 1000);
    expect(limiter.tryReserve('k', 0)).toBe(true);
    expect(limiter.tryReserve('k', 0)).toBe(true);
    // Still inside the window that started at 0.
    expect(limiter.tryReserve('k', 999)).toBe(false);
    // A fresh window from 1000 on.
    expect(limiter.tryReserve('k', 1000)).toBe(true);
    expect(limiter.tryReserve('k', 1000)).toBe(true);
    expect(limiter.tryReserve('k', 1000)).toBe(false);
  });

  it('sweep removes only the expired buckets', () => {
    const limiter = new FailedLoginLimiter(1, 1000);
    limiter.tryReserve('old', 0);
    limiter.tryReserve('fresh', 500);

    limiter.sweep(1000);

    const buckets = bucketsOf(limiter);
    expect(buckets.has('old')).toBe(false);
    expect(buckets.has('fresh')).toBe(true);
    // The kept bucket still carries its count: it is still blocked.
    expect(limiter.tryReserve('fresh', 1000)).toBe(false);
  });

  it('release undoes one reservation and never goes below 0', () => {
    const limiter = new FailedLoginLimiter(2, 1000);
    // Releasing an untouched key must not bank negative credit.
    limiter.release('k', 0);
    limiter.release('k', 0);
    limiter.release('k', 0);
    expect(limiter.tryReserve('k', 0)).toBe(true);
    expect(limiter.tryReserve('k', 0)).toBe(true);
    expect(limiter.tryReserve('k', 0)).toBe(false);
    // One release frees exactly one slot.
    limiter.release('k', 0);
    expect(limiter.tryReserve('k', 0)).toBe(true);
    expect(limiter.tryReserve('k', 0)).toBe(false);
  });

  it('reset clears the key', () => {
    const limiter = new FailedLoginLimiter(1, 1000);
    expect(limiter.tryReserve('k', 0)).toBe(true);
    expect(limiter.tryReserve('k', 0)).toBe(false);
    limiter.reset('k');
    expect(limiter.tryReserve('k', 0)).toBe(true);
  });
});

describe('parseBasicAuth', () => {
  const basic = (raw: string) =>
    'Basic ' + Buffer.from(raw, 'utf8').toString('base64');

  it('accepts an empty password (`a@b:`)', () => {
    expect(parseBasicAuth(basic('a@b:'))).toEqual({
      email: 'a@b',
      password: '',
    });
  });

  it('splits on the FIRST colon only', () => {
    expect(parseBasicAuth(basic('a@b:p:w'))).toEqual({
      email: 'a@b',
      password: 'p:w',
    });
  });

  it('rejects an empty email (`:pw`)', () => {
    expect(parseBasicAuth(basic(':pw'))).toBeNull();
  });

  it('rejects a value without a colon (`nocolon`)', () => {
    expect(parseBasicAuth(basic('nocolon'))).toBeNull();
  });

  it('rejects a non-Basic scheme (`Bearer x`) and a missing header', () => {
    expect(parseBasicAuth('Bearer x')).toBeNull();
    expect(parseBasicAuth(undefined)).toBeNull();
  });
});

describe('clientIp', () => {
  it('prefers the framework-parsed req.ip', () => {
    expect(
      clientIp({
        ip: '10.0.0.1',
        socket: { remoteAddress: '10.0.0.2' },
        headers: { 'x-forwarded-for': '10.0.0.3' },
      }),
    ).toBe('10.0.0.1');
  });

  it('falls back to the socket peer', () => {
    expect(
      clientIp({
        socket: { remoteAddress: '10.0.0.2' },
        headers: { 'x-forwarded-for': '10.0.0.3' },
      }),
    ).toBe('10.0.0.2');
  });

  it('falls back to the first x-forwarded-for hop', () => {
    expect(
      clientIp({ headers: { 'x-forwarded-for': ' 10.0.0.3 , 10.0.0.4' } }),
    ).toBe('10.0.0.3');
  });

  it("returns 'unknown' when no source is present", () => {
    expect(clientIp({ headers: {} })).toBe('unknown');
    expect(clientIp({ socket: {}, headers: { 'x-forwarded-for': '' } })).toBe(
      'unknown',
    );
  });
});
