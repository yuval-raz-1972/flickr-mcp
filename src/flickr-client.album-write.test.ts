import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Credentials } from './auth.js';
import { AlbumPhotoAddError, FlickrClient } from './flickr-client.js';

const testCreds: Credentials = {
  api_key: 'test_api_key',
  api_secret: 'test_api_secret',
  oauth_token: 'test_oauth_token',
  oauth_token_secret: 'test_oauth_token_secret',
  user_nsid: '84286966@N06',
  username: 'testuser',
};

interface RecordedRequest {
  httpMethod: string;
  apiMethod: string | null;
  params: URLSearchParams;
}

function recordedRequest(call: unknown[]): RecordedRequest {
  const [url, init] = call as [string, { method?: string; body?: URLSearchParams | string } | undefined];
  const httpMethod = init?.method ?? 'GET';
  if (httpMethod === 'GET') {
    const parsed = new URL(String(url));
    return {
      httpMethod,
      apiMethod: parsed.searchParams.get('method'),
      params: parsed.searchParams,
    };
  }
  const body = init?.body;
  const params =
    body instanceof URLSearchParams ? body : new URLSearchParams(typeof body === 'string' ? body : '');
  return { httpMethod, apiMethod: params.get('method'), params };
}

function jsonResponse(body: Record<string, unknown>, ok = true) {
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  };
}

describe('FlickrClient album writes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createAlbum posts flickr.photosets.create with title, description, and primary photo', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        photoset: {
          id: '72177720335958383',
          url: 'https://www.flickr.com/photos/testuser/sets/72177720335958383/',
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    const result = await client.createAlbum({
      title: 'USA Trip 2026',
      description: 'Chronological trip album',
      primaryPhotoId: '55540591042',
    });

    expect(result).toEqual({
      id: '72177720335958383',
      url: 'https://www.flickr.com/photos/testuser/sets/72177720335958383/',
      title: 'USA Trip 2026',
      description: 'Chronological trip album',
      primaryPhotoId: '55540591042',
      photoCount: 1,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = recordedRequest(fetchMock.mock.calls[0]);
    expect(request.httpMethod).toBe('POST');
    expect(request.apiMethod).toBe('flickr.photosets.create');
    expect(request.params.get('title')).toBe('USA Trip 2026');
    expect(request.params.get('description')).toBe('Chronological trip album');
    expect(request.params.get('primary_photo_id')).toBe('55540591042');
    expect(request.params.get('api_key')).toBeNull();
    expect(request.params.get('oauth_token')).toBeNull();
  });

  it('createAlbum omits description when it is not provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ photoset: { id: '99', url: 'https://www.flickr.com/photos/testuser/sets/99/' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    await client.createAlbum({ title: 'Cover only', primaryPhotoId: '42' });

    const request = recordedRequest(fetchMock.mock.calls[0]);
    expect(request.params.get('description')).toBeNull();
    expect(request.params.get('primary_photo_id')).toBe('42');
  });

  it('addPhotosToAlbum posts one flickr.photosets.addPhoto per ID in order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    const photoIds = ['100', '20', '3'];
    const result = await client.addPhotosToAlbum('72177720335958383', photoIds);

    expect(result).toEqual({
      albumId: '72177720335958383',
      addedPhotoIds: photoIds,
      addedCount: 3,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const requests = fetchMock.mock.calls.map(call => recordedRequest(call));
    expect(requests.map(request => request.apiMethod)).toEqual([
      'flickr.photosets.addPhoto',
      'flickr.photosets.addPhoto',
      'flickr.photosets.addPhoto',
    ]);
    expect(requests.map(request => request.httpMethod)).toEqual(['POST', 'POST', 'POST']);
    expect(requests.map(request => request.params.get('photoset_id'))).toEqual([
      '72177720335958383',
      '72177720335958383',
      '72177720335958383',
    ]);
    expect(requests.map(request => request.params.get('photo_id'))).toEqual(photoIds);
  });

  it('setAlbumPhotoOrder posts flickr.photosets.editPhotos in the supplied chronology', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    const photoIds = ['100', '20', '3'];
    const result = await client.setAlbumPhotoOrder('72177720335958383', photoIds);

    expect(result).toEqual({
      albumId: '72177720335958383',
      photoIds,
      primaryPhotoId: '100',
      photoCount: 3,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = recordedRequest(fetchMock.mock.calls[0]);
    expect(request.httpMethod).toBe('POST');
    expect(request.apiMethod).toBe('flickr.photosets.editPhotos');
    expect(request.params.get('photoset_id')).toBe('72177720335958383');
    expect(request.params.get('primary_photo_id')).toBe('100');
    expect(request.params.get('photo_ids')).toBe('100,20,3');
  });

  it('setAlbumPhotoOrder keeps list order when an explicit primary photo is not first', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    const result = await client.setAlbumPhotoOrder('55', ['100', '20', '3'], '20');

    expect(result.photoIds).toEqual(['100', '20', '3']);
    expect(result.primaryPhotoId).toBe('20');
    const request = recordedRequest(fetchMock.mock.calls[0]);
    expect(request.params.get('photo_ids')).toBe('100,20,3');
    expect(request.params.get('primary_photo_id')).toBe('20');
  });

  it('rejects duplicate photo IDs and empty inputs before calling Flickr', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new FlickrClient(testCreds);

    await expect(client.createAlbum({ title: '  ', primaryPhotoId: '1' })).rejects.toThrow(
      'Album title is required.'
    );
    await expect(client.createAlbum({ title: 'Trip', primaryPhotoId: '  ' })).rejects.toThrow(
      'primary_photo_id is required.'
    );
    await expect(client.addPhotosToAlbum('  ', ['1'])).rejects.toThrow('album_id is required.');
    await expect(client.addPhotosToAlbum('9', [])).rejects.toThrow(
      'photo_ids must be a non-empty list of Flickr photo IDs.'
    );
    await expect(client.addPhotosToAlbum('9', ['1', '  '])).rejects.toThrow('photo_ids[1] is empty.');
    await expect(client.addPhotosToAlbum('9', ['1', '2', '1'])).rejects.toThrow(
      'Duplicate photo IDs in photo_ids: 1'
    );
    await expect(client.setAlbumPhotoOrder('9', [])).rejects.toThrow(
      'photo_ids must be a non-empty list of Flickr photo IDs.'
    );
    await expect(client.setAlbumPhotoOrder('9', ['4', '4'])).rejects.toThrow(
      'Duplicate photo IDs in photo_ids: 4'
    );
    await expect(client.setAlbumPhotoOrder('9', ['4', '5'], '6')).rejects.toThrow(
      'primary_photo_id 6 must appear in photo_ids.'
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops adding photos on the first Flickr error and does not attempt the rest', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}))
      .mockResolvedValueOnce(jsonResponse({ stat: 'fail', code: 2, message: 'Photo not found' }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    const error = await client.addPhotosToAlbum('55', ['100', '20', '3']).catch(caught => caught);

    expect(error).toBeInstanceOf(AlbumPhotoAddError);
    expect(error).toMatchObject({
      albumId: '55',
      addedPhotoIds: ['100'],
      failedPhotoId: '20',
      remainingPhotoIds: ['3'],
    });
    expect((error as Error).message).toContain('Flickr error 2: Photo not found');
    expect((error as Error).message).toContain('Did not attempt 1 photo(s): 3');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordedRequest(fetchMock.mock.calls[1]).params.get('photo_id')).toBe('20');
  });

  it('getAlbums and getAlbumPhotos stay on the read methods', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ photosets: { photoset: [], total: '0', page: '1', pages: '1' } })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          photoset: { id: '55', title: 'Existing', photo: [], total: '0', page: '1', pages: '1' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const client = new FlickrClient(testCreds);
    await client.getAlbums(1, 50);
    await client.getAlbumPhotos('55', 1, 50);

    expect(fetchMock.mock.calls.map(call => recordedRequest(call).apiMethod)).toEqual([
      'flickr.photosets.getList',
      'flickr.photosets.getPhotos',
    ]);
  });
});
