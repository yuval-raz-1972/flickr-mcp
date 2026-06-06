import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { FlickrClient } from './flickr-client.js';

export type { CallToolResult };

function text(s: string): CallToolResult {
  return { content: [{ type: 'text', text: s }] };
}

function err(s: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${s}` }], isError: true };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: 'flickr_list_photos',
    description:
      "List photos from your Flickr photostream. Returns photo IDs, titles, tags, and thumbnail URLs. Use this to discover what photos exist before getting details or making edits.",
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number (default: 1)' },
        per_page: {
          type: 'number',
          description: 'Photos per page, 1–500 (default: 50)',
        },
      },
    },
  },
  {
    name: 'flickr_get_photo',
    description:
      "Get full details for a single photo: title, description, all tags with their IDs, dates, and location. Optionally include the photo image as base64 so any LLM can visually analyse it.",
    inputSchema: {
      type: 'object',
      properties: {
        photo_id: { type: 'string', description: 'Flickr photo ID' },
        include_image: {
          type: 'boolean',
          description:
            'If true, fetch and return the photo as a base64 image (medium size). Enables visual analysis. Default: false.',
        },
      },
      required: ['photo_id'],
    },
  },
  {
    name: 'flickr_get_exif',
    description:
      'Get the EXIF/camera metadata for a photo: camera model, lens, shutter speed, aperture, ISO, GPS coordinates, etc. Useful context for generating accurate tags and descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        photo_id: { type: 'string', description: 'Flickr photo ID' },
      },
      required: ['photo_id'],
    },
  },
  {
    name: 'flickr_search_my_photos',
    description:
      "Search your own photos by keyword, tags, or both. Only searches your own library — never other users' photos.",
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Full-text search against title, description, and tags' },
        tags: { type: 'string', description: 'Comma-separated tags to filter by' },
        tag_mode: {
          type: 'string',
          enum: ['any', 'all'],
          description: 'Whether photos must match any or all of the given tags (default: any)',
        },
        page: { type: 'number', description: 'Page number (default: 1)' },
        per_page: { type: 'number', description: 'Results per page, 1–500 (default: 50)' },
      },
    },
  },
  {
    name: 'flickr_get_albums',
    description: 'List your Flickr albums (photosets) with their titles, descriptions, and photo counts.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'number', description: 'Page number (default: 1)' },
        per_page: { type: 'number', description: 'Albums per page, 1–500 (default: 50)' },
      },
    },
  },
  {
    name: 'flickr_get_album_photos',
    description: 'List the photos inside a specific album.',
    inputSchema: {
      type: 'object',
      properties: {
        album_id: { type: 'string', description: 'The album (photoset) ID' },
        page: { type: 'number', description: 'Page number (default: 1)' },
        per_page: { type: 'number', description: 'Photos per page, 1–500 (default: 50)' },
      },
      required: ['album_id'],
    },
  },
  {
    name: 'flickr_add_tags',
    description:
      'Add tags to a photo. When dry_run is true (the default), returns a preview of what would be added without making any changes — use this to confirm with the user before writing.',
    inputSchema: {
      type: 'object',
      properties: {
        photo_id: { type: 'string', description: 'Flickr photo ID' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to add. Multi-word tags are handled automatically.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Preview mode — show what would happen without writing. Default: true.',
        },
      },
      required: ['photo_id', 'tags'],
    },
  },
  {
    name: 'flickr_remove_tag',
    description:
      'Remove a tag from a photo by its text. When dry_run is true (the default), returns a preview without making changes.',
    inputSchema: {
      type: 'object',
      properties: {
        photo_id: { type: 'string', description: 'Flickr photo ID' },
        tag: { type: 'string', description: 'The tag text to remove' },
        dry_run: {
          type: 'boolean',
          description: 'Preview mode — show what would happen without writing. Default: true.',
        },
      },
      required: ['photo_id', 'tag'],
    },
  },
  {
    name: 'flickr_set_metadata',
    description:
      'Set the title and/or description of a photo. When dry_run is true (the default), returns a preview of the changes without writing them.',
    inputSchema: {
      type: 'object',
      properties: {
        photo_id: { type: 'string', description: 'Flickr photo ID' },
        title: { type: 'string', description: 'New title (omit to keep existing)' },
        description: { type: 'string', description: 'New description (omit to keep existing)' },
        dry_run: {
          type: 'boolean',
          description: 'Preview mode — show what would happen without writing. Default: true.',
        },
      },
      required: ['photo_id'],
    },
  },
];

// ─── Tool handlers ────────────────────────────────────────────────────────────

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: FlickrClient
): Promise<CallToolResult> {
  try {
    switch (name) {
      case 'flickr_list_photos': {
        const page = Number(args['page'] ?? 1);
        const perPage = Number(args['per_page'] ?? 50);
        const result = await client.listPhotos(page, perPage);

        const lines = result.photos.map(p =>
          `ID: ${p.id} | Title: ${p.title}${p.tags ? ` | Tags: ${p.tags}` : ''}${p.url_m ? ` | URL: ${p.url_m}` : ''}`
        );
        return text(
          `Page ${page}/${result.pages} — ${result.total} total photos\n\n${lines.join('\n')}`
        );
      }

      case 'flickr_get_photo': {
        const photoId = String(args['photo_id']);
        const includeImage = Boolean(args['include_image'] ?? false);

        const photo = await client.getPhoto(photoId);
        const tags = photo.tags?.tag?.map(t => t.raw).join(', ') ?? '(none)';
        const photoUrl = photo.urls?.url?.find(u => u.type === 'photopage')?._content ?? '';

        const summary =
          `Photo ID: ${photo.id}\n` +
          `Title: ${photo.title._content}\n` +
          `Description: ${photo.description._content || '(empty)'}\n` +
          `Tags: ${tags}\n` +
          `Taken: ${photo.dates?.taken ?? 'unknown'}\n` +
          `URL: ${photoUrl}`;

        if (!includeImage) {
          return text(summary);
        }

        const imageData = await client.getPhotoImageBase64(photoId);
        if (!imageData) {
          return text(`${summary}\n\n(Image could not be fetched)`);
        }

        return {
          content: [
            { type: 'text' as const, text: summary },
            { type: 'image' as const, data: imageData.data, mimeType: imageData.mimeType },
          ],
        };
      }

      case 'flickr_get_exif': {
        const photoId = String(args['photo_id']);
        const exif = await client.getExif(photoId);

        if (!exif.length) {
          return text('No EXIF data available for this photo.');
        }

        const lines = exif.map(
          e => `${e.label}: ${e.clean?._content ?? e.raw._content}`
        );
        return text(lines.join('\n'));
      }

      case 'flickr_search_my_photos': {
        const result = await client.searchMyPhotos({
          text: args['text'] as string | undefined,
          tags: args['tags'] as string | undefined,
          tagMode: args['tag_mode'] as 'any' | 'all' | undefined,
          page: Number(args['page'] ?? 1),
          perPage: Number(args['per_page'] ?? 50),
        });

        if (!result.photos.length) {
          return text('No photos matched your search.');
        }

        const lines = result.photos.map(p =>
          `ID: ${p.id} | Title: ${p.title}${p.tags ? ` | Tags: ${p.tags}` : ''}${p.url_m ? ` | URL: ${p.url_m}` : ''}`
        );
        return text(
          `${result.total} results (page ${args['page'] ?? 1}/${result.pages})\n\n${lines.join('\n')}`
        );
      }

      case 'flickr_get_albums': {
        const result = await client.getAlbums(
          Number(args['page'] ?? 1),
          Number(args['per_page'] ?? 50)
        );

        const lines = result.albums.map(
          a =>
            `ID: ${a.id} | "${a.title._content}" | ${a.count_photos ?? a.photos} photos` +
            (a.description._content ? ` | ${a.description._content.slice(0, 60)}` : '')
        );
        return text(`${result.total} albums\n\n${lines.join('\n')}`);
      }

      case 'flickr_get_album_photos': {
        const albumId = String(args['album_id']);
        const result = await client.getAlbumPhotos(
          albumId,
          Number(args['page'] ?? 1),
          Number(args['per_page'] ?? 50)
        );

        const lines = result.photos.map(p =>
          `ID: ${p.id} | Title: ${p.title}${p.tags ? ` | Tags: ${p.tags}` : ''}`
        );
        return text(
          `Album "${result.title}" — ${result.total} photos\n\n${lines.join('\n')}`
        );
      }

      case 'flickr_add_tags': {
        const photoId = String(args['photo_id']);
        const tags = (args['tags'] as string[]).filter(t => t.trim());
        const dryRun = Boolean(args['dry_run'] ?? true);

        if (!tags.length) {
          return err('No tags provided.');
        }

        const photo = await client.getPhoto(photoId);
        const existing = photo.tags?.tag?.map(t => t._content.toLowerCase()) ?? [];
        const toAdd = tags.filter(t => !existing.includes(t.toLowerCase()));
        const alreadyPresent = tags.filter(t => existing.includes(t.toLowerCase()));

        let preview =
          `Photo: "${photo.title._content}" (${photoId})\n` +
          `Tags to add: ${toAdd.length ? toAdd.join(', ') : '(none — all already present)'}\n` +
          (alreadyPresent.length ? `Already present (skipped): ${alreadyPresent.join(', ')}\n` : '');

        if (dryRun) {
          return text(`[DRY RUN — no changes made]\n\n${preview}\nCall again with dry_run: false to apply.`);
        }

        if (!toAdd.length) {
          return text(`${preview}\nNo new tags to add.`);
        }

        await client.addTags(photoId, toAdd);
        return text(`[APPLIED]\n\n${preview}\n✓ Tags added successfully.`);
      }

      case 'flickr_remove_tag': {
        const photoId = String(args['photo_id']);
        const tagText = String(args['tag']);
        const dryRun = Boolean(args['dry_run'] ?? true);

        const photo = await client.getPhoto(photoId);
        const match = photo.tags?.tag?.find(
          t =>
            t._content.toLowerCase() === tagText.toLowerCase() ||
            t.raw.toLowerCase() === tagText.toLowerCase()
        );

        const preview =
          `Photo: "${photo.title._content}" (${photoId})\n` +
          (match
            ? `Tag to remove: "${match.raw}" (ID: ${match.id})`
            : `Tag "${tagText}" not found on this photo.`);

        if (!match) {
          return text(preview);
        }

        if (dryRun) {
          return text(`[DRY RUN — no changes made]\n\n${preview}\nCall again with dry_run: false to apply.`);
        }

        await client.removeTag(photoId, tagText);
        return text(`[APPLIED]\n\n${preview}\n✓ Tag removed successfully.`);
      }

      case 'flickr_set_metadata': {
        const photoId = String(args['photo_id']);
        const dryRun = Boolean(args['dry_run'] ?? true);

        const photo = await client.getPhoto(photoId);
        const currentTitle = photo.title._content;
        const currentDesc = photo.description._content;

        const newTitle = args['title'] !== undefined ? String(args['title']) : currentTitle;
        const newDesc = args['description'] !== undefined ? String(args['description']) : currentDesc;

        const preview =
          `Photo: "${currentTitle}" (${photoId})\n\n` +
          `Title:  ${currentTitle === newTitle ? '(unchanged)' : `"${currentTitle}" → "${newTitle}"`}\n` +
          `Description: ${currentDesc === newDesc ? '(unchanged)' : `\n  Before: ${currentDesc || '(empty)'}\n  After:  ${newDesc}`}`;

        if (currentTitle === newTitle && currentDesc === newDesc) {
          return text(`${preview}\n\nNo changes to make.`);
        }

        if (dryRun) {
          return text(`[DRY RUN — no changes made]\n\n${preview}\nCall again with dry_run: false to apply.`);
        }

        await client.setMetadata(photoId, newTitle, newDesc);
        return text(`[APPLIED]\n\n${preview}\n\n✓ Metadata updated successfully.`);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return err(message);
  }
}
