// Booher Velocity — Google Apps Script
// Deploy this as a Web App: Execute as "Me", Access "Anyone"
// Paste the Web App URL into Cloudflare Pages > Settings > Environment Variables as GAS_WEBHOOK_URL

const SHEET_ID = '1dMrEE6-efTiXw5wGG0Qzzfh8HpTgDV2pBpHA_6td7QA';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.openById(SHEET_ID);

    if (data.action === 'add_transaction') {
      return addTransaction(ss, data);
    }
    if (data.action === 'update_budget') {
      return updateBudget(ss, data);
    }
    if (data.action === 'recategorize') {
      return recategorize(ss, data);
    }

    return jsonResponse({ ok: false, error: 'Unknown action: ' + data.action });

  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

// ── Add a transaction row ──────────────────────────────────────────
function addTransaction(ss, data) {
  let sheet = ss.getSheetByName('Transactions');
  if (!sheet) {
    sheet = ss.insertSheet('Transactions');
    sheet.appendRow(['Date', 'Vendor', 'Amount', 'Category', 'Note']);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
  }

  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  sheet.appendRow([
    data.date  || today,
    data.vendor || 'Unknown',
    parseFloat(data.amount) || 0,
    data.category || 'Miscellaneous',
    data.note  || '',
  ]);

  // Auto-update Budget "Spent" column
  refreshBudgetSpent(ss);

  return jsonResponse({ ok: true, action: 'added' });
}

// ── Update budget envelope amounts ─────────────────────────────────
function updateBudget(ss, data) {
  let sheet = ss.getSheetByName('Budget');
  if (!sheet) {
    sheet = ss.insertSheet('Budget');
    sheet.appendRow(['Category', 'Budget', 'Spent', 'Remaining']);
    sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  }

  const categories = data.categories || [];
  const values = sheet.getDataRange().getValues();

  for (const { category, amount } of categories) {
    let found = false;
    for (let i = 1; i < values.length; i++) {
      if (values[i][0] === category) {
        const spent = parseFloat(values[i][2]) || 0;
        sheet.getRange(i + 1, 2).setValue(parseFloat(amount) || 0);
        sheet.getRange(i + 1, 4).setValue((parseFloat(amount) || 0) - spent);
        found = true;
        break;
      }
    }
    if (!found) {
      sheet.appendRow([category, parseFloat(amount) || 0, 0, parseFloat(amount) || 0]);
    }
  }

  return jsonResponse({ ok: true, action: 'budget_updated' });
}

// ── Recategorize a transaction ─────────────────────────────────────
function recategorize(ss, data) {
  const sheet = ss.getSheetByName('Transactions');
  if (!sheet) return jsonResponse({ ok: false, error: 'No Transactions sheet' });

  const values = sheet.getDataRange().getValues();
  const hdrs   = values[0].map(h => h.toString().toLowerCase().replace(/[^a-z]/g, ''));
  const iVend  = hdrs.indexOf('vendor');
  const iAmt   = hdrs.indexOf('amount');
  const iCat   = hdrs.findIndex(h => h.startsWith('cat'));

  if (iCat < 0) return jsonResponse({ ok: false, error: 'No Category column found' });

  for (let i = values.length - 1; i >= 1; i--) {
    const vendorMatch = String(values[i][iVend]).toLowerCase().trim() === String(data.vendor).toLowerCase().trim();
    const amtMatch    = Math.abs(parseFloat(values[i][iAmt]) - Math.abs(parseFloat(data.amount))) < 0.02;
    if (vendorMatch && amtMatch) {
      sheet.getRange(i + 1, iCat + 1).setValue(data.newCategory);
      refreshBudgetSpent(ss);
      return jsonResponse({ ok: true, action: 'recategorized', row: i + 1 });
    }
  }

  return jsonResponse({ ok: false, error: 'Transaction not found' });
}

// ── Recompute "Spent" and "Remaining" in Budget from Transactions ──
function refreshBudgetSpent(ss) {
  const txnSheet    = ss.getSheetByName('Transactions');
  const budgetSheet = ss.getSheetByName('Budget');
  if (!txnSheet || !budgetSheet) return;

  const txnVals    = txnSheet.getDataRange().getValues();
  const budgetVals = budgetSheet.getDataRange().getValues();

  const txnHdrs = txnVals[0].map(h => h.toString().toLowerCase().replace(/[^a-z]/g, ''));
  const iAmt    = txnHdrs.indexOf('amount');
  const iCat    = txnHdrs.findIndex(h => h.startsWith('cat'));
  const iDate   = txnHdrs.indexOf('date');

  // Only count current month
  const now   = new Date();
  const month = now.getMonth();
  const year  = now.getFullYear();

  const spent = {};
  for (let i = 1; i < txnVals.length; i++) {
    const raw = txnVals[i][iDate];
    let d;
    if (raw instanceof Date) {
      d = raw;
    } else {
      d = new Date(raw);
    }
    if (isNaN(d.getTime())) continue;
    if (d.getMonth() !== month || d.getFullYear() !== year) continue;

    const cat = String(txnVals[i][iCat] || '');
    const amt = Math.abs(parseFloat(txnVals[i][iAmt]) || 0);
    spent[cat] = (spent[cat] || 0) + amt;
  }

  for (let i = 1; i < budgetVals.length; i++) {
    const cat    = budgetVals[i][0];
    const budget = parseFloat(budgetVals[i][1]) || 0;
    const s      = spent[cat] || 0;
    budgetSheet.getRange(i + 1, 3).setValue(s);
    budgetSheet.getRange(i + 1, 4).setValue(budget - s);
  }
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
