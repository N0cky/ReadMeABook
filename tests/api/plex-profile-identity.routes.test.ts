/**
 * Component: Plex Profile Identity Route Tests
 * Documentation: documentation/backend/services/auth.md
 *
 * Profile switching and the single-profile callback take the user's identity from Plex
 * (the Plex Home user list, or /users/account), never from the request, and only ever
 * write a Plex user's row. A small in-memory users table stands in for Prisma so each
 * test can check which row was written and that the others are untouched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPlexIdentity } from '@/lib/services/auth/plex-identity';

type Row = { id: string; plexId: string; plexUsername: string; role: string; authProvider: string | null; plexHomeUserId?: string | null; [k: string]: unknown };

const users = vi.hoisted(() => new Map<string, Record<string, any>>());
const prismaMock = vi.hoisted(() => ({
  user: {
    count: vi.fn(async () => users.size),
    findUnique: vi.fn(async ({ where }: any) => {
      const row = users.get(where.plexId);
      return row ? { ...row } : null;
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      const existing = users.get(where.plexId);
      const row = existing ? { ...existing, ...update } : { id: `id-${where.plexId}`, authProvider: null, ...create };
      users.set(where.plexId, row);
      return { ...row };
    }),
  },
}));
const plexServiceMock = vi.hoisted(() => ({
  checkPin: vi.fn(),
  getUserInfo: vi.fn(),
  verifyServerAccess: vi.fn(),
  getHomeUsers: vi.fn(),
  switchHomeUser: vi.fn(),
}));
const tokenCache = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), delete: vi.fn() }));
const accessTokenFor = vi.hoisted(() => vi.fn((payload: any) => `jwt-for-${payload.plexId}-${payload.role}`));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/integrations/plex.service', () => ({ getPlexService: () => plexServiceMock }));
vi.mock('@/lib/services/encryption.service', () => ({ getEncryptionService: () => ({ encrypt: (v: string) => `enc-${v}` }) }));
vi.mock('@/lib/services/config.service', () => ({
  getConfigService: () => ({ getPlexConfig: async () => ({ serverUrl: 'http://plex', authToken: 't', machineIdentifier: 'm' }) }),
}));
vi.mock('@/lib/services/auth-token-cache.service', () => ({ getAuthTokenCache: () => tokenCache }));
vi.mock('@/lib/utils/jwt', () => ({ generateAccessToken: accessTokenFor, generateRefreshToken: () => 'refresh' }));

const ADMIN: Row = { id: 'admin-row', plexId: '1001', plexUsername: 'owner', role: 'admin', authProvider: null };
const SETUP_ADMIN: Row = { id: 'local-row', plexId: 'local-admin', plexUsername: 'admin', role: 'admin', authProvider: 'plex', isSetupAdmin: true };
const OIDC_USER: Row = { id: 'oidc-row', plexId: 'abc123', plexUsername: 'carol', role: 'admin', authProvider: 'oidc' };

// The caller's own Plex Home: main account + a managed profile
const HOME = [
  { id: '2001', uuid: 'aaaa1111bbbb2222', title: 'Main', friendlyName: 'Main', username: 'main', email: 'main@example.com', thumb: '/main.png' },
  { id: '2002', uuid: 'cccc3333dddd4444', title: 'Kid', friendlyName: 'Kid', username: '', email: '', thumb: '/kid.png' },
];

function seed(...rows: Row[]) {
  users.clear();
  for (const row of rows) users.set(row.plexId, { ...row });
}
const snapshot = (plexId: string) => JSON.stringify(users.get(plexId));

async function switchProfile(body: Record<string, unknown>) {
  const { POST } = await import('@/app/api/auth/plex/switch-profile/route');
  const response = await POST({ json: async () => ({ pinId: 'pin-1', ...body }) } as any);
  return { status: response.status, payload: await response.json() };
}

describe('Plex profile switch identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed(ADMIN, SETUP_ADMIN, OIDC_USER);
    tokenCache.get.mockReturnValue('main-token');
    plexServiceMock.getHomeUsers.mockResolvedValue(HOME);
    plexServiceMock.switchHomeUser.mockImplementation(async (id: string) => `profile-token-${id}`);
  });

  it.each([
    ["another user's plexId", '1001'],
    ["the Plex-mode setup admin's local id", 'local-admin'],
    ['an OIDC account id', 'abc123'],
  ])('ignores %s sent as profileInfo.uuid and signs in as the selected Home user', async (_label, spoofed) => {
    const before = [snapshot('1001'), snapshot('local-admin'), snapshot('abc123')];

    const { status, payload } = await switchProfile({
      userId: '2002',
      profileInfo: { uuid: spoofed, friendlyName: 'Owner', email: 'owner@example.com', thumb: '/x' },
    });

    expect(status).toBe(200);
    expect(payload.user).toMatchObject({ plexId: 'cccc3333dddd4444', username: 'Kid', role: 'user' });
    expect(payload.accessToken).toBe('jwt-for-cccc3333dddd4444-user');
    expect([snapshot('1001'), snapshot('local-admin'), snapshot('abc123')]).toEqual(before);
    expect(prismaMock.user.upsert).toHaveBeenCalledTimes(1);
    expect(prismaMock.user.upsert.mock.calls[0][0].where).toEqual({ plexId: 'cccc3333dddd4444' });
  });

  it('refuses a userId that is not one of the Home users, before switching', async () => {
    const before = snapshot('1001');

    const { status, payload } = await switchProfile({ userId: '9999', profileInfo: { uuid: '1001' } });

    expect(status).toBe(403);
    expect(payload).toEqual({ error: 'AccessDenied', message: expect.stringContaining('cannot be used to sign in') });
    expect(plexServiceMock.switchHomeUser).not.toHaveBeenCalled();
    expect(prismaMock.user.upsert).not.toHaveBeenCalled();
    expect(snapshot('1001')).toBe(before);
  });

  it.each([
    ['a local-* id', 'local-admin'],
    ['an id that is not a Plex id', '../1001'],
    ['an empty uuid', ''],
  ])('refuses a Home entry whose uuid is %s', async (_label, uuid) => {
    plexServiceMock.getHomeUsers.mockResolvedValue([{ ...HOME[1], uuid }]);
    const before = snapshot('local-admin');

    const { status } = await switchProfile({ userId: '2002', profileInfo: {} });

    expect(status).toBe(403);
    expect(prismaMock.user.upsert).not.toHaveBeenCalled();
    expect(snapshot('local-admin')).toBe(before);
  });

  it('refuses when the Plex identity already belongs to a local or OIDC account', async () => {
    plexServiceMock.getHomeUsers.mockResolvedValue([{ ...HOME[1], uuid: 'abc123' }]);
    const before = snapshot('abc123');

    const { status } = await switchProfile({ userId: '2002', profileInfo: {} });

    expect(status).toBe(403);
    expect(prismaMock.user.upsert).not.toHaveBeenCalled();
    expect(snapshot('abc123')).toBe(before);
  });

  it('a managed profile signs in with its Plex name and avatar and a profile token', async () => {
    const { status, payload } = await switchProfile({ userId: '2002', pin: '1234', profileInfo: { uuid: 'cccc3333dddd4444' } });

    expect(status).toBe(200);
    expect(plexServiceMock.switchHomeUser).toHaveBeenCalledWith('2002', 'main-token', '1234');
    expect(users.get('cccc3333dddd4444')).toMatchObject({
      plexUsername: 'Kid', avatarUrl: '/kid.png', plexHomeUserId: '2002', authToken: 'enc-profile-token-2002', role: 'user',
    });
    expect(payload.user.role).toBe('user');
  });

  it('the main account switch updates its existing row and keeps its role', async () => {
    seed(ADMIN, { id: 'main-row', plexId: 'aaaa1111bbbb2222', plexUsername: 'old', role: 'admin', authProvider: null });

    const { status, payload } = await switchProfile({ userId: 2001, profileInfo: { uuid: 'aaaa1111bbbb2222' } });

    expect(status).toBe(200);
    expect(payload.user).toMatchObject({ id: 'main-row', plexId: 'aaaa1111bbbb2222', username: 'Main', role: 'admin' });
    expect(prismaMock.user.upsert.mock.calls[0][0].update).not.toHaveProperty('role');
  });

  it('a client without profileInfo is keyed on the account id Plex returns for the profile token', async () => {
    plexServiceMock.getUserInfo.mockResolvedValue({ id: 3002, username: 'kid-account', email: undefined, thumb: undefined });

    const { status, payload } = await switchProfile({ userId: '2002' });

    expect(status).toBe(200);
    expect(plexServiceMock.getUserInfo).toHaveBeenCalledWith('profile-token-2002');
    expect(payload.user.plexId).toBe('3002');
  });
});

describe('Plex callback (single profile) identity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seed(ADMIN, SETUP_ADMIN, OIDC_USER);
    plexServiceMock.checkPin.mockResolvedValue('main-token');
    plexServiceMock.verifyServerAccess.mockResolvedValue(true);
    plexServiceMock.getHomeUsers.mockResolvedValue([HOME[0]]);
  });

  async function callback() {
    const { GET } = await import('@/app/api/auth/plex/callback/route');
    const response = await GET({ nextUrl: new URL('http://localhost/api/auth/plex/callback?pinId=1'), headers: { get: () => null } } as any);
    return { status: response.status, payload: await response.json() };
  }

  it('refuses a Plex account id that already belongs to an OIDC account', async () => {
    plexServiceMock.getUserInfo.mockResolvedValue({ id: 'abc123', username: 'someone' });
    const before = snapshot('abc123');

    const { status } = await callback();

    expect(status).toBe(403);
    expect(prismaMock.user.upsert).not.toHaveBeenCalled();
    expect(snapshot('abc123')).toBe(before);
  });

  it('signs in a Plex account by the id Plex returns', async () => {
    plexServiceMock.getUserInfo.mockResolvedValue({ id: 1001, username: 'owner' });

    const { status, payload } = await callback();

    expect(status).toBe(200);
    expect(payload.user).toMatchObject({ id: 'admin-row', plexId: '1001', role: 'admin' });
  });
});

describe('isPlexIdentity', () => {
  it.each(['1001', 'aaaa1111bbbb2222', 'abc-123'])('accepts %s', (id) => expect(isPlexIdentity(id)).toBe(true));
  it.each(['', 'local-admin', 'LOCAL-admin', '../x', 'a b', 'x'.repeat(129), 42, null])('refuses %s', (id) =>
    expect(isPlexIdentity(id)).toBe(false)
  );
});
