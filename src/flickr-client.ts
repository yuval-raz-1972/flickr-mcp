import { buildAuthHeader, type Credentials } from './auth.js';
import {
  selectPhotoSizeFromFlickrSizes,
  type FlickrPhotoSize,
  type PhotoImageSize,
} from './photo-size-selection.js';
import { RateLimiter } from './rate-limiter.js';

export type { FlickrPhotoSize, PhotoImageSize } from './photo-size-selection.js';
export { selectPhotoSizeFromFlickrSizes } from './photo-size-selection.js';

const FLICKR_API = 'https://www.flickr.com/services/rest/';

export interface FlickrPhoto {
  id: string;
  title: string;
  description?: string;
  tags?: string;
  url_m?: string;
  url_l?: string;
  url_sq?: string;
  datetaken?: string;
  latitude?: string;
  longitude?: string;
}

export interface FlickrPhotoDetail {
  id: string;
  title: { _content: string };
  description: { _content: string };
  tags: { tag: Array<{ id: string; _content: string; raw: string }> };
  urls: { url: Array<{ type: string; _content: string }> };
  dates: { taken: string; posted: string };
  location?: { latitude: number; longitude: number; country?: { _content: string } };
}

export interface FlickrGroup {
  nsid: string;
  name: string;
  members: number;
  pool_count: number;
}

export interface FlickrAlbum {
  id: string;
  title: { _content: string };
  description: { _content: string };
  photos: number;
  count_photos: number;
}

export interface CreatedFlickrAlbum {
  id: string;
  url: string;
  title: string;
  description: string;
  primaryPhotoId: string;
  photoCount: number;
}

export interface AlbumPhotosAdded {
  albumId: string;
  addedPhotoIds: string[];
  addedCount: number;
}

export interface AlbumPhotoOrder {
  albumId: string;
  photoIds: string[];
  primaryPhotoId: string;
  photoCount: number;
}

/** Thrown when flickr.photosets.addPhoto fails after zero or more earlier photos were added. */
export class AlbumPhotoAddError extends Error {
  readonly albumId: string;
  readonly addedPhotoIds: readonly string[];
  readonly failedPhotoId: string;
  readonly remainingPhotoIds: readonly string[];

  constructor(
    albumId: string,
    addedPhotoIds: readonly string[],
    failedPhotoId: string,
    remainingPhotoIds: readonly string[],
    cause: string
  ) {
    const added =
      addedPhotoIds.length > 0 ? addedPhotoIds.join(', ') : '(none)';
    const remaining =
      remainingPhotoIds.length > 0 ? remainingPhotoIds.join(', ') : '(none)';
    super(
      `Failed to add photo ${failedPhotoId} to album ${albumId}: ${cause}. ` +
        `Added ${addedPhotoIds.length} photo(s): ${added}. ` +
        `Did not attempt ${remainingPhotoIds.length} photo(s): ${remaining}.`
    );
    this.name = 'AlbumPhotoAddError';
    this.albumId = albumId;
    this.addedPhotoIds = addedPhotoIds;
    this.failedPhotoId = failedPhotoId;
    this.remainingPhotoIds = remainingPhotoIds;
  }
}

/**
 * flickr.photosets.addPhoto accepts one photo_id per request, so multi-photo
 * adds are one POST per ID. This is that per-request limit, not a tunable batch size.
 */
export const ALBUM_ADD_PHOTO_BATCH_SIZE = 1;

export function normalizePhotoIdList(photoIds: readonly unknown[], fieldName = 'photo_ids'): string[] {
  if (!Array.isArray(photoIds) || photoIds.length === 0) {
    throw new Error(`${fieldName} must be a non-empty list of Flickr photo IDs.`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  photoIds.forEach((raw, index) => {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) {
      throw new Error(`${fieldName}[${index}] is empty.`);
    }
    if (seen.has(id)) {
      if (!duplicates.includes(id)) duplicates.push(id);
      return;
    }
    seen.add(id);
    normalized.push(id);
  });

  if (duplicates.length > 0) {
    throw new Error(`Duplicate photo IDs in ${fieldName}: ${duplicates.join(', ')}`);
  }

  return normalized;
}

export interface FlickrExifTag {
  tagspace: string;
  label: string;
  raw: { _content: string };
  clean?: { _content: string };
}

export interface PhotoImageBase64Result {
  data: string;
  mimeType: string;
  label: string;
  width: number;
  height: number;
}

export class FlickrClient {
  private limiter = new RateLimiter();
  private creds: Credentials;

  constructor(credentials: Credentials) {
    this.creds = credentials;
  }

  private async call(
    method: string,
    params: Record<string, string> = {},
    httpMethod: 'GET' | 'POST' = 'GET'
  ): Promise<Record<string, unknown>> {
    await this.limiter.consume();

    const reqParams: Record<string, string> = {
      method,
      format: 'json',
      nojsoncallback: '1',
      ...params,
    };

    const authHeader = buildAuthHeader(httpMethod, FLICKR_API, reqParams, {
      consumerKey: this.creds.api_key,
      consumerSecret: this.creds.api_secret,
      tokenKey: this.creds.oauth_token,
      tokenSecret: this.creds.oauth_token_secret,
    });

    let res: Response;
    if (httpMethod === 'GET') {
      const url = new URL(FLICKR_API);
      for (const [k, v] of Object.entries(reqParams)) url.searchParams.set(k, v);
      res = await fetch(url, { headers: { Authorization: authHeader } });
    } else {
      res = await fetch(FLICKR_API, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(reqParams),
      });
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    if (data['stat'] === 'fail') {
      throw new Error(`Flickr error ${data['code']}: ${data['message']}`);
    }
    return data;
  }

  // ─── Photos ───────────────────────────────────────────────────────────────

  async listPhotos(page = 1, perPage = 100): Promise<{ photos: FlickrPhoto[]; total: number; pages: number }> {
    const data = await this.call('flickr.people.getPhotos', {
      user_id: 'me',
      extras: 'url_sq,url_m,url_l,date_taken,tags,description,geo',
      page: String(page),
      per_page: String(Math.min(perPage, 500)),
    });

    const r = data['photos'] as Record<string, unknown>;
    return {
      photos: (r['photo'] as FlickrPhoto[]) ?? [],
      total: Number(r['total']),
      pages: Number(r['pages']),
    };
  }

  async getPhoto(photoId: string): Promise<FlickrPhotoDetail> {
    const data = await this.call('flickr.photos.getInfo', { photo_id: photoId });
    return data['photo'] as FlickrPhotoDetail;
  }

  async searchMyPhotos(
    opts: { text?: string; tags?: string; tagMode?: 'any' | 'all'; page?: number; perPage?: number }
  ): Promise<{ photos: FlickrPhoto[]; total: number; pages: number }> {
    const params: Record<string, string> = {
      user_id: 'me',
      extras: 'url_sq,url_m,url_l,date_taken,tags,description',
      page: String(opts.page ?? 1),
      per_page: String(Math.min(opts.perPage ?? 100, 500)),
    };
    if (opts.text) params['text'] = opts.text;
    if (opts.tags) params['tags'] = opts.tags;
    if (opts.tagMode) params['tag_mode'] = opts.tagMode;

    const data = await this.call('flickr.photos.search', params);
    const r = data['photos'] as Record<string, unknown>;
    return {
      photos: (r['photo'] as FlickrPhoto[]) ?? [],
      total: Number(r['total']),
      pages: Number(r['pages']),
    };
  }

  async getPhotoImageBase64(
    photoId: string,
    imageSize: PhotoImageSize = 'medium'
  ): Promise<PhotoImageBase64Result | null> {
    try {
      const sizesData = await this.call('flickr.photos.getSizes', { photo_id: photoId });
      const raw = (sizesData['sizes'] as Record<string, unknown>)['size'];
      const sizes = (Array.isArray(raw) ? raw : raw ? [raw] : []) as FlickrPhotoSize[];
      const selected = selectPhotoSizeFromFlickrSizes(sizes, imageSize);
      if (!selected?.source) return null;

      await this.limiter.consume(); // image fetch counts against our budget
      const imgRes = await fetch(selected.source);
      if (!imgRes.ok) return null;

      const buffer = await imgRes.arrayBuffer();
      const width = Number(selected.width);
      const height = Number(selected.height);
      return {
        data: Buffer.from(buffer).toString('base64'),
        mimeType: imgRes.headers.get('content-type') ?? 'image/jpeg',
        label: selected.label,
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
      };
    } catch {
      return null;
    }
  }

  // ─── Albums ───────────────────────────────────────────────────────────────

  async getAlbums(page = 1, perPage = 50): Promise<{ albums: FlickrAlbum[]; total: number }> {
    const data = await this.call('flickr.photosets.getList', {
      user_id: this.creds.user_nsid,
      page: String(page),
      per_page: String(Math.min(perPage, 500)),
    });

    const r = data['photosets'] as Record<string, unknown>;
    return {
      albums: (r['photoset'] as FlickrAlbum[]) ?? [],
      total: Number(r['total']),
    };
  }

  async getAlbumPhotos(
    albumId: string,
    page = 1,
    perPage = 100
  ): Promise<{ photos: FlickrPhoto[]; total: number; title: string }> {
    const data = await this.call('flickr.photosets.getPhotos', {
      photoset_id: albumId,
      user_id: this.creds.user_nsid,
      extras: 'url_sq,url_m,url_l,date_taken,tags,description',
      page: String(page),
      per_page: String(Math.min(perPage, 500)),
    });

    const r = data['photoset'] as Record<string, unknown>;
    return {
      photos: (r['photo'] as FlickrPhoto[]) ?? [],
      total: Number(r['total'] ?? 0),
      title: String(r['title'] ?? ''),
    };
  }

  /**
   * WRITE. flickr.photosets.create — new album from an existing photo the caller owns.
   * primary_photo_id is required by Flickr and becomes the album cover and first member.
   */
  async createAlbum(opts: {
    title: string;
    description?: string;
    primaryPhotoId: string;
  }): Promise<CreatedFlickrAlbum> {
    const title = opts.title.trim();
    if (!title) {
      throw new Error('Album title is required.');
    }
    const primaryPhotoId = opts.primaryPhotoId.trim();
    if (!primaryPhotoId) {
      throw new Error('primary_photo_id is required.');
    }

    const params: Record<string, string> = {
      title,
      primary_photo_id: primaryPhotoId,
    };
    const description = opts.description?.trim();
    if (description) {
      params['description'] = description;
    }

    const data = await this.call('flickr.photosets.create', params, 'POST');
    const photoset = data['photoset'] as Record<string, unknown> | undefined;
    const id = photoset ? String(photoset['id'] ?? '') : '';
    if (!id) {
      throw new Error('Flickr photosets.create did not return an album id.');
    }

    return {
      id,
      url: String(photoset?.['url'] ?? ''),
      title,
      description: description ?? '',
      primaryPhotoId,
      photoCount: 1,
    };
  }

  /**
   * WRITE. Append existing photos with flickr.photosets.addPhoto.
   * Flickr accepts one photo per call, so IDs are sent sequentially in the given order.
   * The first failure stops the sequence and reports IDs already added and IDs not attempted.
   */
  async addPhotosToAlbum(albumId: string, photoIds: readonly unknown[]): Promise<AlbumPhotosAdded> {
    const photosetId = albumId.trim();
    if (!photosetId) {
      throw new Error('album_id is required.');
    }
    const ids = normalizePhotoIdList(photoIds);
    const addedPhotoIds: string[] = [];

    for (let index = 0; index < ids.length; index += ALBUM_ADD_PHOTO_BATCH_SIZE) {
      const batch = ids.slice(index, index + ALBUM_ADD_PHOTO_BATCH_SIZE);
      const photoId = batch[0];
      if (batch.length !== ALBUM_ADD_PHOTO_BATCH_SIZE || !photoId) {
        throw new Error(`Internal error: album add batch at index ${index} was not a single photo ID.`);
      }
      try {
        await this.call(
          'flickr.photosets.addPhoto',
          { photoset_id: photosetId, photo_id: photoId },
          'POST'
        );
        addedPhotoIds.push(photoId);
      } catch (error) {
        const cause = error instanceof Error ? error.message : String(error);
        throw new AlbumPhotoAddError(
          photosetId,
          addedPhotoIds,
          photoId,
          ids.slice(index + batch.length),
          cause
        );
      }
    }

    return {
      albumId: photosetId,
      addedPhotoIds,
      addedCount: addedPhotoIds.length,
    };
  }

  /**
   * WRITE. flickr.photosets.editPhotos replaces album membership with photoIds
   * in that exact order. primary_photo_id is required and must be one of those IDs.
   * When omitted, the first ID is the primary (cover) photo.
   */
  async setAlbumPhotoOrder(
    albumId: string,
    photoIds: readonly unknown[],
    primaryPhotoId?: string
  ): Promise<AlbumPhotoOrder> {
    const photosetId = albumId.trim();
    if (!photosetId) {
      throw new Error('album_id is required.');
    }
    const ids = normalizePhotoIdList(photoIds);
    const primary = (primaryPhotoId ?? '').trim() || ids[0];
    if (!ids.includes(primary)) {
      throw new Error(`primary_photo_id ${primary} must appear in photo_ids.`);
    }

    await this.call(
      'flickr.photosets.editPhotos',
      {
        photoset_id: photosetId,
        primary_photo_id: primary,
        photo_ids: ids.join(','),
      },
      'POST'
    );

    return {
      albumId: photosetId,
      photoIds: ids,
      primaryPhotoId: primary,
      photoCount: ids.length,
    };
  }

  // ─── EXIF ─────────────────────────────────────────────────────────────────

  async getExif(photoId: string): Promise<FlickrExifTag[]> {
    const data = await this.call('flickr.photos.getExif', { photo_id: photoId });
    const photo = data['photo'] as Record<string, unknown>;
    return (photo['exif'] as FlickrExifTag[]) ?? [];
  }

  // ─── Write operations ─────────────────────────────────────────────────────

  async addTags(photoId: string, tags: string[]): Promise<void> {
    const tagStr = tags.map(t => (t.includes(' ') ? `"${t}"` : t)).join(' ');
    await this.call('flickr.photos.addTags', { photo_id: photoId, tags: tagStr }, 'POST');
  }

  async removeTag(photoId: string, tagText: string): Promise<string | null> {
    const photo = await this.getPhoto(photoId);
    const match = photo.tags?.tag?.find(
      t => t._content.toLowerCase() === tagText.toLowerCase() ||
           t.raw.toLowerCase() === tagText.toLowerCase()
    );
    if (!match) return null;
    await this.call('flickr.photos.removeTag', { tag_id: match.id }, 'POST');
    return match.id;
  }

  async setMetadata(photoId: string, title: string, description: string): Promise<void> {
    await this.call(
      'flickr.photos.setMeta',
      { photo_id: photoId, title, description },
      'POST'
    );
  }

  // ─── Groups ───────────────────────────────────────────────────────────────

  async searchGroups(query: string, perPage = 10): Promise<{ groups: FlickrGroup[]; total: number }> {
    const data = await this.call('flickr.groups.search', {
      text: query,
      per_page: String(Math.min(perPage, 500)),
    });
    const r = data['groups'] as Record<string, unknown>;
    const raw = (r['group'] as Array<Record<string, unknown>>) ?? [];
    return {
      groups: raw.map(g => ({
        nsid: String(g['nsid']),
        name: String(g['name']),
        members: Number(g['members']),
        pool_count: Number(g['pool_count']),
      })),
      total: Number(r['total']),
    };
  }

  async getPhotoGroups(photoId: string): Promise<Array<{ id: string; title: string }>> {
    const data = await this.call('flickr.photos.getAllContexts', { photo_id: photoId });
    const pools = (data['pool'] as Array<Record<string, unknown>>) ?? [];
    return pools.map(p => ({ id: String(p['id']), title: String(p['title']) }));
  }

  async addToGroup(photoId: string, groupId: string): Promise<void> {
    await this.call('flickr.groups.pools.add', { photo_id: photoId, group_id: groupId }, 'POST');
  }

  async joinGroup(groupId: string): Promise<void> {
    await this.call('flickr.groups.join', { group_id: groupId, accept_rules: '1' }, 'POST');
  }
}
