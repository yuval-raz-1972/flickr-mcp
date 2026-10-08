import { describe, expect, it, vi } from 'vitest';
import type { FlickrClient } from './flickr-client.js';
import { AlbumPhotoAddError } from './flickr-client.js';
import { TOOLS, handleTool } from './tools.js';

const READ_ALBUM_TOOLS = {
  flickr_get_albums: {
    description:
      'List your Flickr albums (photosets) with their titles, descriptions, and photo counts. The response includes the current page number and total page count. If the user wants all albums, call repeatedly incrementing page until all pages are fetched.',
    required: undefined,
  },
  flickr_get_album_photos: {
    description:
      'List the photos inside a specific album. The response includes the current page number and total page count. If the user wants all photos in the album, call repeatedly incrementing page until all pages are fetched.',
    required: ['album_id'],
  },
} as const;

function toolByName(name: string) {
  const tool = TOOLS.find(entry => entry.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe('album write tool schemas', () => {
  it('registers write tools with the Flickr album arguments', () => {
    const create = toolByName('flickr_create_album');
    const add = toolByName('flickr_add_album_photos');
    const order = toolByName('flickr_set_album_photo_order');

    for (const tool of [create, add, order]) {
      expect(tool.description.startsWith('WRITE OPERATION.')).toBe(true);
    }

    expect(create.inputSchema).toMatchObject({
      required: ['title', 'primary_photo_id'],
    });
    expect(add.inputSchema).toMatchObject({
      required: ['album_id', 'photo_ids'],
    });
    expect(order.inputSchema).toMatchObject({
      required: ['album_id', 'photo_ids'],
    });
    expect(create.description).toContain('flickr.photosets.create');
    expect(add.description).toContain('flickr.photosets.addPhoto');
    expect(order.description).toContain('flickr.photosets.editPhotos');
  });

  it('leaves the existing album read tools unchanged', () => {
    for (const [name, expected] of Object.entries(READ_ALBUM_TOOLS)) {
      const tool = toolByName(name);
      expect(tool.description).toBe(expected.description);
      expect((tool.inputSchema as { required?: string[] }).required).toEqual(expected.required);
      expect(tool.description.includes('WRITE OPERATION')).toBe(false);
    }
  });
});

describe('album write tool handlers', () => {
  it('returns the created album id and photo count', async () => {
    const client = {
      createAlbum: vi.fn().mockResolvedValue({
        id: '72177720335958383',
        url: 'https://www.flickr.com/photos/testuser/sets/72177720335958383/',
        title: 'USA Trip 2026',
        description: 'Chronological trip album',
        primaryPhotoId: '55540591042',
        photoCount: 1,
      }),
    } as unknown as FlickrClient;

    const result = await handleTool(
      'flickr_create_album',
      {
        title: 'USA Trip 2026',
        description: 'Chronological trip album',
        primary_photo_id: '55540591042',
      },
      client
    );

    expect(client.createAlbum).toHaveBeenCalledWith({
      title: 'USA Trip 2026',
      description: 'Chronological trip album',
      primaryPhotoId: '55540591042',
    });
    expect(result.isError).toBeUndefined();
    const body = result.content[0];
    expect(body).toMatchObject({ type: 'text' });
    if (body.type === 'text') {
      expect(body.text).toContain('Album ID: 72177720335958383');
      expect(body.text).toContain('Photos in album: 1');
      expect(body.text).not.toContain('test_api_secret');
    }
  });

  it('passes photo IDs through in order and surfaces add failures', async () => {
    const client = {
      addPhotosToAlbum: vi
        .fn()
        .mockRejectedValue(
          new AlbumPhotoAddError('55', ['100'], '20', ['3'], 'Flickr error 2: Photo not found')
        ),
    } as unknown as FlickrClient;

    const result = await handleTool(
      'flickr_add_album_photos',
      { album_id: '55', photo_ids: ['100', '20', '3'] },
      client
    );

    expect(client.addPhotosToAlbum).toHaveBeenCalledWith('55', ['100', '20', '3']);
    expect(result.isError).toBe(true);
    const body = result.content[0];
    if (body.type === 'text') {
      expect(body.text).toContain('Failed to add photo 20');
      expect(body.text).toContain('Did not attempt 1 photo(s): 3');
      expect(body.text.startsWith('Error:')).toBe(true);
      expect(body.text.includes('[WRITE] Added')).toBe(false);
    }
  });

  it('rejects a missing photo list before calling the client', async () => {
    const client = {
      addPhotosToAlbum: vi.fn(),
      setAlbumPhotoOrder: vi.fn(),
    } as unknown as FlickrClient;

    const addResult = await handleTool('flickr_add_album_photos', { album_id: '55' }, client);
    const orderResult = await handleTool('flickr_set_album_photo_order', { album_id: '55' }, client);

    expect(addResult.isError).toBe(true);
    expect(orderResult.isError).toBe(true);
    expect(client.addPhotosToAlbum).not.toHaveBeenCalled();
    expect(client.setAlbumPhotoOrder).not.toHaveBeenCalled();
  });

  it('asks the client to preserve the supplied album order', async () => {
    const client = {
      setAlbumPhotoOrder: vi.fn().mockResolvedValue({
        albumId: '55',
        photoIds: ['100', '20', '3'],
        primaryPhotoId: '100',
        photoCount: 3,
      }),
    } as unknown as FlickrClient;

    const result = await handleTool(
      'flickr_set_album_photo_order',
      { album_id: '55', photo_ids: ['100', '20', '3'] },
      client
    );

    expect(client.setAlbumPhotoOrder).toHaveBeenCalledWith('55', ['100', '20', '3'], undefined);
    const body = result.content[0];
    if (body.type === 'text') {
      expect(body.text).toContain('Order: 100, 20, 3');
      expect(body.text).toContain('Photo count: 3');
      expect(body.text).toContain('Primary photo ID: 100');
    }
  });

  it('still lists albums and album photos through the read client methods', async () => {
    const client = {
      getAlbums: vi.fn().mockResolvedValue({
        albums: [
          {
            id: '55',
            title: { _content: 'Existing' },
            description: { _content: '' },
            photos: 2,
            count_photos: 2,
          },
        ],
        total: 1,
      }),
      getAlbumPhotos: vi.fn().mockResolvedValue({
        photos: [{ id: '100', title: 'First' }],
        total: 1,
        title: 'Existing',
      }),
      createAlbum: vi.fn(),
      addPhotosToAlbum: vi.fn(),
      setAlbumPhotoOrder: vi.fn(),
    } as unknown as FlickrClient;

    const albums = await handleTool('flickr_get_albums', { page: 2, per_page: 25 }, client);
    const photos = await handleTool(
      'flickr_get_album_photos',
      { album_id: '55', page: 1, per_page: 10 },
      client
    );

    expect(client.getAlbums).toHaveBeenCalledWith(2, 25);
    expect(client.getAlbumPhotos).toHaveBeenCalledWith('55', 1, 10);
    expect(client.createAlbum).not.toHaveBeenCalled();
    expect(client.addPhotosToAlbum).not.toHaveBeenCalled();
    expect(client.setAlbumPhotoOrder).not.toHaveBeenCalled();
    const albumText = albums.content[0];
    const photoText = photos.content[0];
    if (albumText.type === 'text') expect(albumText.text).toContain('ID: 55');
    if (photoText.type === 'text') expect(photoText.text).toContain('ID: 100');
  });
});
