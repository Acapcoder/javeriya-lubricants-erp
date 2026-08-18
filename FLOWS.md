# ORCMS — User Flows & Data Flow Diagrams

**Companion to:** [IMPLEMENTATION.md](IMPLEMENTATION.md)
**Covers:** system context, layered data flow diagrams, 16 scenario-based user flows, state machines, and exception paths
**Version:** 1.0 — 2026-08-04

Every flow in this document cites the business rules (BR-nn) it enforces and names the exact tables it writes, so a flow can be checked against the schema in [IMPLEMENTATION.md §4](IMPLEMENTATION.md) and the rules in §5.

---

## Part 1 — Notation

### Data flow diagrams

| Symbol | Meaning |
|---|---|
| Rounded box | **External entity** — a person or outside system |
| Rectangle with number | **Process** — a transformation the system performs |
| Open-ended bar `D-n` | **Data store** |
| Arrow | **Data flow**, labelled with what moves |

### Data stores

| ID | Store | Tables |
|---|---|---|
| D1 | Master data | `parties`, `agreements`, `drivers`, `employees` |
| D2 | Operational documents | `purchases`, `export_sales`, `local_sales` |
| D3 | **Stock ledger** | `stock_movements`, `stock_balances` |
| D4 | **Financial ledger** | `journal_entries`, `journal_lines`, `accounts` |
| D5 | Settlements | `payments`, `payment_allocations` |
| D6 | Weight fees | `weight_fees` |
| D7 | Audit | `activity_logs` |
| D8 | Alerts | `notifications` |
| D9 | Files | `attachments` |
| D10 | Configuration | `users`, `roles`, `settings`, `fiscal_years` |
| D11 | Bank statements | `bank_statement_lines` |
| D12 | Summaries | `monthly_summaries` |

D3 and D4 are the two **authoritative** stores. Everything else either feeds them or reads from them. This is the single most important thing the diagrams below are trying to show.

---

## Part 2 — Context diagram (DFD Level 0)

```mermaid
flowchart TB
    ADMIN(["Administrator"])
    ACC(["Accountant"])
    AUD(["Auditor"])

    SYS["<b>ORCMS</b><br/>Integrated Oil, Water and<br/>Recycling ERP"]

    SUP(["Suppliers and<br/>Restaurants"])
    BUY(["Export Buyers"])
    LOC(["Local UEO Buyers"])
    GOV(["Government<br/>Weight Fee Office"])
    BANK(["Bank"])
    IN_DRV(["In-House Drivers"])
    OUT_DRV(["Outsourced Drivers"])

    ACC -->|purchases, sales, expenses, advances| SYS
    ADMIN -->|users, settings, year locks, restores| SYS
    SYS -->|dashboards, reports, alerts| ACC
    SYS -->|full reports, audit trail| ADMIN
    SYS -->|read-only reports, exports| AUD

    SUP -.->|drums of used oil, invoices| IN_DRV
    SUP -.->|drums of used oil, invoices| OUT_DRV
    IN_DRV -.->|oil delivery| ACC
    OUT_DRV -.->|oil delivery| ACC
    ACC -.->|"advances (quotas)"| IN_DRV
    ACC -.->|payments| OUT_DRV
    SYS -->|export invoices, container docs| BUY
    SYS -->|sale invoices| LOC
    GOV -.->|weight fee slips, refunds| ACC
    SYS -->|refund claim schedules| GOV
    BANK -.->|account statements| ACC
    SYS -->|reconciliation reports| BANK
```

Dotted arrows are physical or paper flows that reach the system through the Accountant — the only data-entry role (SRS §2.1). This is why every inbound flow converges on one actor: it is a design constraint, not an accident, and it is what makes the activity log a complete record of who entered what.

---

## Part 3 — Level 1 data flow

```mermaid
flowchart TB
    USER(["Users"])

    P1["1.0<br/>Authenticate<br/>and Authorise"]
    P2["2.0<br/>Manage<br/>Master Data"]
    P3["3.0<br/>Record<br/>Purchases"]
    P4["4.0<br/>Record<br/>Sales"]
    P5["5.0<br/>Issue<br/>Driver Advances"]
    P6["6.0<br/><b>Post to Ledgers</b>"]
    P7["7.0<br/>Manage Money"]
    P8["8.0<br/>Weight Fee<br/>and Refunds"]
    P9["9.0<br/>Report and<br/>Dashboard"]
    P10["10.0<br/>Integrity,<br/>Alerts and Ops"]

    D1[("D1 Master data")]
    D2[("D2 Documents")]
    D3[("D3 STOCK LEDGER")]
    D4[("D4 FINANCIAL LEDGER")]
    D5[("D5 Settlements")]
    D6[("D6 Weight fees")]
    D7[("D7 Activity log")]
    D8[("D8 Notifications")]
    D12[("D12 Summaries")]

    USER --> P1
    P1 -->|session + permissions| P2
    P1 -->|session + permissions| P3
    P1 -->|session + permissions| P4
    P1 -->|session + permissions| P5
    P1 -->|session + permissions| P7

    P2 <--> D1
    P3 --> D2
    P4 --> D2
    P3 -->|party, agreement lookup| D1
    P4 -->|party lookup| D1
    P5 -->|driver lookup| D1

    P3 -->|posting request| P6
    P4 -->|posting request| P6
    P5 -->|posting request| P6
    P7 -->|posting request| P6
    P8 -->|posting request| P6

    P6 -->|movements| D3
    P6 -->|balanced entries| D4
    P3 -->|fee + slip| D6
    P8 <--> D6
    P7 <--> D5

    D3 --> P9
    D4 --> P9
    D2 --> P9
    D12 --> P9
    P9 -->|reports, exports, dashboard| USER

    P2 --> D7
    P3 --> D7
    P4 --> D7
    P5 --> D7
    P7 --> D7

    D3 --> P10
    D4 --> P10
    P10 --> D8
    P10 --> D12
    D8 -->|alerts| USER
```

**Read this diagram for one thing:** processes 3.0 through 8.0 never write to D3 or D4 themselves. They all hand a *posting request* to 6.0, and only 6.0 touches the two authoritative stores. That single choke point is what makes the invariants in [§4.11](IMPLEMENTATION.md) enforceable — there is exactly one place where money and stock can change.

---

## Part 4 — Level 2 data flows

### 4.1 Process 6.0 — Post to Ledgers (the engine)

```mermaid
flowchart TB
    REQ["Posting request<br/>from 3.0 / 4.0 / 5.0 / 7.0 / 8.0"]

    P61["6.1<br/>Check idempotency<br/>posting_key"]
    P62["6.2<br/>Check fiscal<br/>year open"]
    P63["6.3<br/>Lock stock rows<br/>FOR UPDATE"]
    P64["6.4<br/>Compute valuation<br/>weighted average"]
    P65["6.5<br/>Write stock<br/>movements"]
    P66["6.6<br/>Build journal<br/>lines"]
    P67["6.7<br/>Write entry<br/>DB asserts balance"]
    P68["6.8<br/>Refresh caches<br/>in same txn"]

    D3[("D3 Stock ledger")]
    D4[("D4 Financial ledger")]
    D7[("D7 Activity log")]

    REQ --> P61
    P61 -->|already posted| SKIP["Return existing entry<br/>no second post"]
    P61 -->|new| P62
    P62 -->|year locked| REJ["Reject<br/>BR-24, BR-28"]
    P62 -->|open| P63
    P63 --> P64
    P64 --> P65
    P65 --> D3
    P65 --> P66
    P66 --> P67
    P67 --> D4
    P67 -->|unbalanced| ABORT["Trigger raises<br/>ROLLBACK all<br/>BR-25"]
    P67 --> P68
    P68 --> D3
    P68 --> D7
```

Everything between 6.3 and 6.8 runs inside **one database transaction**. There is no partial state: either the stock moved and the money posted and the caches refreshed, or none of it happened.

### 4.2 Process 5.0 — Issue In-House Driver Advances

This process handles issuing money (quotas) to in-house drivers so they can purchase oil from suppliers.

```mermaid
flowchart LR
    REQ["Accountant issues<br/>advance to driver"]

    D1[("D1 Master Data<br/>drivers")]
    D4[("D4 Financial ledger")]

    P51["5.1 Record Advance"]
    P52["5.2 Increase<br/>advance_balance"]
    P53["5.3 Post Entry"]

    REQ --> P51
    P51 -->|lookup driver| D1
    P51 --> P52
    P52 -->|update advance_balance| D1
    P52 --> P53
    P53 -->|"Dr Driver Advances 1250<br/>Cr Cash/Bank"| D4
```

Note what does **not** happen at 5.3: no expense is created. The advance is an asset (receivable) until the driver returns with oil and a purchase is recorded, which deducts from their `advance_balance` and posts to Inventory.

### 4.3 Process 8.0 — Weight fee refund pipeline

```mermaid
flowchart LR
    P81["8.1 Record fee<br/>at purchase"]
    P82["8.2 Claim<br/>submitted"]
    P83["8.3 Refund<br/>received"]
    P84["8.4 Aging<br/>scan"]

    D6[("D6 Weight fees")]
    D4[("D4 Ledger")]
    D8[("D8 Notifications")]
    GOV(["Government office"])

    P81 -->|"slip + attachment"| D6
    P81 -->|"debit Fee Receivable 1300"| D4
    D6 --> P82
    P82 -->|"claim schedule"| GOV
    P82 -->|"status CLAIMED + date"| D6
    GOV -->|"refund into bank"| P83
    P83 -->|"debit Bank, credit 1300<br/>shortfall to expense BR-20"| D4
    P83 -->|"status RECEIVED"| D6
    D6 --> P84
    P84 -->|"stuck past threshold"| D8
```

This is effectively an accounts-receivable subledger where the debtor is the government. Treating it as one — rather than as a note on a purchase — is what makes "Total Outstanding Refunds Owed by Government" a real, reconcilable dashboard figure.

---

## Part 5 — Scenario user flows

Sixteen scenarios covering the paths that actually get used. Each states its actor, what gets written, which rules apply, and where it can fail.

---

### S1 — Sign in

**Actor:** any user · **Trigger:** start of the working day

```mermaid
flowchart TD
    A["Open http orcms.local"] --> B["Enter email + password"]
    B --> C{"Credentials valid?"}
    C -->|no| D["Increment failure count<br/>log attempt"]
    D --> E{"5 failures?"}
    E -->|yes| F["Lock account 15 min<br/>notify Admin"]
    E -->|no| B
    C -->|yes| G{"Role requires 2FA?"}
    G -->|"Admin or Accountant"| H{"2FA enrolled?"}
    H -->|no| I["Forced enrolment<br/>scan QR, confirm code"]
    I --> J["Enter 6-digit code"]
    H -->|yes| J
    J --> K{"Code valid?"}
    K -->|no| J
    G -->|"other roles"| L
    K -->|yes| L["Session created<br/>log LOGIN"]
    L --> M["Dashboard rendered<br/>for this role only"]
```

**Writes:** `activity_logs` (LOGIN or failed attempt), session store
**Rules:** 2FA mandatory for Admin and Accountant (§6.1); navigation shows only permitted modules

---

### S2 — Accountant records a UCO purchase from a driver collection

The most frequent transaction in the system. The path branches depending on whether the driver is in-house (deducted from their advance) or outsourced (paid directly).

**Actor:** Accountant · **Trigger:** driver returns with drums and paperwork
**Preconditions:** driver and supplier exist; fiscal year open

```mermaid
flowchart TD
    A["UCO → Purchases → New"] --> B["Date, source = In-House or Outsourced Driver"]
    B --> C["Pick driver"]
    C --> D{"Driver on<br/>vacation this date?"}
    D -->|yes| E["Warn: driver marked<br/>unavailable BR-23"]
    E --> C
    D -->|no| F["Pick supplier, collection area"]
    F --> G["Enter drums + rate per drum"]
    G --> H["Total auto-computed<br/>drums × rate"]
    H --> I{"Driver Type?"}
    I -->|"In-House"| J["Deduct from advance_balance<br/>No cash paid"]
    I -->|"Outsourced"| K["Cash paid + Online paid"]
    J --> L["Balance and payment status<br/>auto-derived"]
    K --> L
    L --> M{"Weight fee paid?"}
    M -->|yes| N["Slip number + amount"]
    N --> O["Attach slip scan"]
    O --> P{"Attachment present?"}
    P -->|no| Q["Block save<br/>slip is mandatory"]
    Q --> O
    P -->|yes| R["Refund eligible? amount?"]
    M -->|no| S
    R --> S["Save"]
    S --> T["PurchaseService in transaction"]
    T --> U["Lock UCO stock row"]
    U --> V["Movement +drums at rate<br/>BR-01, BR-03"]
    V --> W["Recompute average cost"]
    W --> X{"Driver Type?"}
    X -->|"In-House"| Y["Journal: Dr Inventory UCO<br/>Cr Driver Advances 1250"]
    X -->|"Outsourced"| Z["Journal: Dr Inventory UCO<br/>Cr Cash/Bank + AP"]
    Y --> AA{"Fee refund eligible?"}
    Z --> AA
    AA -->|yes| AB["Dr Fee Receivable 1300"]
    AA -->|no| AC["Dr Fee Expense 6900"]
    AB --> AD["COMMIT"]
    AC --> AD
    AD --> AE["Log CREATE with diff<br/>invalidate dashboard cache"]
```

**Writes:** `purchases`, `weight_fees`, `attachments`, `stock_movements`, `stock_balances`, `journal_entries`, `journal_lines`, `activity_logs`, updated driver `advance_balance` if in-house.
**Rules:** BR-01 (drums only), BR-02 (UCO only), BR-03 (stock up), BR-23 (vacation), BR-25 (balanced), BR-26 (idempotent)
**Failure paths:** locked fiscal year → rejected before any write; missing slip attachment → blocked at validation; double-click on Save → second request returns the first entry, does not post twice

---

### S3 — Purchase under a direct company agreement

**Actor:** Accountant · **Difference from S2:** rate comes from the contract, and reporting must keep these separate from driver collections

```mermaid
flowchart TD
    A["UCO → Purchases → New"] --> B["Source = Direct Agreement"]
    B --> C["Pick company"]
    C --> D["Agreement list for this company"]
    D --> E["Select agreement"]
    E --> F["Rate pre-filled from contract"]
    F --> G{"Accountant<br/>changes rate?"}
    G -->|yes| H["Show variance hint<br/>contract 120 vs entered 135"]
    H --> I["Allow, record variance"]
    G -->|no| I
    I --> J["Drums, payment, weight fee<br/>as in S2"]
    J --> K["Save → post → commit"]
    K --> L["Purchase tagged agreement_id"]
    L --> M["Appears in Agreement Purchases<br/>report, not Driver Collections"]
```

**Writes:** `purchases` with `agreement_id` set, plus everything in S2
**Why the variance is allowed but flagged:** contract rates get renegotiated verbally before the paperwork catches up. Blocking the entry would push the accountant to falsify the rate; flagging it produces a variance report the owner can actually act on.

---

### S4 — Export sale of used cooking oil

**Actor:** Accountant · **Trigger:** container shipped to a foreign buyer

```mermaid
flowchart TD
    A["UCO → Export Sales → New"] --> B["Date, buyer, destination country"]
    B --> C["Add container rows<br/>number + drums each"]
    C --> D{"Drums per container<br/>within capacity?"}
    D -->|no| E["Reject: exceeds capacity<br/>BR-16"]
    E --> C
    D -->|yes| F["Rate per drum → total"]
    F --> G["Invoice number, payment received"]
    G --> H["Save"]
    H --> I{"Total drums within<br/>UCO stock on hand?"}
    I -->|no| J["Soft warning<br/>BR-17"]
    J --> K{"User has override?"}
    K -->|"Accountant/Admin"| L["Confirm override<br/>logged with reason"]
    K -->|no| M["Blocked"]
    I -->|yes| N
    L --> N["ExportSaleService in transaction"]
    N --> O["Lock UCO stock row"]
    O --> P["Movement −drums at current<br/>average cost BR-04"]
    P --> Q["Journal: Dr Cash/Bank + AR<br/>Cr Export Sales 4100"]
    Q --> R["Journal: Dr COGS 5100<br/>Cr Inventory 1200"]
    R --> S["COMMIT"]
    S --> T["Containers linked to sale<br/>gross profit now computable"]
```

**Writes:** `export_sales`, `containers`, `stock_movements`, two journal entries, `activity_logs`
**Rules:** BR-04, BR-16, BR-17, BR-25
**Note:** the second journal entry is what makes divisional gross profit possible. Recording revenue without simultaneously relieving inventory at cost produces a P&L that overstates profit until someone does a manual stock adjustment — the failure mode this design exists to prevent.

---

### S5 — Local sale of used engine oil

**Actor:** Accountant · **Structurally identical to S4**, with a tanker instead of containers

```mermaid
flowchart LR
    A["UEO → Local Sales → New"] --> B["Buyer, tanker number"]
    B --> C["Drums, rate, invoice"]
    C --> D["Capacity + stock checks"]
    D --> E["Post: −UEO stock<br/>Cr Local Sales 4200<br/>Dr COGS 5200"]
    E --> F["UEO stock screen shows<br/>purchased vs recovered split"]
```

**Rules:** BR-05, BR-16, BR-17
**The split view matters:** UEO stock has two upstream sources — direct purchases and oil recovered from water treatment (BR-09). The operationally interesting question is how much of what was sold came from the treatment plant rather than being bought, so the stock screen keeps the two streams visible.

---

### S6 — Payment received, split across three invoices

**Actor:** Accountant · **Trigger:** buyer pays a lump sum covering several outstanding invoices

```mermaid
flowchart TD
    A["Finance → Payments → New"] --> B["Direction = IN, party, amount 500000"]
    B --> C["Select receiving account<br/>Bank — primary"]
    C --> D["System lists open documents<br/>oldest first"]
    D --> E["Suggested allocation<br/>oldest-first fill"]
    E --> F{"Accountant<br/>adjusts?"}
    F -->|yes| G["Edit per-document amounts"]
    G --> H
    F -->|no| H{"Sum of allocations<br/>vs payment amount"}
    H -->|"equal"| I["Allocate fully"]
    H -->|"less than payment"| J["Remainder held as<br/>party credit on account"]
    H -->|"greater"| K["Reject — cannot allocate<br/>more than received"]
    K --> E
    I --> L
    J --> L["Save → transaction"]
    L --> M["Journal: Dr Bank<br/>Cr AR 1100 with party_id"]
    M --> N["Recompute balance_due and<br/>payment_status on each document"]
    N --> O["COMMIT"]
    O --> P["Party ledger shows the<br/>payment and any credit"]
```

**Writes:** `payments`, `payment_allocations`, `journal_entries`, `journal_lines`, updated `payment_status` on each target document
**Rules:** §4.1 rule 8 (rounding to the last row), BR-25
**Why not force full allocation:** partial and advance payments are normal in this trade. Forcing the remainder onto an arbitrary invoice is how party balances become fiction. Holding it as a visible credit keeps the party ledger honest.

---

### S10 — Government weight fee refund lifecycle

Spans weeks or months and three separate user sessions.

```mermaid
stateDiagram-v2
    [*] --> NOT_ELIGIBLE: fee paid, not refundable
    [*] --> PENDING: fee paid with slip, refund eligible
    NOT_ELIGIBLE --> [*]: expensed to 6900

    PENDING --> CLAIMED: Accountant submits claim<br/>bulk action, claim date set
    CLAIMED --> CLAIMED: aging scan flags<br/>if past threshold
    CLAIMED --> RECEIVED: refund lands in bank
    RECEIVED --> [*]: receivable cleared

    note right of CLAIMED
        Stuck here past the configured
        days triggers a REFUND_AGING
        notification — this is the whole
        point of the module
    end note
```

**Session 1 — at purchase (part of S2):** slip recorded, attachment stored, `Dr Fee Receivable 1300`.

**Session 2 — claim submission:**

```mermaid
flowchart LR
    A["Finance → Weight Fees"] --> B["Filter status = PENDING"]
    B --> C["Select slips to claim"]
    C --> D["Bulk action: Mark Claimed"]
    D --> E["Enter claim date"]
    E --> F["Status → CLAIMED<br/>claimed_on set"]
    F --> G["Print claim schedule for<br/>the government office"]
```

**Session 3 — refund received:**

```mermaid
flowchart TD
    A["Bank shows a refund credit"] --> B["Open the claimed slip"]
    B --> C["Enter refund amount received<br/>and date"]
    C --> D{"Refund amount vs<br/>fee originally paid"}
    D -->|equal| E["Dr Bank, Cr Fee Receivable 1300"]
    D -->|"less — partial refund"| F["Dr Bank for received<br/>Dr Fee Expense 6900 for shortfall<br/>Cr Fee Receivable in full<br/>BR-20"]
    E --> G["Status → RECEIVED"]
    F --> G
    G --> H["Reconciles against the<br/>bank ledger BR-21"]
```

**Rules:** BR-20 (refund may differ from amount paid), BR-21 (reconciles to bank)
**Dashboard effect:** the 1300 balance is "Total Outstanding Refunds Owed by Government" — a figure the owner can chase, because it ties to a list of specific slips.

---

### S11 — Bank reconciliation

**Actor:** Accountant · **Trigger:** monthly bank statement arrives

```mermaid
flowchart TD
    A["Finance → Reconciliation"] --> B["Select bank account + period"]
    B --> C["Import statement CSV/OFX"]
    C --> D{"Duplicate<br/>statement lines?"}
    D -->|yes| E["Skipped by unique constraint<br/>re-import is safe"]
    D -->|no| F["Lines stored in<br/>bank_statement_lines"]
    E --> F
    F --> G["Auto-match against unmatched<br/>journal lines on this account"]
    G --> H["Match on amount<br/>+ date within 3 days<br/>+ reference"]
    H --> I["Two-column view"]
    I --> J["Matched pairs"]
    I --> K["In books, not on statement<br/>uncleared payments"]
    I --> L["On statement, not in books<br/>bank charges, unrecorded receipts"]
    L --> M{"What is it?"}
    M -->|"bank charge"| N["Create expense from the line"]
    M -->|"unrecorded receipt"| O["Create payment from the line"]
    M -->|"already recorded"| P["Manual match"]
    N --> Q
    O --> Q
    P --> Q["Reconciliation statement"]
    Q --> R["Book balance<br/>+/− outstanding items<br/>= statement balance"]
    R --> S{"Ties out?"}
    S -->|no| I
    S -->|yes| T["Period marked reconciled"]
```

**Writes:** `bank_statement_lines`, `matched_line_id` links, possibly new expenses or payments
**Key property:** matching never edits either side. The books stay the books and the statement stays the statement — otherwise the comparison proves nothing.

---

### S12 — Expenses, salaries, and owner's drawings

Three flows that look similar and post very differently. The distinction is the one most often lost in spreadsheet bookkeeping.

```mermaid
flowchart TD
    subgraph EXP["Expense"]
        A1["Date, category, description"] --> A2["Amount, account, receipt"]
        A2 --> A3["Dr Expense 6xxx<br/>Cr Cash/Bank"]
        A3 --> A4["Reduces net profit"]
    end

    subgraph SAL["Salary"]
        B1["Employee, salary month"] --> B2["Salary amount"]
        B2 --> B3["Advance already taken?"]
        B3 --> B4["Remaining = salary − advance − paid"]
        B4 --> B5["Dr Salaries Expense<br/>Cr Cash/Bank for paid<br/>Cr Salaries Payable for remainder"]
        B5 --> B6["Reduces net profit"]
    end

    subgraph DRW["Owner's Drawing"]
        C1["Date, amount, purpose"] --> C2["Payment account"]
        C2 --> C3["Dr Owner's Drawings 3100<br/>Cr Cash/Bank"]
        C3 --> C4["Reduces EQUITY<br/>NOT an expense<br/>BR-12"]
    end

    A4 --> PL["Profit and Loss"]
    B6 --> PL
    C4 --> EQ["Equity movement<br/>shown below net profit"]
```

**Rules:** BR-12 (drawings are not expenses), BR-13 (expenses are company-wide, not division-tagged)
**Why this matters commercially:** treating drawings as an expense understates profit, which distorts every margin figure the owner uses to price purchases. The P&L template deliberately places drawings in a separate block *below* net profit so the difference is visible on the page.

---

### S13 — Correcting a mistake

Two distinct correction paths. Choosing the wrong one is how ledgers get corrupted.

```mermaid
flowchart TD
    A["Accountant finds an error"] --> B{"What kind?"}

    B -->|"Whole document<br/>should not exist"| C["Delete document"]
    C --> D{"Fiscal year open?"}
    D -->|no| E["Blocked — post an<br/>adjustment in the open year<br/>BR-28"]
    D -->|yes| F["Soft delete document"]
    F --> G["Post reversing journal entry<br/>linked via is_reversal_of"]
    G --> H["Post reversing stock movements"]
    H --> I["Balances correct<br/>trail intact BR-19"]

    B -->|"Wrong values,<br/>document is valid"| J["Edit document"]
    J --> K{"Another user editing?"}
    K -->|yes| L["Conflict — show diff<br/>BR-30"]
    K -->|no| M{"Date moved earlier than<br/>existing movements?"}
    M -->|no| N["Reverse and repost<br/>at new values"]
    M -->|yes| O{"Has inventory.backdate<br/>permission?"}
    O -->|no| P["Blocked"]
    O -->|yes| Q["RecostService: replay item<br/>movements forward"]
    Q --> R["Rewrite balance_after<br/>and unit_cost"]
    R --> S["Post ONE COGS adjustment<br/>for the net delta"]
    S --> T["Log RECOST with item,<br/>date range, value delta<br/>BR-29"]
```

**Rules:** BR-19, BR-28, BR-29, BR-30
**The principle:** historical journal entries are never rewritten. A backdated change produces a *new* adjustment entry, so the auditor can see both what was originally recorded and what corrected it.

---

### S14 — Month-end and year-end close

**Actor:** Accountant (month-end), Administrator (year lock)

```mermaid
flowchart TD
    A["Month end"] --> B["Run Trial Balance"]
    B --> C{"Debits = Credits?"}
    C -->|no| D["Impossible by construction<br/>BR-25 — investigate corruption"]
    C -->|yes| E["Run integrity check"]
    E --> F{"All §4.11<br/>invariants hold?"}
    F -->|no| G["Resolve drift before closing"]
    G --> E
    F -->|yes| H["Reconcile bank — S11"]
    H --> I["Review AR/AP aging"]
    I --> J["Review refund aging"]
    J --> K["Generate monthly<br/>Profit and Loss"]
    K --> L["Export PDF for the owner"]

    L --> M{"Year end?"}
    M -->|no| N["Done"]
    M -->|yes| O["Administrator reviews<br/>full-year reports"]
    O --> P["Lock fiscal year"]
    P --> Q["Typed confirmation"]
    Q --> R["is_locked = true<br/>log LOCK action"]
    R --> S["All write routes now reject<br/>dates in that year BR-24"]
    S --> T["Corrections post to the<br/>open year as adjustments"]
```

---

### S15 — Auditor reviews a past year

**Actor:** Auditor · **Access:** read-only, all years

```mermaid
flowchart LR
    A["Auditor signs in"] --> B["Navigation shows<br/>reports and logs only<br/>no create buttons"]
    B --> C["Select fiscal year 2024"]
    C --> D["Trial balance, Profit and Loss,<br/>ledgers for that year"]
    D --> E["Drill into a document"]
    E --> F["View journal entry behind it"]
    F --> G["View activity log timeline<br/>for that document"]
    G --> H{"Was it edited<br/>after posting?"}
    H -->|yes| I["Every change with<br/>before/after diff and user"]
    H -->|no| J["Clean"]
    D --> K["Export PDF + Excel"]
    K --> L["Export logged in activity log"]
```

**Rules:** every write route returns 403 (§6.1); historical years fully readable (BR-19)
**What the auditor can prove:** for any figure in any report, the chain document → journal entry → who entered it → every subsequent change. That chain is the deliverable of the audit trail, not the log viewer itself.

---

### S16 — Automated overnight cycle

**Actor:** none — the scheduler

```mermaid
sequenceDiagram
    participant SCH as Scheduler
    participant BK as Backup Job
    participant INT as Integrity Job
    participant SUM as Summaries Job
    participant NOT as Notification Scan
    participant U as Users

    Note over SCH: 01:00
    SCH->>BK: backup:run
    BK->>BK: pg_dump -Fc + attachment sync
    BK->>BK: Encrypt, write to disk 2 and NAS
    alt backup fails
        BK->>NOT: raise BACKUP_REMINDER
    end

    Note over SCH: 01:30
    SCH->>INT: integrity:check
    INT->>INT: stock_balances vs movements
    INT->>INT: inventory value vs control accounts
    INT->>INT: AR/AP control vs party balances
    INT->>INT: document balance_due vs allocations
    INT->>INT: Processing Cost 5400 = 0
    alt any invariant fails
        INT->>NOT: raise SEVERE INTEGRITY_ALERT
        INT->>INT: Badge affected figures in UI
    end

    Note over SCH: 02:00
    SCH->>SUM: summaries:rebuild
    SUM->>SUM: Recompute prior day monthly_summaries
    alt rebuild differs from incremental values
        SUM->>NOT: raise INTEGRITY_ALERT
    end

    Note over SCH: hourly
    SCH->>NOT: notifications:scan
    NOT->>NOT: low stock, payments due, salary due,<br/>contract expiry, refund aging, vacation end
    NOT->>U: In-app alerts, deduplicated
```

---

## Part 6 — State machines

### Document payment status

```mermaid
stateDiagram-v2
    [*] --> UNPAID: document posted, nothing received
    [*] --> PARTIAL: part paid at entry
    [*] --> PAID: paid in full at entry
    UNPAID --> PARTIAL: allocation applied
    UNPAID --> PAID: full allocation
    PARTIAL --> PAID: balance settled
    PARTIAL --> UNPAID: allocation reversed
    PAID --> PARTIAL: allocation reversed
    PAID --> [*]
    note right of PARTIAL
        Never set by hand.
        Always derived from
        total minus allocations.
    end note
```

### Fiscal year

```mermaid
stateDiagram-v2
    [*] --> OPEN: created
    OPEN --> LOCKED: Administrator locks after review
    LOCKED --> OPEN: Administrator unlocks<br/>logged, exceptional
    LOCKED --> [*]: remains readable forever
    note right of LOCKED
        Rejects every write including
        reversals. Corrections go to
        the open year. BR-24, BR-28
    end note
```

---

## Part 7 — Exception and edge-case flows

| Scenario | Trigger | System response | Rule |
|---|---|---|---|
| Zero-activity day | No purchases collected | "No Purchase" flag records the day with zero values; excluded from totals, present in the daily-completeness report | BR-22 |
| Sale exceeds stock | Drums sold > on hand | Soft warning, Admin/Accountant override, override logged with reason | BR-17 |
| Container overfilled | Assigned drums > capacity | Hard block at validation | BR-16 |
| Double submit | Save clicked twice | Second request returns the first entry; one posting exists | BR-26 |
| Concurrent edit | Two accountants, one document | Second save rejected with a field-level diff | BR-30 |
| Write into locked year | Any dated write | Rejected before any database work | BR-24, BR-28 |
| Manual entry on control account | AR, AP, or Inventory in a manual journal | Rejected at validation | BR-27 |
| Unbalanced entry | Any path, including raw SQL | Database trigger raises at COMMIT, whole transaction rolls back | BR-25 |
| Cache drift | Nightly integrity check fails | SEVERE alert naming the row; figure badged in the UI until resolved | §4.11 |
| Partial refund | Government refunds less than paid | Shortfall booked to expense, receivable cleared in full | BR-20 |
| Backup failure | No successful backup in 24h | BACKUP_REMINDER notification to Administrator | §6.10 |

---

## Part 8 — Scenario to requirement traceability

| Scenario | Requirement source | Rules exercised |
|---|---|---|
| S1 Sign in | Bold §2, SRS §3, §5.3 | 2FA, RBAC |
| S2 Driver-collection purchase | Bold §4, SRS §4.2, §4.3 | BR-01, 02, 03, 23, 25, 26 |
| S3 Agreement purchase | Bold §4, SRS §4.4 | BR-01, 03 |
| S4 Export sale | Bold §4, SRS §4.5, §4.7 | BR-04, 16, 17 |
| S5 Local sale | Bold §5, SRS §4.6 | BR-05, 16, 17 |
| S6 Split payment | SRS §4.12 | §4.1 rule 8 |
| S7 Refund lifecycle | Bold §8, SRS §4.11 | BR-20, 21 |
| S8 Bank reconciliation | SRS §4.14 | §4.9 |
| S9 Expenses, salaries, drawings | Bold §8, SRS §4.9, 4.10, 4.13 | BR-12, 13 |
| S10 Corrections | SRS §4.15, §6.1 | BR-19, 28, 29, 30 |
| S11 Close and lock | SRS §6.1 | BR-24, 25, 28 |
| S12 Auditor review | Bold §11, SRS §4.16 | BR-18, 19 |
| S13 Overnight cycle | Bold §12, SRS §5.1 | §4.11, §6.10 |
