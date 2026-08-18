/** Typed API client. Session lives in an httpOnly cookie, so nothing is stored here. */

export interface ApiUser {
  id: string;
  name: string;
  username: string;
  email: string | null;
  roles: string[];
  permissions: string[];
  twoFactorEnrolled: boolean;
  twoFactorRequired: boolean;
}

export type LoginStatus =
  | 'AUTHENTICATED'
  | 'TWO_FACTOR_REQUIRED'
  | 'TWO_FACTOR_ENROLLMENT_REQUIRED';

export interface NavItem {
  label: string;
  path: string;
  children?: NavItem[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function qs(q: Record<string, unknown>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  return p.toString();
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init.body ? { 'Content-Type': 'application/json' } : {},
    ...init,
  });

  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!res.ok) {
    const err = body.error as { message?: string; code?: string; details?: unknown } | undefined;
    throw new ApiError(
      err?.message ?? `Request failed (${res.status})`,
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.details
    );
  }
  return body as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ status: LoginStatus; user: ApiUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  me: () =>
    request<{
      user: ApiUser;
      session: { twoFactorOk: boolean; twoFactorEnrollmentRequired: boolean };
    }>('/api/auth/me'),

  beginEnrollment: () =>
    request<{ secret: string; otpauthUri: string; qrDataUri: string }>('/api/auth/2fa/enroll', {
      method: 'POST',
    }),

  confirmEnrollment: (code: string) =>
    request<{ ok: boolean; recoveryCodes: string[] }>('/api/auth/2fa/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  verifyTwoFactor: (code: string) =>
    request<{ ok: boolean; usedRecoveryCode: boolean }>('/api/auth/2fa/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; message: string }>('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  nav: () => request<{ items: NavItem[] }>('/api/nav'),

  reference: () =>
    request<{
      inventoryItems: Array<{ code: string; name: string; division: string; uom: string }>;
      paymentAccounts: Array<{ code: string; name: string; subtype: string }>;
      fiscalYears: Array<{ label: string; is_locked: boolean }>;
      company: { name?: string };
    }>('/api/reference'),

  health: () => request<{ ok: boolean; service: string; time: string }>('/api/health'),

  /* ---------------------------------------------------------- master data */

  drivers: (driverType?: 'IN_HOUSE' | 'OUTSOURCED') =>
    request<{ drivers: Driver[] }>(`/api/drivers${driverType ? `?driverType=${driverType}` : ''}`),

  createDriver: (body: {
    name: string;
    driverType: 'IN_HOUSE' | 'OUTSOURCED';
    phone?: string | null;
    vehicleNumber?: string | null;
    licenseNumber?: string | null;
  }) => request<{ id: string; code: string }>('/api/drivers', { method: 'POST', body: JSON.stringify(body) }),

  issueAdvance: (body: { driverId: number | string; issuedOn: string; amount: string; notes?: string | null }) =>
    request<{ id: string; docNo: string; amount: string }>('/api/drivers/advances', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  parties: (type?: 'SUPPLIER' | 'CUSTOMER' | 'INDUSTRIAL_COMPANY') =>
    request<{ parties: Party[] }>(`/api/parties${type ? `?type=${type}` : ''}`),

  createParty: (body: {
    type: 'SUPPLIER' | 'CUSTOMER' | 'INDUSTRIAL_COMPANY';
    name: string;
    company?: string | null;
    phone?: string | null;
    address?: string | null;
  }) => request<{ id: string; code: string }>('/api/parties', { method: 'POST', body: JSON.stringify(body) }),

  agreements: (division?: string) =>
    request<{ agreements: Agreement[] }>(`/api/agreements${division ? `?division=${division}` : ''}`),

  /* ------------------------------------------------------------ purchases */

  purchases: (q: { division?: string; source?: string; from?: string; to?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
    return request<{ purchases: PurchaseRow[]; summary: PurchaseSummary[] }>(`/api/purchases?${params}`);
  },

  createPurchase: (body: Record<string, unknown>) =>
    request<{
      id: number; docNo: string; totalAmount: string; balanceDue: string;
      paymentStatus: string; stockAfter: string | null; tankAfter: string | null;
    }>('/api/purchases', { method: 'POST', body: JSON.stringify(body) }),

  noPurchaseDay: (body: { division: string; purchaseDate: string; notes?: string | null }) =>
    request<{ id: number; docNo: string }>('/api/purchases/no-activity', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  driverDetail: (id: string | number) =>
    request<{
      driver: DriverDetail;
      totals: { loads: string; drums: string; value: string; issued: string; settled: string };
      collections: DriverCollection[];
      advances: DriverAdvance[];
      vacations: DriverVacation[];
    }>(`/api/drivers/${id}`),

  updateDriver: (id: string | number, body: Record<string, unknown>) =>
    request<{ id: string }>(`/api/drivers/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  addVacation: (id: string | number, body: { startsOn: string; endsOn: string; reason?: string | null }) =>
    request<{ id: string }>(`/api/drivers/${id}/vacations`, { method: 'POST', body: JSON.stringify(body) }),

  profiles: () => request<{ profiles: Profile[]; permissions: PermissionMeta[] }>('/api/profiles'),

  uploadAttachment: (body: { dataUrl: string; filename: string; kind: string; width?: number; height?: number }) =>
    request<{ id: string; size: number; mimeType: string; reused: boolean }>('/api/attachments', {
      method: 'POST', body: JSON.stringify(body),
    }),

  ledger: (accountId: number, q: { from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) params.set(k, String(v));
    return request<LedgerView>(`/api/finance/ledger/${accountId}?${params}`);
  },

  journal: (q: { limit?: number; manualOnly?: boolean } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) params.set(k, String(v));
    return request<{ entries: JournalRow[] }>(`/api/finance/journal?${params}`);
  },

  accounts: () => request<{ accounts: AccountRow[] }>('/api/finance/accounts'),

  journalEntry: (id: number) =>
    request<{ entry: Record<string, unknown>; lines: Array<Record<string, unknown>> }>('/api/finance/journal/' + id),

  postJournal: (body: Record<string, unknown>) =>
    request<{ id: number; entryNo: string; alreadyPosted: boolean }>('/api/finance/journal', {
      method: 'POST', body: JSON.stringify(body),
    }),

  reverseJournal: (id: number) =>
    request<{ id: number; entryNo: string }>('/api/finance/journal/' + id + '/reverse', { method: 'POST', body: '{}' }),

  /* ----------------------------------------------------------- users */

  users: () => request<{ users: UserRow[]; roles: string[] }>('/api/users'),

  createUser: (body: Record<string, unknown>) =>
    request<{ id: string; username: string; role: string }>('/api/users', { method: 'POST', body: JSON.stringify(body) }),

  updateUser: (id: string, body: Record<string, unknown>) =>
    request<{ ok: boolean }>('/api/users/' + id, { method: 'PUT', body: JSON.stringify(body) }),

  setUserPassword: (id: string, password: string) =>
    request<{ ok: boolean; username: string }>('/api/users/' + id + '/password', {
      method: 'POST', body: JSON.stringify({ password }),
    }),

  unlockUser: (id: string) =>
    request<{ ok: boolean }>('/api/users/' + id + '/unlock', { method: 'POST', body: '{}' }),

  /* -------------------------------------------------------------- reports */

  overview: () => request<Overview>('/api/reports/overview'),

  purchaseReport: (q: { from?: string; to?: string; division?: string; groupBy?: string }) =>
    request<PurchaseReport>(`/api/reports/purchases?${qs(q)}`),

  stockReport: (q: { from?: string; to?: string }) => request<StockReport>(`/api/reports/stock?${qs(q)}`),

  profitReport: (q: { from?: string; to?: string }) => request<ProfitReport>(`/api/reports/profit?${qs(q)}`),

  balancesReport: (kind: 'payable' | 'receivable') =>
    request<{ kind: string; rows: OwingRow[] }>(`/api/reports/balances?kind=${kind}`),

  /* ------------------------------------------------------------ inventory */

  inventory: () => request<{ items: StockItem[]; tanks: Tank[] }>('/api/inventory'),

  tanks: () => request<{ tanks: Tank[] }>('/api/tanks'),

  createTank: (body: Record<string, unknown>) =>
    request<Tank>('/api/tanks', { method: 'POST', body: JSON.stringify(body) }),

  updateTank: (id: number, body: Record<string, unknown>) =>
    request<Tank>('/api/tanks/' + id, { method: 'PUT', body: JSON.stringify(body) }),

  tankReading: (id: number, body: Record<string, unknown>) =>
    request<{ measured: string; book: string; difference: string }>('/api/tanks/' + id + '/readings', {
      method: 'POST', body: JSON.stringify(body),
    }),

  /* --------------------------------------------------------- spending */

  expenseCategories: () =>
    request<{ categories: Array<{ id: number; name: string; accountCode: string }> }>('/api/finance/expense-categories'),

  expenses: (q: { from?: string; to?: string } = {}) =>
    request<{ expenses: ExpenseRow[]; byCategory: Array<{ category: string; total: string; count: string }>; total: string }>(
      '/api/finance/expenses?' + qs(q)
    ),

  createExpense: (body: Record<string, unknown>) =>
    request<{ id: string; docNo: string }>('/api/finance/expenses', { method: 'POST', body: JSON.stringify(body) }),

  employees: () =>
    request<{ employees: Array<{ id: string; code: string; name: string; designation: string | null; baseSalary: string }> }>(
      '/api/finance/employees'
    ),

  createEmployee: (body: Record<string, unknown>) =>
    request<{ id: string; code: string }>('/api/finance/employees', { method: 'POST', body: JSON.stringify(body) }),

  salaries: (month?: string) =>
    request<{ salaries: SalaryRow[] }>('/api/finance/salaries' + (month ? '?month=' + month : '')),

  createSalary: (body: Record<string, unknown>) =>
    request<{ id: string; employee: string; remaining: string }>('/api/finance/salaries', {
      method: 'POST', body: JSON.stringify(body),
    }),

  drawings: (q: { from?: string; to?: string } = {}) =>
    request<{ drawings: DrawingRow[]; total: string }>('/api/finance/drawings?' + qs(q)),

  createDrawing: (body: Record<string, unknown>) =>
    request<{ id: string; docNo: string }>('/api/finance/drawings', { method: 'POST', body: JSON.stringify(body) }),

  /* --------------------------------------------------------- payments */

  payments: (q: { from?: string; to?: string; direction?: string } = {}) =>
    request<{ payments: PaymentRow[] }>('/api/finance/payments?' + qs(q)),

  openDocuments: (partyId: number | string) =>
    request<{ documents: OpenDocument[]; totalOutstanding: string }>('/api/finance/open-documents?partyId=' + partyId),

  createPayment: (body: Record<string, unknown>) =>
    request<{ id: string; docNo: string; amount: string; allocated: string; onAccount: string; party: string }>(
      '/api/finance/payments', { method: 'POST', body: JSON.stringify(body) }
    ),

  /* ------------------------------------------------------- weight fees */

  weightFees: (status?: string) =>
    request<{
      fees: WeightFeeRow[];
      summary: Array<{ status: string; count: string; fees: string; refunds: string }>;
      owedByGovernment: string;
    }>('/api/finance/weight-fees' + (status ? '?status=' + status : '')),

  claimFees: (ids: number[], claimedOn: string) =>
    request<{ claimed: number }>('/api/finance/weight-fees/claim', {
      method: 'POST', body: JSON.stringify({ ids, claimedOn }),
    }),

  receiveRefund: (id: string | number, body: Record<string, unknown>) =>
    request<{ refunded: string; notRefunded: string }>('/api/finance/weight-fees/' + id + '/received', {
      method: 'POST', body: JSON.stringify(body),
    }),

  /* -------------------------------------------------------------- finance */

  trialBalance: () =>
    request<{
      rows: Array<{ code: string; name: string; type: string; debit: string; credit: string; balance: string }>;
      totals: { debit: string; credit: string; balanced: boolean; difference: string };
    }>('/api/finance/trial-balance'),

  cashBank: () =>
    request<{
      accounts: Array<{ accountId: number; code: string; name: string; subtype: string; balance: string }>;
      totals: { cash: string; bank: string; combined: string };
    }>('/api/finance/cash-bank'),
};

export interface Driver {
  id: string;
  code: string;
  name: string;
  driverType: 'IN_HOUSE' | 'OUTSOURCED';
  phone: string | null;
  vehicleNumber: string | null;
  advanceBalance: string;
  onVacation: boolean;
  status: string;
}

export interface Party {
  id: string;
  code: string;
  type: string;
  name: string;
  company: string | null;
  phone: string | null;
  outstandingPayable: string;
}

export interface Agreement {
  id: string;
  agreementNo: string;
  division: string;
  ratePerDrum: string | null;
  partyId: string;
  partyName: string;
}

export interface PurchaseRow {
  id: number;
  doc_no: string;
  division: string;
  purchase_date: string;
  source: string;
  drums: string;
  rate_per_drum: string;
  total_amount: string;
  balance_due: string;
  payment_status: string;
  is_no_purchase: boolean;
  party_name: string | null;
  driver_name: string | null;
  driver_type: string | null;
  agreement_no: string | null;
  slip_number: string | null;
}

export interface PurchaseSummary {
  division: string;
  drums: string;
  total: string;
  outstanding: string;
  count: string;
}

export interface StockItem {
  itemId: number;
  code: string;
  name: string;
  division: string;
  uom: string;
  quantity: string;
  value: string;
  avgUnitCost: string;
  isLow: boolean;
}

export interface DriverDetail extends Driver {
  licenseNumber: string | null;
  salary: string | null;
  joiningDate: string | null;
  notes: string | null;
  createdAt: string;
}

export interface DriverCollection {
  id: number;
  docNo: string;
  date: string;
  division: string;
  drums: string;
  rate: string;
  total: string;
  advanceUsed: string;
  balanceDue: string;
  paymentStatus: string;
  area: string | null;
}

export interface DriverAdvance {
  id: string;
  docNo: string;
  issuedOn: string;
  amount: string;
  method: string;
  notes: string | null;
}

export interface DriverVacation {
  id: string;
  startsOn: string;
  endsOn: string;
  reason: string | null;
  current: boolean;
}

export interface Profile {
  code: string;
  name: string;
  description: string;
  requiresTwoFactor: boolean;
  userCount: number;
  permissions: string[];
}

export interface PermissionMeta {
  code: string;
  group: string;
  label: string;
}

export interface AccountRow {
  id: number;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  isControl: boolean;
  isActive: boolean;
}

export interface LedgerView {
  account: { id: number; code: string; name: string; type: string };
  openingBalance: string;
  closingBalance: string;
  rows: Array<{
    lineId: number;
    entryId: number;
    entryNo: string;
    date: string;
    description: string;
    party: string | null;
    debit: string;
    credit: string;
    balance: string;
  }>;
}

export interface JournalRow {
  id: number;
  entry_no: string;
  entry_date: string;
  narration: string | null;
  source_type: string;
  is_manual: boolean;
  is_reversal_of: number | null;
  posted_by_name: string;
  total: string;
}

export interface Overview {
  range: { from: string; to: string };
  byDivision: Array<{ division: string; loads: string; drums: string; value: string; outstanding: string }>;
  today: { loads: string; drums: string; value: string };
  month: { loads: string; drums: string; value: string };
  stock: Array<{ code: string; name: string; quantity: string; value: string; low: boolean }>;
  owed: { payable: string; receivable: string };
  driverAdvances: { out_with_drivers: string; count: string };
}

export interface PurchaseReport {
  range: { from: string; to: string };
  groupBy: string;
  rows: Array<{ label: string; loads: string; drums: string; value: string; paid: string; outstanding: string; fees: string }>;
  totals: { loads: number; drums: string; value: string; paid: string; outstanding: string };
}

export interface StockReport {
  range: { from: string; to: string };
  rows: Array<{
    code: string; name: string; division: string; uom: string;
    in: string; out: string; onHand: string; value: string; avgCost: string; lowThreshold: string;
  }>;
}

export interface ProfitReport {
  range: { from: string; to: string };
  divisions: Array<{ division: string; income: string; cogs: string; gross: string }>;
  expenses: Array<{ code: string; name: string; amount: string }>;
  totals: { gross: string; expenses: string; net: string; drawings: string };
}

export interface OwingRow {
  id: string; code: string; name: string; phone: string | null; type: string;
  balance: string; lastMovement: string | null;
}

export interface Tank {
  id: number;
  code: string;
  name: string;
  itemId: number;
  itemCode: string;
  itemName: string;
  capacity: string;
  deadStock: string;
  location: string | null;
  status: string;
  notes: string | null;
  contents: string;
  available: string;
  usablePercent: number;
}

export interface ExpenseRow {
  id: string; docNo: string; date: string; description: string;
  amount: string; method: string; category: string; paidFrom: string; notes: string | null;
}

export interface SalaryRow {
  id: string; month: string; employee: string; employeeId: string; designation: string | null;
  salary: string; advance: string; paid: string; remaining: string;
  paidOn: string | null; method: string | null;
}

export interface DrawingRow {
  id: string; docNo: string; date: string; amount: string;
  purpose: string | null; method: string; takenFrom: string;
}

export interface PaymentRow {
  id: string; docNo: string; date: string; direction: string; amount: string;
  method: string; reference: string | null; party: string | null; account: string; allocated: string;
}

export interface OpenDocument {
  id: number; docNo: string; date: string; division: string;
  total: string; balance: string; drums: string;
}

export interface WeightFeeRow {
  id: string; feeAmount: string; slipNumber: string | null; status: string;
  claimedOn: string | null; refundAmount: string; receivedOn: string | null;
  eligible: boolean; purchaseDoc: string; purchaseDate: string; division: string;
  daysWaiting: number | null;
}

export interface UserRow {
  id: string;
  username: string;
  name: string;
  email: string | null;
  role: string;
  isActive: boolean;
  twoFactor: boolean;
  lastLogin: string | null;
  lockedUntil: string | null;
}
