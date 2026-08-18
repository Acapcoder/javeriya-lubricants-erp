/**
 * Receipt and slip images.
 *
 * Uploads arrive as a base64 data URL rather than multipart, because the client
 * has already decoded the file into a canvas to downscale it and re-encoding to
 * multipart afterwards buys nothing.
 *
 * Three checks before anything is stored, in order of how easily each is
 * spoofed: declared type, actual magic bytes, and size. The declared type is
 * the least trustworthy of the three, so it is never the only one applied.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../rbac/guard.ts';
import { recordActivity } from '../activity/log.ts';
import { NotFoundError, ValidationError } from '../../lib/errors.ts';

/** 2 MB, matching the database constraint. */
const MAX_BYTES = 2 * 1024 * 1024;

const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

/**
 * What the file actually is, from its leading bytes.
 *
 * A browser will happily report image/jpeg for a renamed executable. The
 * declared type decides nothing here; this does.
 */
function sniff(buf: Buffer): string | null {
  if (buf.length < 12) return null;

  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === '%PDF') return 'application/pdf';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

function humanSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

const uploadSchema = z.object({
  /** data:image/jpeg;base64,… */
  dataUrl: z.string().min(32),
  filename: z.string().trim().max(255).default('receipt'),
  kind: z.enum(['RECEIPT', 'SLIP', 'INVOICE', 'OTHER']).default('SLIP'),
  width: z.coerce.number().int().positive().max(20000).optional(),
  height: z.coerce.number().int().positive().max(20000).optional(),
});

export const attachmentRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook('preHandler', requireAuth);

  app.post(
    '/api/attachments',
    {
      // Base64 inflates by about a third, so the route allows more than the
      // stored ceiling while the byte check below still enforces 2 MB.
      bodyLimit: 4 * 1024 * 1024,
      preHandler: requirePermission('operations.create'),
    },
    async (request, reply) => {
      const data = uploadSchema.parse(request.body);

      const match = /^data:([\w/+.-]+);base64,(.+)$/s.exec(data.dataUrl);
      if (!match) throw new ValidationError('That file could not be read. Try taking the photo again.');

      const declared = match[1]!.toLowerCase();
      if (!ALLOWED.has(declared)) {
        throw new ValidationError('Only photographs (JPEG, PNG, WebP) or a PDF can be attached.');
      }

      let buf: Buffer;
      try {
        buf = Buffer.from(match[2]!, 'base64');
      } catch {
        throw new ValidationError('That file could not be read.');
      }

      if (buf.length === 0) throw new ValidationError('That file is empty.');
      if (buf.length > MAX_BYTES) {
        throw new ValidationError(
          `That file is ${humanSize(buf.length)}. The limit is ${humanSize(MAX_BYTES)}, so take the photo again at a lower resolution.`,
          { size: buf.length, limit: MAX_BYTES }
        );
      }

      // What it says it is, versus what it is.
      const actual = sniff(buf);
      if (!actual) throw new ValidationError('That does not look like a photograph or a PDF.');
      if (actual !== declared) {
        throw new ValidationError(`That file says it is ${declared} but is actually ${actual}.`);
      }

      const sha256 = createHash('sha256').update(buf).digest('hex');

      // The same slip photographed twice is one row.
      const existing = await app.db.query<{ id: string; original_name: string }>(
        'SELECT id, original_name FROM attachments WHERE sha256 = $1',
        [sha256]
      );
      if (existing.rows[0]) {
        return reply.send({
          id: existing.rows[0].id,
          size: buf.length,
          mimeType: actual,
          reused: true,
        });
      }

      const res = await app.db.query<{ id: string }>(
        `INSERT INTO attachments
           (original_name, mime_type, size_bytes, sha256, content, width, height, kind, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          data.filename,
          actual,
          buf.length,
          sha256,
          buf,
          data.width ?? null,
          data.height ?? null,
          data.kind,
          request.auth!.user.id,
        ]
      );

      await recordActivity(app.db, {
        userId: request.auth!.user.id,
        userName: request.auth!.user.name,
        module: 'attachments',
        action: 'CREATE',
        recordType: 'Attachment',
        recordId: res.rows[0]!.id,
        recordLabel: `${data.kind.toLowerCase()} image, ${humanSize(buf.length)}`,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });

      return reply.status(201).send({
        id: res.rows[0]!.id,
        size: buf.length,
        mimeType: actual,
        reused: false,
      });
    }
  );

  /**
   * Serves an image through an authorising handler.
   *
   * Never a direct URL to a file: a slip is evidence for a refund claim, and
   * evidence should not be readable by anyone who guesses a path.
   */
  app.get('/api/attachments/:id', { preHandler: requirePermission('operations.view') }, async (request, reply) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);

    const res = await app.db.query<{
      content: Buffer | null;
      mime_type: string | null;
      original_name: string;
      sha256: string | null;
    }>('SELECT content, mime_type, original_name, sha256 FROM attachments WHERE id = $1', [id]);

    const row = res.rows[0];
    if (!row?.content) throw new NotFoundError('That image is not available');

    // The content hash doubles as an ETag, so a slip viewed repeatedly is
    // fetched once.
    if (row.sha256 && request.headers['if-none-match'] === `"${row.sha256}"`) {
      return reply.status(304).send();
    }

    return reply
      .header('Content-Type', row.mime_type ?? 'application/octet-stream')
      .header('Content-Disposition', `inline; filename="${row.original_name.replace(/"/g, '')}"`)
      .header('Cache-Control', 'private, max-age=86400')
      .header('ETag', row.sha256 ? `"${row.sha256}"` : '')
      .send(row.content);
  });

  /** Metadata without the bytes, for listing what is attached to a record. */
  app.get('/api/attachments/:id/meta', { preHandler: requirePermission('operations.view') }, async (request) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const res = await app.db.query(
      `SELECT a.id, a.original_name AS "filename", a.mime_type AS "mimeType",
              a.size_bytes AS "size", a.width, a.height, a.kind,
              a.uploaded_at AS "uploadedAt", u.name AS "uploadedBy"
         FROM attachments a JOIN users u ON u.id = a.uploaded_by
        WHERE a.id = $1`,
      [id]
    );
    if (!res.rows[0]) throw new NotFoundError('Attachment not found');
    return res.rows[0];
  });
};
