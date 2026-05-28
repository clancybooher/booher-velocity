export interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: 'OBJECT';
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export const TOOL_DECLARATIONS: GeminiFunctionDeclaration[] = [
  {
    name: 'save_receipt',
    description: 'Save a receipt to the ledger and update Google Sheets. Call this after reading a receipt image.',
    parameters: {
      type: 'OBJECT',
      properties: {
        vendor:    { type: 'STRING', description: 'Vendor/merchant name' },
        total:     { type: 'NUMBER', description: 'Total amount charged (positive number)' },
        date:      { type: 'STRING', description: 'Receipt date in YYYY-MM-DD format' },
        category:  { type: 'STRING', description: 'Budget envelope category', enum: [
          'Groceries','Dining Out & Coffee','Utilities & Bills','Transportation & Gas',
          'Entertainment & Date Nights','Home & Maintenance','Health & Personal Care',
          'Travel & Vacations','Savings & Investments','Gifts & Giving','Miscellaneous'
        ]},
        notes:     { type: 'STRING', description: 'Optional notes or line item summary' },
      },
      required: ['vendor', 'total', 'date', 'category'],
    },
  },
  {
    name: 'get_budget_summary',
    description: 'Get full budget summary showing spent vs budget for all 11 envelopes this month.',
    parameters: {
      type: 'OBJECT',
      properties: {
        year_month: { type: 'STRING', description: "Month in YYYY-MM format. Defaults to current month." },
      },
    },
  },
  {
    name: 'get_envelope_balance',
    description: 'Get remaining balance for a single budget envelope.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category:   { type: 'STRING', description: 'Budget category name' },
        year_month: { type: 'STRING', description: "Month in YYYY-MM format. Defaults to current month." },
      },
      required: ['category'],
    },
  },
  {
    name: 'get_spending_by_category',
    description: 'Get itemized spending for a month, optionally filtered to one category.',
    parameters: {
      type: 'OBJECT',
      properties: {
        year_month: { type: 'STRING', description: "Month in YYYY-MM format. Defaults to current month." },
        category:   { type: 'STRING', description: 'Filter to a specific category. Omit for all categories.' },
      },
    },
  },
  {
    name: 'list_receipts',
    description: 'List recent receipts and bank transactions.',
    parameters: {
      type: 'OBJECT',
      properties: {
        limit:      { type: 'NUMBER', description: 'Max number of items to return. Default 20.' },
        start_date: { type: 'STRING', description: 'Start date filter in YYYY-MM-DD format.' },
      },
    },
  },
  {
    name: 'search_receipts',
    description: 'Search receipts and transactions by keyword (vendor name or notes).',
    parameters: {
      type: 'OBJECT',
      properties: {
        keyword:    { type: 'STRING', description: 'Search term' },
        start_date: { type: 'STRING', description: 'Limit results to this date or later (YYYY-MM-DD).' },
      },
      required: ['keyword'],
    },
  },
  {
    name: 'correct_category',
    description: "Fix the budget category on a previously logged transaction.",
    parameters: {
      type: 'OBJECT',
      properties: {
        entry_id:     { type: 'STRING', description: '8-char ledger entry ID' },
        new_category: { type: 'STRING', description: 'Correct budget category' },
      },
      required: ['entry_id', 'new_category'],
    },
  },
  {
    name: 'set_monthly_budget',
    description: 'Update the monthly budget amount for one envelope.',
    parameters: {
      type: 'OBJECT',
      properties: {
        category: { type: 'STRING', description: 'Budget category name' },
        amount:   { type: 'NUMBER', description: 'New monthly budget amount in dollars' },
      },
      required: ['category', 'amount'],
    },
  },
  {
    name: 'train_merchant_category',
    description: 'Remember that a merchant always maps to a specific category in the future.',
    parameters: {
      type: 'OBJECT',
      properties: {
        merchant: { type: 'STRING', description: 'Merchant/vendor name' },
        category: { type: 'STRING', description: 'Budget category to always assign this merchant' },
      },
      required: ['merchant', 'category'],
    },
  },
  {
    name: 'analyze_spending_patterns',
    description: 'Analyze average monthly spending vs budget over past N months. Flags over/under envelopes.',
    parameters: {
      type: 'OBJECT',
      properties: {
        months_back: { type: 'NUMBER', description: 'How many past months to analyze. Default 3.' },
      },
    },
  },
  {
    name: 'suggest_budget_adjustments',
    description: 'Suggest data-driven budget changes based on actual spending patterns.',
    parameters: {
      type: 'OBJECT',
      properties: {
        months_back: { type: 'NUMBER', description: 'Months of history to use. Default 3.' },
      },
    },
  },
  {
    name: 'apply_suggested_budget',
    description: 'Apply the suggested budget adjustments. Only call after user confirms.',
    parameters: {
      type: 'OBJECT',
      properties: {
        months_back: { type: 'NUMBER', description: 'Months used for the suggestion. Default 3.' },
      },
    },
  },
  {
    name: 'sheets_sync_all',
    description: 'Rebuild Google Sheets Transactions and Budget tabs from the full ledger. Use to recover after sync issues.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'teller_sync_transactions',
    description: 'Pull new bank transactions from Chase via Teller and add them to the ledger.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
];
