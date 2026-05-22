const SHEETS = {
  people: "People",
  expenses: "Expenses",
  archive: "Archive",
};

const PEOPLE_HEADERS = ["index", "name"];
const EXPENSE_HEADERS = ["id", "date", "item", "amount", "paidBy", "participants", "createdAt"];
const ARCHIVE_HEADERS = ["closedAt", "cycle", "id", "date", "item", "amount", "paidBy", "participants", "createdAt"];

function doGet(event) {
  try {
    const params = (event && event.parameter) || {};
    const data = params.payload ? withLock(function () {
      return handlePayload(JSON.parse(params.payload || "{}"));
    }) : readState();
    return output(data, params.callback);
  } catch (error) {
    const params = (event && event.parameter) || {};
    return output({ ok: false, error: String((error && error.message) || error) }, params.callback);
  }
}

function doPost(event) {
  try {
    const payload = JSON.parse((event.postData && event.postData.contents) || "{}");
    return json(withLock(function () {
      return handlePayload(payload);
    }));
  } catch (error) {
    return json({ ok: false, error: String((error && error.message) || error) });
  }
}

function withLock(callback) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function handlePayload(payload) {
  if (payload.action === "replace") {
    writeState(payload.people, payload.expenses);
    return readState();
  }
  if (payload.action === "appendExpense") {
    writePeople(payload.people);
    appendExpense(payload.expense);
    return readState();
  }
  if (payload.action === "updatePeople") {
    writePeople(payload.people);
    return readState();
  }
  if (payload.action === "deleteExpense") {
    deleteExpense(payload.id);
    return readState();
  }
  if (payload.action === "closeMonth") {
    const current = readState();
    closeMonth(current.expenses);
    writePeople(payload.people || current.people);
    writeExpenses([]);
    return readState();
  }
  return { ok: false, error: "Unknown action" };
}

function readState() {
  const spreadsheet = SpreadsheetApp.getActive();
  const peopleSheet = ensureSheet(spreadsheet, SHEETS.people, PEOPLE_HEADERS);
  const expensesSheet = ensureSheet(spreadsheet, SHEETS.expenses, EXPENSE_HEADERS);
  const peopleRows = readRows(peopleSheet);
  const expenseRows = readRows(expensesSheet);

  const people = peopleRows.length
    ? peopleRows.slice(0, 3).map(function (row) {
        return row.name || "Mate " + (Number(row.index) + 1);
      })
    : ["You", "Mate 1", "Mate 2"];

  const expenses = expenseRows.map(function (row) {
    return {
      id: String(row.id),
      date: asText(row.date),
      item: String(row.item || ""),
      amount: Number(row.amount) || 0,
      paidBy: Number(row.paidBy) || 0,
      participants: String(row.participants || "0,1,2")
        .split(",")
        .map(function (value) {
          return Number(value);
        })
        .filter(function (value) {
          return !isNaN(value);
        }),
      createdAt: asText(row.createdAt),
    };
  });

  return { ok: true, people: people, expenses: expenses };
}

function writeState(people, expenses) {
  writePeople(people);
  writeExpenses(expenses);
}

function writePeople(people) {
  const spreadsheet = SpreadsheetApp.getActive();
  const peopleSheet = ensureSheet(spreadsheet, SHEETS.people, PEOPLE_HEADERS);
  clearWithHeaders(peopleSheet, PEOPLE_HEADERS);
  const peopleValues = (people || ["You", "Mate 1", "Mate 2"]).slice(0, 3).map(function (name, index) {
    return [index, name || "Mate " + (index + 1)];
  });
  if (peopleValues.length) {
    peopleSheet.getRange(2, 1, peopleValues.length, PEOPLE_HEADERS.length).setValues(peopleValues);
  }
}

function writeExpenses(expenses) {
  const spreadsheet = SpreadsheetApp.getActive();
  const expensesSheet = ensureSheet(spreadsheet, SHEETS.expenses, EXPENSE_HEADERS);
  clearWithHeaders(expensesSheet, EXPENSE_HEADERS);
  const expenseValues = (expenses || []).map(function (expense) {
    return expenseToRow(expense);
  });
  if (expenseValues.length) {
    expensesSheet.getRange(2, 1, expenseValues.length, EXPENSE_HEADERS.length).setValues(expenseValues);
  }
}

function appendExpense(expense) {
  if (!expense || !expense.id) return;
  const spreadsheet = SpreadsheetApp.getActive();
  const expensesSheet = ensureSheet(spreadsheet, SHEETS.expenses, EXPENSE_HEADERS);
  const existingIds =
    expensesSheet.getLastRow() > 1
      ? expensesSheet.getRange(2, 1, expensesSheet.getLastRow() - 1, 1).getValues().map(function (row) {
          return String(row[0]);
        })
      : [];
  if (existingIds.indexOf(String(expense.id)) !== -1) return;
  expensesSheet.getRange(expensesSheet.getLastRow() + 1, 1, 1, EXPENSE_HEADERS.length).setValues([expenseToRow(expense)]);
}

function deleteExpense(id) {
  if (!id) return;
  const current = readState();
  const remaining = current.expenses.filter(function (expense) {
    return String(expense.id) !== String(id);
  });
  writeExpenses(remaining);
}

function expenseToRow(expense) {
  return [
    expense.id,
    expense.date,
    expense.item,
    Number(expense.amount) || 0,
    Number(expense.paidBy) || 0,
    (expense.participants || [0, 1, 2]).join(","),
    expense.createdAt || new Date().toISOString(),
  ];
}

function closeMonth(expenses) {
  const spreadsheet = SpreadsheetApp.getActive();
  const archiveSheet = ensureSheet(spreadsheet, SHEETS.archive, ARCHIVE_HEADERS);
  const closedAt = new Date().toISOString();
  const cycle = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
  const rows = (expenses || []).map(function (expense) {
    return [
      closedAt,
      cycle,
      expense.id,
      expense.date,
      expense.item,
      Number(expense.amount) || 0,
      Number(expense.paidBy) || 0,
      (expense.participants || [0, 1, 2]).join(","),
      expense.createdAt || closedAt,
    ];
  });
  if (rows.length) {
    archiveSheet.getRange(archiveSheet.getLastRow() + 1, 1, rows.length, ARCHIVE_HEADERS.length).setValues(rows);
  }
}

function ensureSheet(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function clearWithHeaders(sheet, headers) {
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function readRows(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).filter(hasContent).map(function (row) {
    return headers.reduce(function (record, header, index) {
      record[header] = row[index];
      return record;
    }, {});
  });
}

function hasContent(row) {
  return row.some(function (cell) {
    return cell !== "";
  });
}

function asText(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(value || "");
}

function json(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function output(data, callback) {
  if (callback) {
    return ContentService.createTextOutput(callback + "(" + JSON.stringify(data) + ")").setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return json(data);
}
