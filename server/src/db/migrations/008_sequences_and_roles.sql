-- 008 — document numbering, and the corrected role set
--
-- Two changes that belong together only because both are corrections to
-- earlier migrations, which are immutable once applied.

/* ------------------------------------------------- document numbering (E1) */

-- Gap-free numbering per series per year. Counting existing rows is both racy
-- (two concurrent inserts get the same number) and wrong after a soft delete,
-- so the counter is a row we lock.
CREATE TABLE document_sequences (
  series     varchar(40) NOT NULL,     -- PUR-UCO | EXP | JV | ...
  year       smallint    NOT NULL,
  next_value integer     NOT NULL DEFAULT 1,
  PRIMARY KEY (series, year)
);

/* ----------------------------------------------------- role set correction */

-- The system has exactly three profiles: Administrator, Accountant, Auditor.
-- Manager and Data Entry Operator were carried over from the original SRS but
-- are not part of this business, so they are removed rather than left seeded
-- and disabled. Any user still holding one is moved to Accountant, which is
-- the closest equivalent for day-to-day entry.
INSERT INTO user_roles (user_id, role_id)
SELECT DISTINCT ur.user_id, (SELECT id FROM roles WHERE code = 'ACCOUNTANT')
  FROM user_roles ur
  JOIN roles r ON r.id = ur.role_id
 WHERE r.code IN ('MANAGER', 'DATA_ENTRY')
   AND (SELECT id FROM roles WHERE code = 'ACCOUNTANT') IS NOT NULL
ON CONFLICT DO NOTHING;

DELETE FROM role_permissions
 WHERE role_id IN (SELECT id FROM roles WHERE code IN ('MANAGER', 'DATA_ENTRY'));

DELETE FROM user_roles
 WHERE role_id IN (SELECT id FROM roles WHERE code IN ('MANAGER', 'DATA_ENTRY'));

DELETE FROM roles WHERE code IN ('MANAGER', 'DATA_ENTRY');

-- The Accountant enters everything the Administrator can, except deletion.
-- Deleting a posted document is the one action that rewrites history, so it
-- stays with the Administrator alone (alongside activity_log.delete, BR-18).
DELETE FROM role_permissions
 WHERE role_id = (SELECT id FROM roles WHERE code = 'ACCOUNTANT')
   AND permission_id = (SELECT id FROM permissions WHERE code = 'operations.delete');
