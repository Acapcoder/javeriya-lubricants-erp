-- 011 — sign in with a username, not an email address
--
-- Email was the login credential, which assumes everyone has one. In a yard
-- office they often do not, and asking an accountant to type
-- "accountant@orcms.local" every morning is friction for no benefit.
--
-- Username becomes the credential. Email stays as optional contact detail,
-- because it is still useful for reaching someone, just not for identifying
-- them at the login screen.

ALTER TABLE users ADD COLUMN username varchar(60);

-- Backfill from the local part of the existing email so nobody is locked out
-- by this migration.
UPDATE users SET username = lower(split_part(email, '@', 1)) WHERE username IS NULL;

-- Anything that still collides gets its id appended rather than the migration
-- failing outright.
UPDATE users u
   SET username = u.username || '-' || u.id
 WHERE EXISTS (
   SELECT 1 FROM users other
    WHERE other.username = u.username AND other.id < u.id
 );

ALTER TABLE users
  ALTER COLUMN username SET NOT NULL,
  ADD CONSTRAINT users_username_key UNIQUE (username),
  -- Letters, digits, dot, dash, underscore. No spaces and no '@', so a
  -- username can never be mistaken for an email address.
  ADD CONSTRAINT users_username_format CHECK (username ~ '^[a-z0-9][a-z0-9._-]{1,59}$');

-- Email is now optional.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;

CREATE INDEX users_username_idx ON users(username) WHERE deleted_at IS NULL;

-- login_attempts records whatever identifier was typed, so widen the column
-- name meaning rather than adding a second one.
COMMENT ON COLUMN login_attempts.email IS 'The identifier typed at the login screen: a username, or an email on older rows.';
