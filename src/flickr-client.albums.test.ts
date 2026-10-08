import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from './auth.js';
import { FlickrClient } from './flickr-client.js';

const TEST_NSID = '84286966@N06';

const testCreds: Credentials = {
  api_key: 'test_api_key',
  api_secret: 'test_api_secret',
  oauth_token: 'test_oauth_token',
  oauth_token_secret: 'test_oauth_token_secret',
  user_nsid: TEST_NSID,
  username: 'testuser',
};

function userIdFromRequestUrl(url: string | URL): string | null {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return parsed.searchParams.get('user_id');
}

function methodFromRequestUrl(url: string | URL): string | null {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  return parsed.searchParams.get('method');
}

function mockFlickrFetch(body: Record<string, unknown>) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ stat: 'ok', ...body }),
  });
}

describe('FlickrClient album methods user_id', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('getAlbums sends the authenticated user NSID', async () => {
    const fetchMock = mockFlickrFetch({
      photosets: { photoset: [], total: '0', page: '1', pages: '1' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    const result = await client.getAlbums(2, 100);

    expect(result.albums).toEqual([]);
    expect(result.total).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(methodFromRequestUrl(url)).toBe('flickr.photosets.getList');
    expect(userIdFromRequestUrl(url)).toBe(TEST_NSID);
    expect(userIdFromRequestUrl(url)).not.toBe('me');
  });

  it('getAlbumPhotos sends the authenticated user NSID', async () => {
    const fetchMock = mockFlickrFetch({
      photoset: {
        id: '72177720335958383',
        title: '2026-09-16-Whale Whatching',
        photo: [{ id: '1', title: 'a' }],
        total: '1',
        page: '1',
        pages: '1',
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    const result = await client.getAlbumPhotos('72177720335958383', 1, 50);

    expect(result.photos).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(methodFromRequestUrl(url)).toBe('flickr.photosets.getPhotos');
    expect(userIdFromRequestUrl(url)).toBe(TEST_NSID);
    expect(userIdFromRequestUrl(url)).not.toBe('me');
  });

  it('listPhotos still sends user_id me', async () => {
    const fetchMock = mockFlickrFetch({
      photos: { photo: [], total: '0', page: '1', pages: '1' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    await client.listPhotos(1, 50);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(methodFromRequestUrl(url)).toBe('flickr.people.getPhotos');
    expect(userIdFromRequestUrl(url)).toBe('me');
  });

  it('searchMyPhotos still sends user_id me', async () => {
    const fetchMock = mockFlickrFetch({
      photos: { photo: [], total: '0', page: '1', pages: '1' },
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    await client.searchMyPhotos({ text: 'yale', page: 1, perPage: 25 });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(methodFromRequestUrl(url)).toBe('flickr.photos.search');
    expect(userIdFromRequestUrl(url)).toBe('me');
  });
});
