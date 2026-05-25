const SHEETS = {
  people: "People",
  expenses: "Expenses",
  archive: "Archive",
  settlementArchive: "Settlement Payments",
  settings: "Settings",
  cycles: "Cycles",
};

const PEOPLE_HEADERS = ["index", "name"];
const EXPENSE_HEADERS = ["id", "date", "item", "amount", "paidBy", "participants", "createdAt"];
const ARCHIVE_HEADERS = ["closedAt", "cycle", "id", "date", "item", "amount", "paidBy", "participants", "createdAt"];
const SETTLEMENT_ARCHIVE_HEADERS = ["cycle", "id", "paidAt", "from", "to", "fromIndex", "toIndex", "amount", "closedAt"];
const SETTINGS_HEADERS = ["key", "value"];
const CYCLE_HEADERS = ["cycle", "closedAt", "total", "expenseCount", "people"];

function doGet(event) {
  try {
    const params = (event && event.parameter) || {};
    const data = params.payload
      ? withLock(function () {
          return handlePayload(JSON.parse(params.payload || "{}"));
        })
      : readState();
    return output(data, params.callback);
  } catch (error) {
    const params = (event && event.parameter) || {};
    return output({ ok: false, error: String((error && error.message) || error) }, params.callback);
  }
}

function doPost(event) {
  try {
    const payload = JSON.parse((event.postData && event.postData.contents) || "{}");
    return json(
      withLock(function () {
        return handlePayload(payload);
      }),
    );
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
    writeState(payload.people, payload.expenses, payload.currentCycle);
    return readState();
  }
  if (payload.action === "appendExpense") {
    writePeople(payload.people);
    appendExpense(payload.expense);
    writeSetting("paidSettlements", "[]");
    return readState();
  }
  if (payload.action === "updatePeople") {
    writePeople(payload.people);
    return readState();
  }
  if (payload.action === "deleteExpense") {
    deleteExpense(payload.id);
    writeSetting("paidSettlements", "[]");
    return readState();
  }
  if (payload.action === "markSettlementPaid") {
    markSettlementPaid(payload.settlementId, payload.paidAt);
    return readState();
  }
  if (payload.action === "closeCycle" || payload.action === "closeMonth") {
    return closeActiveCycle(payload);
  }
  return { ok: false, error: "Unknown action" };
}

function readState() {
  const spreadsheet = SpreadsheetApp.getActive();
  const peopleSheet = ensureSheet(spreadsheet, SHEETS.people, PEOPLE_HEADERS);
  const expensesSheet = ensureSheet(spreadsheet, SHEETS.expenses, EXPENSE_HEADERS);
  const archiveSheet = ensureSheet(spreadsheet, SHEETS.archive, ARCHIVE_HEADERS);
  const settlementArchiveSheet = ensureSheet(spreadsheet, SHEETS.settlementArchive, SETTLEMENT_ARCHIVE_HEADERS);
  const settingsSheet = ensureSheet(spreadsheet, SHEETS.settings, SETTINGS_HEADERS);
  const cyclesSheet = ensureSheet(spreadsheet, SHEETS.cycles, CYCLE_HEADERS);

  const settings = readSettings(settingsSheet);
  const people = readPeople(peopleSheet);
  const expenses = readExpenses(expensesSheet);
  const archive = readArchive(archiveSheet);
  const settlementArchive = readSettlementArchive(settlementArchiveSheet);
  let currentCycle = validCycle(settings.currentCycle) ? settings.currentCycle : currentCycleId();
  const paidSettlements = parsePaidSettlements(settings.paidSettlements);
  const cycles = readCycles(cyclesSheet, archive, people);

  if (
    !expenses.length &&
    cycles.some(function (cycle) {
      return cycle.cycle === currentCycle;
    })
  ) {
    currentCycle = nextCycleId(currentCycle);
    writeSetting("currentCycle", currentCycle);
    writeSetting("paidSettlements", "[]");
  }

  if (!validCycle(settings.currentCycle)) {
    writeSetting("currentCycle", currentCycle);
  }

  return {
    ok: true,
    people: people,
    expenses: expenses,
    currentCycle: currentCycle,
    paidSettlements: paidSettlements,
    archive: archive,
    settlementArchive: settlementArchive,
    cycles: cycles,
  };
}

function writeState(people, expenses, currentCycle) {
  writePeople(people);
  writeExpenses(expenses);
  if (validCycle(currentCycle)) {
    writeSetting("currentCycle", currentCycle);
  }
}

function readPeople(sheet) {
  const peopleRows = readRows(sheet);
  return peopleRows.length
    ? peopleRows.slice(0, 3).map(function (row) {
        return row.name || "Mate " + (Number(row.index) + 1);
      })
    : ["You", "Mate 1", "Mate 2"];
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

function readExpenses(sheet) {
  return readRows(sheet).map(expenseFromRow);
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
  const spreadsheet = SpreadsheetApp.getActive();
  const expensesSheet = ensureSheet(spreadsheet, SHEETS.expenses, EXPENSE_HEADERS);
  const remaining = readExpenses(expensesSheet).filter(function (expense) {
    return String(expense.id) !== String(id);
  });
  writeExpenses(remaining);
}

function markSettlementPaid(settlementId, paidAt) {
  if (!settlementId) return;
  const current = readState();
  const nextPaidSettlements = mergePaidSettlements(
    [
      {
        id: String(settlementId),
        paidAt: paidAt || new Date().toISOString(),
      },
    ].concat(current.paidSettlements || [])
  );
  writeSetting("paidSettlements", JSON.stringify(nextPaidSettlements));
}

function closeActiveCycle(payload) {
  const current = readState();
  const requestedCycle = payload.cycle;
  if (validCycle(requestedCycle) && requestedCycle !== current.currentCycle) {
    return { ok: false, error: "Cycle changed. Sync first." };
  }
  const settlements = calculateSettlements(current.expenses, current.people, current.currentCycle);
  const payloadPaidSettlements = Array.isArray(payload.paidSettlements) ? payload.paidSettlements : [];
  const paidSettlements = mergePaidSettlements(payloadPaidSettlements.concat(current.paidSettlements || []));
  const missingSettlements = settlements.filter(function (settlement) {
    return !isSettlementPaid(paidSettlements, settlement.id);
  });
  if (missingSettlements.length) {
    return { ok: false, error: "Mark every settlement as paid first." };
  }

  const cycle = current.currentCycle;
  const people = payload.people || current.people;
  const closedAt = new Date().toISOString();
  writePeople(people);
  archiveExpenses(current.expenses, cycle, closedAt);
  archiveSettlementPayments(settlements, paidSettlements, cycle, closedAt);
  upsertCycle(cycle, closedAt, current.expenses, people);
  writeExpenses([]);
  writeSetting("currentCycle", nextCycleId(cycle));
  writeSetting("paidSettlements", "[]");
  return readState();
}

function expenseFromRow(row) {
  return {
    id: String(row.id),
    date: asDateText(row.date),
    item: String(row.item || ""),
    amount: Number(row.amount) || 0,
    paidBy: Number(row.paidBy) || 0,
    participants: parseParticipants(row.participants),
    createdAt: asDateTimeText(row.createdAt),
  };
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

function readArchive(sheet) {
  return readRows(sheet).map(function (row) {
    const expense = expenseFromRow(row);
    expense.closedAt = asDateTimeText(row.closedAt);
    expense.cycle = validCycle(row.cycle) ? String(row.cycle) : currentCycleId();
    return expense;
  });
}

function archiveExpenses(expenses, cycle, closedAt) {
  const spreadsheet = SpreadsheetApp.getActive();
  const archiveSheet = ensureSheet(spreadsheet, SHEETS.archive, ARCHIVE_HEADERS);
  const existingKeys =
    archiveSheet.getLastRow() > 1
      ? archiveSheet.getRange(2, 2, archiveSheet.getLastRow() - 1, 2).getValues().map(function (row) {
          return String(row[0]) + "-" + String(row[1]);
        })
      : [];
  const rows = (expenses || [])
    .filter(function (expense) {
      return existingKeys.indexOf(String(cycle) + "-" + String(expense.id)) === -1;
    })
    .map(function (expense) {
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

function readSettlementArchive(sheet) {
  return readRows(sheet).map(function (row) {
    const amount = Number(row.amount) || 0;
    const fromIndex = Number(row.fromIndex) || 0;
    const toIndex = Number(row.toIndex) || 0;
    const cycle = validCycle(row.cycle) ? String(row.cycle) : currentCycleId();
    return {
      type: "settlement",
      cycle: cycle,
      id: String(row.id || [cycle, fromIndex, toIndex, Math.round(amount)].join(":")),
      item: String(row.from || "") + " paid " + String(row.to || ""),
      from: String(row.from || ""),
      to: String(row.to || ""),
      fromIndex: fromIndex,
      toIndex: toIndex,
      amount: amount,
      paidAt: asDateTimeText(row.paidAt),
      date: asDateTimeText(row.paidAt),
      createdAt: asDateTimeText(row.paidAt),
      closedAt: asDateTimeText(row.closedAt),
    };
  });
}

function archiveSettlementPayments(settlements, paidSettlements, cycle, closedAt) {
  const spreadsheet = SpreadsheetApp.getActive();
  const settlementSheet = ensureSheet(spreadsheet, SHEETS.settlementArchive, SETTLEMENT_ARCHIVE_HEADERS);
  const existingKeys =
    settlementSheet.getLastRow() > 1
      ? settlementSheet.getRange(2, 1, settlementSheet.getLastRow() - 1, 2).getValues().map(function (row) {
          return String(row[0]) + "-" + String(row[1]);
        })
      : [];
  const rows = (settlements || [])
    .map(function (settlement) {
      const record = paidSettlementRecord(paidSettlements, settlement.id);
      if (!record) return null;
      const paidAt = record.paidAt || closedAt;
      return [
        cycle,
        settlement.id,
        paidAt,
        settlement.from,
        settlement.to,
        Number(settlement.fromIndex) || 0,
        Number(settlement.toIndex) || 0,
        Number(settlement.amount) || 0,
        closedAt,
      ];
    })
    .filter(function (row) {
      return row && existingKeys.indexOf(String(row[0]) + "-" + String(row[1])) === -1;
    });
  if (rows.length) {
    settlementSheet.getRange(settlementSheet.getLastRow() + 1, 1, rows.length, SETTLEMENT_ARCHIVE_HEADERS.length).setValues(rows);
  }
}

function readSettings(sheet) {
  return readRows(sheet).reduce(function (settings, row) {
    settings[String(row.key || "")] = String(row.value || "");
    return settings;
  }, {});
}

function writeSetting(key, value) {
  const spreadsheet = SpreadsheetApp.getActive();
  const settingsSheet = ensureSheet(spreadsheet, SHEETS.settings, SETTINGS_HEADERS);
  const lastRow = settingsSheet.getLastRow();
  if (lastRow > 1) {
    const keys = settingsSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let index = 0; index < keys.length; index += 1) {
      if (String(keys[index][0]) === String(key)) {
        settingsSheet.getRange(index + 2, 2).setValue(value);
        return;
      }
    }
  }
  settingsSheet.getRange(lastRow + 1, 1, 1, SETTINGS_HEADERS.length).setValues([[key, value]]);
}

function readCycles(sheet, archive, people) {
  const map = {};
  readRows(sheet).forEach(function (row) {
    if (!validCycle(row.cycle)) return;
    map[String(row.cycle)] = {
      cycle: String(row.cycle),
      closedAt: asDateTimeText(row.closedAt),
      total: Number(row.total) || 0,
      expenseCount: Number(row.expenseCount) || 0,
      people: parsePeople(row.people, people),
    };
  });

  archive.forEach(function (expense) {
    const cycle = expense.cycle || currentCycleId();
    if (!map[cycle]) {
      map[cycle] = {
        cycle: cycle,
        closedAt: expense.closedAt || expense.createdAt,
        total: 0,
        expenseCount: 0,
        people: people,
      };
    }
    if (!map[cycle].hasArchiveTotals) {
      map[cycle].total = 0;
      map[cycle].expenseCount = 0;
      map[cycle].hasArchiveTotals = true;
    }
    map[cycle].total += Number(expense.amount) || 0;
    map[cycle].expenseCount += 1;
  });

  return Object.keys(map)
    .map(function (cycle) {
      delete map[cycle].hasArchiveTotals;
      return map[cycle];
    })
    .sort(function (a, b) {
      return cycleSortValue(b.cycle) - cycleSortValue(a.cycle);
    });
}

function upsertCycle(cycle, closedAt, expenses, people) {
  const spreadsheet = SpreadsheetApp.getActive();
  const cyclesSheet = ensureSheet(spreadsheet, SHEETS.cycles, CYCLE_HEADERS);
  const total = (expenses || []).reduce(function (sum, expense) {
    return sum + (Number(expense.amount) || 0);
  }, 0);
  const row = [cycle, closedAt, Math.round(total), (expenses || []).length, JSON.stringify((people || []).slice(0, 3))];
  const lastRow = cyclesSheet.getLastRow();
  if (lastRow > 1) {
    const cycleValues = cyclesSheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (let index = 0; index < cycleValues.length; index += 1) {
      if (String(cycleValues[index][0]) === String(cycle)) {
        cyclesSheet.getRange(index + 2, 1, 1, CYCLE_HEADERS.length).setValues([row]);
        return;
      }
    }
  }
  cyclesSheet.getRange(lastRow + 1, 1, 1, CYCLE_HEADERS.length).setValues([row]);
}

function calculateSettlements(expenses, people, cycle) {
  const summary = calculateSummary(expenses, people);
  const debtors = summary
    .filter(function (person) {
      return person.balance < 0;
    })
    .map(function (person) {
      return { name: person.name, index: person.index, amount: Math.abs(person.balance) };
    });
  const creditors = summary
    .filter(function (person) {
      return person.balance > 0;
    })
    .map(function (person) {
      return { name: person.name, index: person.index, amount: person.balance };
    });
  const settlements = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtors[debtorIndex] && creditors[creditorIndex]) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amount = Math.min(debtor.amount, creditor.amount);
    if (amount > 0) {
      const settlement = {
        from: debtor.name,
        to: creditor.name,
        fromIndex: debtor.index,
        toIndex: creditor.index,
        amount: Math.round(amount),
      };
      settlement.id = settlementId(cycle, settlement);
      settlements.push(settlement);
    }
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount < 1) debtorIndex += 1;
    if (creditor.amount < 1) creditorIndex += 1;
  }
  return settlements;
}

function calculateSummary(expenses, people) {
  const summary = (people || ["You", "Mate 1", "Mate 2"]).map(function (name, index) {
    return { name: name, index: index, paid: 0, share: 0, balance: 0 };
  });
  (expenses || []).forEach(function (expense) {
    const amount = Number(expense.amount) || 0;
    const paidBy = Number(expense.paidBy) || 0;
    const participants = expense.participants || [0, 1, 2];
    if (!summary[paidBy] || !participants.length) return;
    summary[paidBy].paid += amount;
    const share = amount / participants.length;
    participants.forEach(function (personIndex) {
      if (summary[personIndex]) {
        summary[personIndex].share += share;
      }
    });
  });
  summary.forEach(function (person) {
    person.paid = Math.round(person.paid);
    person.share = Math.round(person.share);
    person.balance = Math.round(person.paid - person.share);
  });
  return summary;
}

function settlementId(cycle, settlement) {
  return [cycle || currentCycleId(), settlement.fromIndex, settlement.toIndex, Math.round(settlement.amount || 0)].join(":");
}

function parseParticipants(value) {
  return String(value || "0,1,2")
    .split(",")
    .map(function (item) {
      return Number(item);
    })
    .filter(function (item) {
      return !isNaN(item);
    });
}

function parsePeople(value, fallback) {
  try {
    const people = JSON.parse(String(value || "[]"));
    return Array.isArray(people) && people.length === 3 ? people : fallback;
  } catch (error) {
    return fallback;
  }
}

function parsePaidSettlements(value) {
  try {
    const items = JSON.parse(String(value || "[]"));
    return normalizePaidSettlements(items);
  } catch (error) {
    return [];
  }
}

function normalizePaidSettlements(values) {
  const seen = {};
  const records = [];
  (Array.isArray(values) ? values : []).forEach(function (value) {
    let record;
    if (value && typeof value === "object") {
      record = {
        id: String(value.id || ""),
        paidAt: String(value.paidAt || ""),
      };
    } else {
      record = { id: String(value || ""), paidAt: "" };
    }
    if (!record.id || seen[record.id]) return;
    seen[record.id] = true;
    records.push(record);
  });
  return records;
}

function mergePaidSettlements(values) {
  return normalizePaidSettlements(values);
}

function isSettlementPaid(records, id) {
  return records.some(function (record) {
    return record.id === id;
  });
}

function paidSettlementRecord(records, id) {
  return (records || []).find(function (record) {
    return record.id === id;
  });
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
  return values
    .slice(1)
    .filter(hasContent)
    .map(function (row) {
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

function asDateText(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
  }
  return String(value || "");
}

function asDateTimeText(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value || "");
}

function currentCycleId() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM");
}

function nextCycleId(cycle) {
  if (!validCycle(cycle)) return currentCycleId();
  const parts = String(cycle).split("-");
  const date = new Date(Number(parts[0]), Number(parts[1]), 1);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), "yyyy-MM");
}

function validCycle(cycle) {
  return /^\d{4}-\d{2}$/.test(String(cycle || ""));
}

function cycleSortValue(cycle) {
  if (!validCycle(cycle)) return 0;
  return Number(String(cycle).replace("-", ""));
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
