/**
 * The permission matrix from IMPLEMENTATION.md §6.1.
 *
 * This file is the single source of truth: the seeder writes it into the
 * database and the test suite iterates it to assert every cell. If the doc
 * and the code ever disagree, the test fails — which is the point.
 */

export const ROLES = ['ADMIN', 'ACCOUNTANT', 'AUDITOR'] as const;
export type RoleCode = (typeof ROLES)[number];

export const PERMISSIONS = [
  { code: 'operations.view', grp: 'operations', name: 'View operational records' },
  { code: 'operations.create', grp: 'operations', name: 'Create operational records' },
  { code: 'operations.update', grp: 'operations', name: 'Edit operational records' },
  { code: 'operations.delete', grp: 'operations', name: 'Delete operational records' },
  { code: 'finance.view', grp: 'finance', name: 'View finance modules' },
  { code: 'finance.manage', grp: 'finance', name: 'Manage finance modules' },
  { code: 'journal.manual', grp: 'finance', name: 'Post manual journal entries' },
  { code: 'inventory.backdate', grp: 'inventory', name: 'Backdate stock movements (triggers recost)' },
  { code: 'inventory.adjust', grp: 'inventory', name: 'Post stock adjustments' },
  { code: 'profit.view', grp: 'reports', name: 'See profit and margin figures' },
  { code: 'reports.view', grp: 'reports', name: 'View reports' },
  { code: 'reports.export', grp: 'reports', name: 'Export reports' },
  { code: 'masters.manage', grp: 'masters', name: 'Manage parties, drivers, employees' },
  { code: 'users.manage', grp: 'admin', name: 'Manage users and roles' },
  { code: 'settings.manage', grp: 'admin', name: 'Manage system settings' },
  { code: 'activity_log.view', grp: 'admin', name: 'View the activity log' },
  { code: 'activity_log.delete', grp: 'admin', name: 'Delete activity log entries' },
  { code: 'backup.run', grp: 'admin', name: 'Run backups' },
  { code: 'backup.restore', grp: 'admin', name: 'Restore from backup' },
  { code: 'year.lock', grp: 'admin', name: 'Lock and unlock fiscal years' },
] as const;

export type PermissionCode = (typeof PERMISSIONS)[number]['code'];

/**
 * Grants per role. Read this against the table in §6.1.
 *
 *
 * Note: Only Administrator has operations.delete and activity_log.delete.
 */
export const MATRIX: Record<RoleCode, PermissionCode[]> = {
  ADMIN: PERMISSIONS.map((p) => p.code),

  ACCOUNTANT: [
    'operations.view',
    'operations.create',
    'operations.update',
    'finance.view',
    'finance.manage',
    'journal.manual',
    'inventory.backdate',
    'profit.view',
    'reports.view',
    'reports.export',
    'masters.manage',
  ],

  AUDITOR: ['operations.view', 'finance.view', 'profit.view', 'reports.view', 'reports.export', 'activity_log.view'],
};

export const ROLE_META: Record<RoleCode, { name: string; description: string; enabled: boolean; requires2fa: boolean }> = {
  ADMIN: {
    name: 'Administrator',
    description: 'Everything the Accountant can do, plus deleting records and administering the system',
    enabled: true,
    requires2fa: true,
  },
  ACCOUNTANT: {
    name: 'Accountant',
    description: 'All day to day entry and finance work. Cannot delete records.',
    enabled: true,
    requires2fa: true,
  },
  AUDITOR: {
    name: 'Auditor',
    description: 'Can look at everything, including past years. Changes nothing.',
    enabled: true,
    requires2fa: false,
  },
};

export function permissionsFor(role: RoleCode): ReadonlySet<PermissionCode> {
  return new Set(MATRIX[role]);
}
