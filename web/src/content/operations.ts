/**
 * What each major operation *is*, and what each field means.
 *
 * Surfaced behind the info buttons. Written for the person doing the job, not
 * for a developer: it says what the operation means in the yard, what it does
 * to the books, and the one rule that is easiest to get wrong.
 */

export interface OperationInfo {
  /** Short name shown in the header. */
  title: string;
  /** One sentence: what this operation is. */
  summary: string;
  /** What actually happens when you save. */
  effects: string[];
  /** The mistake this screen exists to prevent. */
  watchOut?: string;
}

export const OPERATIONS: Record<string, OperationInfo> = {
  purchases: {
    title: 'Purchases',
    summary:
      'Recording oil coming in. Every drum that arrives is recorded here, whether a driver brought it, it came under a company agreement, or a supplier delivered it to the yard.',
    effects: [
      'Adds the drums to stock',
      'Records what the oil cost',
      'Records how it was paid for: cash, bank, driver advance, or on credit',
      'Anything unpaid becomes money you owe the supplier',
      'A government weight fee, if paid, is tracked for its refund',
    ],
    watchOut:
      'Money given to your own driver up front is not an expense. It stays yours until oil arrives, so settle the purchase against their advance and it will draw down correctly.',
  },

  sales: {
    title: 'Sales',
    summary:
      'Recording oil going out. Cooking oil leaves in containers for export, and engine oil leaves locally by tanker.',
    effects: [
      'Removes the drums from stock',
      'Records the sale value and the cost of what was sold',
      'Anything unpaid becomes money the buyer owes you',
    ],
    watchOut: 'You cannot sell more drums than a container or tanker physically holds.',
  },

  inventory: {
    title: 'Inventory',
    summary:
      'How many drums you are holding right now, and what they cost you. Every figure here comes from purchases and sales, so nothing is typed in directly.',
    effects: [
      'Purchases raise stock, sales lower it',
      'Cost per drum is a running average of what you actually paid',
    ],
    watchOut:
      'If a number here looks wrong, the purchase or sale behind it is wrong. Fix the document, not the total.',
  },

  contacts: {
    title: 'Drivers and Suppliers',
    summary: 'Everyone you buy oil from, and everyone who brings it to you.',
    effects: [
      'Your own drivers work against an advance you issue them',
      'Outsourced drivers use their own truck and are paid for each delivery',
      'Suppliers are the restaurants, workshops and companies the oil comes from',
    ],
    watchOut: 'An outsourced driver is never given an advance. They are paid per load, like any other supplier.',
  },

  drivers: {
    title: 'Drivers',
    summary:
      'Everyone who brings oil to the yard, split by whether they work for you or for themselves.',
    effects: [
      'Your own drivers are issued money up front and bring oil against it',
      'Outsourced drivers are paid for each load they deliver',
      'Every collection a driver makes is listed against their name',
    ],
    watchOut:
      'The two types are not interchangeable. Only your own drivers can hold an advance, because only their money is still yours.',
  },

  advances: {
    title: 'Driver Advances',
    summary: 'Money handed to one of your own drivers so they can buy oil while they are out.',
    effects: [
      'The money leaves your cash or bank',
      'It becomes money the driver is holding on your behalf',
      'It is drawn down as they bring oil in',
    ],
    watchOut:
      'This is not an expense. Until the oil arrives the money is still yours, it has just moved from the safe to the driver.',
  },

  finance: {
    title: 'Finance',
    summary:
      'The money side of the business: what you hold, what you are owed, what you owe, and whether the books agree.',
    effects: [
      'Cash and bank balances come from the entries behind every document',
      'The trial balance proves the books are internally consistent',
      'The journal holds corrections and opening balances',
    ],
    watchOut:
      'No balance on any of these screens is typed in. To change one, correct the document that caused it.',
  },

  ledgers: {
    title: 'Cash and Bank',
    summary: 'Every rupee in and out of each cash box and bank account, in order.',
    effects: ['Built from the entries behind purchases, sales, expenses and payments'],
    watchOut: 'Balances are never typed in. To change one, correct the document that caused it.',
  },

  journal: {
    title: 'Journal',
    summary: 'Direct accounting entries, for corrections and opening balances that no other screen covers.',
    effects: ['Posts straight to the accounts you choose', 'Every entry must balance before it will save'],
    watchOut:
      'Control accounts cannot be touched here. Those are amounts owed to you, amounts you owe, and stock value, all maintained by the screens that own them.',
  },

  weightFees: {
    title: 'Weight Fee Refunds',
    summary: 'The government fee paid on incoming loads, and the claim to get it back.',
    effects: ['Tracks each slip from paid, to claimed, to received', 'Shows what the government still owes you'],
    watchOut: 'The amount refunded can differ from the amount paid. Record what actually arrived.',
  },

  expenses: {
    title: 'Expenses and Salaries',
    summary: 'What it costs to run the business: fuel, rent, electricity, wages, and the rest.',
    effects: ['Reduces profit', 'Reduces cash or bank'],
    watchOut:
      "Money the owner takes for personal use is not an expense. It reduces the owner's stake in the business and is recorded separately.",
  },

  profiles: {
    title: 'Profiles',
    summary: 'The three kinds of user this system has, and exactly what each one is allowed to do.',
    effects: [
      'Administrator can do everything, including deleting records',
      'Accountant does all the day to day work but cannot delete',
      'Auditor can look at everything and change nothing',
    ],
    watchOut:
      'Deleting is the only thing an Accountant cannot do. That is deliberate, because deleting is the one action that rewrites history.',
  },

  users: {
    title: 'Users',
    summary: 'Who can sign in, and what each of them is allowed to do.',
    effects: [
      'People sign in with a username and password, not an email',
      'Each user has one profile: Administrator, Accountant or Auditor',
      'Disabling someone ends their session immediately',
    ],
    watchOut:
      'Setting a password here signs that person out everywhere. Tell them the new one before you set it.',
  },

  reports: {
    title: 'Reports',
    summary:
      'Totals and trends, built from the same records the rest of the system uses. Change the dates and everything on the page follows.',
    effects: [
      'Oil in can be grouped by day, month, driver, supplier, source or area',
      'Stock shows what moved in and out of the yard',
      'Profit shows sales less what the oil cost, then less running costs',
      'Owing lists who you owe and who owes you',
    ],
    watchOut:
      'These are calculated fresh every time. If a total looks wrong, the document behind it is wrong, not the report.',
  },

  suppliers: {
    title: 'Suppliers',
    summary: 'The restaurants, workshops, factories and companies your oil comes from.',
    effects: [
      'Each supplier keeps a running balance of what you owe them',
      'Every purchase recorded against them appears in their history',
    ],
    watchOut:
      'A supplier is where the oil came from. The driver who carried it is recorded separately, on the Drivers page.',
  },

  receptions: {
    title: 'Wastewater Receptions',
    summary: 'Industrial wastewater arriving for treatment, and the fee charged for taking it.',
    effects: ['Adds the drums to wastewater stock', 'Records the treatment fee as income'],
    watchOut:
      'This is income, not a purchase. You are paid to take this material, so it never creates money owed to the company that delivered it.',
  },

  batches: {
    title: 'Treatment Batches',
    summary: 'Processing wastewater into recovered engine oil and treated water.',
    effects: [
      'Uses up wastewater stock',
      'Produces engine oil, which joins your engine oil stock',
      'Produces treated water, ready to sell',
    ],
    watchOut: 'Record what the plant actually produced, not what was expected.',
  },
};

/**
 * Field level hints, shown on hover beside the label.
 *
 * Kept here rather than inline so the wording can be reviewed in one place,
 * and so the same field means the same thing on every screen it appears on.
 */
export const HINTS = {
  purchaseDate: 'The day the oil actually arrived, not the day you are entering it. It cannot be in the future.',
  oilType: 'Cooking oil comes from kitchens and restaurants. Engine oil comes from workshops and industry.',
  source:
    'Where the drums came from. This changes nothing about the money, it just records who to credit for the collection.',
  driver: 'Who physically brought the oil in. Your own drivers are listed first.',
  collectionArea: 'The area the driver collected from. Useful later for seeing which areas produce most.',
  supplier: 'The restaurant, workshop or company the oil originally came from.',
  agreement: 'A standing contract with a company. Picking one fills in the agreed rate, which you can still change.',
  vehicle: 'The truck or tanker number that delivered the load.',
  drums: 'How many drums arrived. This is what gets added to your stock.',
  ratePerDrum: 'What you agreed to pay for each drum. Drums multiplied by rate gives the total.',
  total: 'Drums multiplied by rate. Calculated for you, so it always matches what gets recorded.',
  cashPaid: 'Money handed over in notes at the time.',
  onlinePaid: 'Money sent by bank transfer or online.',
  advanceUsed:
    'Settled from money this driver is already holding. Only your own drivers can do this, and only up to what they hold.',
  balanceOwed: 'What is still owed for this load. Anything above zero becomes money you owe the supplier.',
  weightFee: 'The government fee paid on this load. Tick this only if a fee was actually paid.',
  feeAmount: 'The amount on the government slip.',
  slipNumber: 'The number printed on the slip. Required, because the refund claim depends on it.',
  refundEligible: 'Whether this fee can be claimed back. If it cannot, it is treated as a cost instead.',

  driverType:
    'Your own driver uses your truck and works against money you give them up front. An outsourced driver uses their own truck and is paid per load.',
  advanceBalance: 'Money this driver is holding that has not yet been settled against delivered oil.',
  advanceAmount: 'How much to hand over. It stays your money until oil comes in against it.',

  cashAccount: 'Where the money physically sits. You can have more than one cash box or bank account.',
  trialBalance:
    'A check that the books are internally consistent. Total debits and total credits must be exactly equal.',
  openingBalance: 'What the account held before the period you are looking at.',
  runningBalance: 'The balance after each entry, in date order.',
  narration: 'A short description of why this entry exists. Write it for someone reading it in a year.',
  debit: 'The left side of an entry. Increases what you own and what things cost.',
  credit: 'The right side of an entry. Increases what you owe, your income, and the owner stake.',
} as const;

export function operationInfo(key: string): OperationInfo | null {
  return OPERATIONS[key] ?? null;
}
