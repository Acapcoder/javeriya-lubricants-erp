-- 012 — receipt and slip images
--
-- A weight fee refund claim depends on the physical slip, so a photograph of
-- it belongs with the record rather than in a folder on someone's phone.
--
-- Images are stored in the database rather than on a disk the app happens to
-- be sitting on. Two reasons: the backup then covers the images automatically
-- (a dump with no images is a dump that cannot support a refund claim), and
-- the image cannot be separated from the row that references it.
--
-- This is only reasonable because the payload is capped hard: files are
-- downscaled and re-encoded before upload, and the column below refuses
-- anything above 2 MB. Photographs of a paper slip land around 150-400 KB.

ALTER TABLE attachments
  ADD COLUMN content bytea,
  ADD COLUMN width  integer,
  ADD COLUMN height integer,
  ADD COLUMN kind   varchar(30) NOT NULL DEFAULT 'RECEIPT';

-- 2 MB ceiling, enforced by the database so no code path can bypass it.
ALTER TABLE attachments
  ADD CONSTRAINT attachments_size_limit
  CHECK (content IS NULL OR octet_length(content) <= 2097152);

-- Only formats we can actually display or hand to an inspector.
ALTER TABLE attachments
  ADD CONSTRAINT attachments_mime_allowed
  CHECK (mime_type IS NULL OR mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf'));

CREATE INDEX attachments_kind_idx ON attachments(kind, uploaded_at DESC);

-- The same photograph uploaded twice is one row, found by its hash.
CREATE UNIQUE INDEX attachments_sha_idx ON attachments(sha256) WHERE sha256 IS NOT NULL;

-- stored_path was for a filesystem that no longer holds anything.
ALTER TABLE attachments ALTER COLUMN stored_path DROP NOT NULL;

COMMENT ON COLUMN attachments.content IS 'The image bytes. Capped at 2 MB; larger files are downscaled client-side before upload.';
