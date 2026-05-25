(function () {
  const STORAGE_KEY = "house-split-state-v1";
  const SYNC_INTERVAL_MS = 30000;
  const DEFAULT_API_URL =
    "https://script.google.com/macros/s/AKfycbxLiAUNhnRIkva76JyIS30-05_Dob9_H_dkxTIAGm2_GKzNq0HloFObXqsmadRVajcemA/exec";
  const DEFAULT_PEOPLE = ["You", "Mate 1", "Mate 2"];
  const VIEW_NAMES = ["add", "history", "settings"];

  const state = {
    people: DEFAULT_PEOPLE.slice(),
    expenses: [],
    archive: [],
    cycles: [],
    paidSettlements: [],
    currentCycle: currentCycleId(),
    apiUrl: DEFAULT_API_URL,
    splitCount: 3,
    paidBy: 0,
    participants: [0, 1, 2],
    isSyncing: false,
    view: "add",
  };

  const els = {
    totalShared: document.getElementById("totalShared"),
    activeCycleText: document.getElementById("activeCycleText"),
    historyCycleLabel: document.getElementById("historyCycleLabel"),
    expenseForm: document.getElementById("expenseForm"),
    itemInput: document.getElementById("itemInput"),
    amountInput: document.getElementById("amountInput"),
    dateInput: document.getElementById("dateInput"),
    paidByGroup: document.getElementById("paidByGroup"),
    splitModeGroup: document.getElementById("splitModeGroup"),
    participantsGroup: document.getElementById("participantsGroup"),
    personSummary: document.getElementById("personSummary"),
    settlementList: document.getElementById("settlementList"),
    settlementHelper: document.getElementById("settlementHelper"),
    expenseList: document.getElementById("expenseList"),
    cycleTrend: document.getElementById("cycleTrend"),
    cycleList: document.getElementById("cycleList"),
    syncStatus: document.getElementById("syncStatus"),
    syncButton: document.getElementById("syncButton"),
    closeCycleButton: document.getElementById("closeCycleButton"),
    appNav: document.getElementById("appNav"),
    settingsForm: document.getElementById("settingsForm"),
    saveSettingsButton: document.getElementById("saveSettingsButton"),
    personInputs: [
      document.getElementById("person0Input"),
      document.getElementById("person1Input"),
      document.getElementById("person2Input"),
    ],
    emptyStateTemplate: document.getElementById("emptyStateTemplate"),
  };

  function init() {
    loadLocal();
    state.view = "add";
    if (location.hash) {
      history.replaceState(null, "", location.pathname + location.search);
    }
    els.dateInput.value = today();
    bindEvents();
    render();
    if (state.apiUrl) {
      syncFromSheet();
    }
    startAutoSync();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(function () {});
    }
  }

  function bindEvents() {
    els.expenseForm.addEventListener("submit", addExpense);
    els.amountInput.addEventListener("input", formatAmountInput);
    els.splitModeGroup.addEventListener("click", setSplitMode);
    els.paidByGroup.addEventListener("click", setPaidBy);
    els.participantsGroup.addEventListener("click", toggleParticipant);
    els.syncButton.addEventListener("click", syncFromSheet);
    els.closeCycleButton.addEventListener("click", closeCycle);
    els.settlementList.addEventListener("click", markSettlementPaid);
    els.settingsForm.addEventListener("submit", saveSettings);
    els.expenseList.addEventListener("click", deleteExpense);
    els.appNav.addEventListener("click", handleNavClick);
  }

  async function addExpense(event) {
    event.preventDefault();
    const item = els.itemInput.value.trim();
    const amount = parseAmount(els.amountInput.value);
    if (!item || !amount || state.participants.length !== state.splitCount) {
      return;
    }

    const expense = {
      id: createId(),
      item,
      amount,
      paidBy: state.paidBy,
      participants: state.participants.slice().sort(),
      date: els.dateInput.value || today(),
      createdAt: new Date().toISOString(),
    };

    state.expenses = mergeExpenses([expense].concat(state.expenses));
    state.paidSettlements = [];

    els.itemInput.value = "";
    els.amountInput.value = "";
    els.itemInput.focus();
    persistAndRender();
    await postThenSync(
      { action: "appendExpense", people: state.people, expense: expense },
      { expectedExpenseId: expense.id },
    );
  }

  async function deleteExpense(event) {
    const button = event.target.closest("[data-delete-id]");
    if (!button) return;
    const expenseId = button.dataset.deleteId;
    state.expenses = state.expenses.filter(function (expense) {
      return expense.id !== expenseId;
    });
    state.paidSettlements = [];
    persistAndRender();
    await postThenSync({ action: "deleteExpense", id: expenseId });
  }

  async function markSettlementPaid(event) {
    const button = event.target.closest("[data-pay-settlement]");
    if (!button) return;
    const settlementId = button.dataset.paySettlement;
    if (!settlementId || state.paidSettlements.includes(settlementId)) return;
    state.paidSettlements = uniqueStrings([settlementId].concat(state.paidSettlements));
    persistAndRender();
    await postThenSync({ action: "markSettlementPaid", cycle: state.currentCycle, settlementId: settlementId });
  }

  async function closeCycle() {
    if (!canCloseCycle()) return;
    const cycle = state.currentCycle || currentCycleId();
    const nextCycle = nextCycleId(cycle);
    const expenseCount = state.expenses.length;
    const message =
      "Close " +
      cycleLabel(cycle) +
      " and start " +
      cycleLabel(nextCycle) +
      "?" +
      (expenseCount ? "" : "\n\nThis cycle has no spending yet.");
    const confirmed = window.confirm(message);
    if (!confirmed) return;

    if (state.apiUrl) {
      await postThenSync({ action: "closeCycle", people: state.people, cycle: cycle });
      return;
    }

    closeCycleLocally(cycle);
    persistAndRender();
  }

  function closeCycleLocally(cycle) {
    const closedAt = new Date().toISOString();
    const expenses = state.expenses.slice();
    const archived = expenses.map(function (expense) {
      return Object.assign({}, expense, {
        cycle: cycle,
        closedAt: closedAt,
      });
    });
    state.archive = normalizeArchive(archived.concat(state.archive));
    state.cycles = mergeCycles([cycleRecord(cycle, closedAt, expenses, state.people)].concat(state.cycles));
    state.expenses = [];
    state.paidSettlements = [];
    state.currentCycle = nextCycleId(cycle);
  }

  function setSplitMode(event) {
    const button = event.target.closest("[data-split]");
    if (!button) return;
    state.splitCount = Number(button.dataset.split);
    if (state.splitCount === 3) {
      state.participants = [0, 1, 2];
    } else if (state.splitCount === 2) {
      const preferred = state.participants.filter(function (index) {
        return index !== state.paidBy;
      });
      const nextPerson = preferred.length
        ? preferred[0]
        : [0, 1, 2].find(function (index) {
            return index !== state.paidBy;
          });
      state.participants = [state.paidBy, nextPerson];
    } else {
      state.participants = [state.paidBy];
    }
    renderControls();
  }

  function setPaidBy(event) {
    const button = event.target.closest("[data-paid-by]");
    if (!button) return;
    state.paidBy = Number(button.dataset.paidBy);
    if (state.splitCount === 2) {
      const otherPerson =
        state.participants.find(function (index) {
          return index !== state.paidBy;
        }) ||
        [0, 1, 2].find(function (index) {
          return index !== state.paidBy;
        });
      state.participants = [state.paidBy, otherPerson];
    } else if (state.splitCount === 1) {
      state.participants = [state.paidBy];
    }
    renderControls();
  }

  function toggleParticipant(event) {
    const button = event.target.closest("[data-participant]");
    if (!button || state.splitCount === 3) return;
    const personIndex = Number(button.dataset.participant);
    if (state.splitCount === 1) {
      state.participants = [personIndex];
      renderControls();
      return;
    }
    if (personIndex === state.paidBy) return;
    state.participants = [state.paidBy, personIndex];
    renderControls();
  }

  async function saveSettings(event) {
    event.preventDefault();
    const nextPeople = els.personInputs.map(function (input, index) {
      return input.value.trim() || DEFAULT_PEOPLE[index];
    });
    state.people = nextPeople;
    state.apiUrl = DEFAULT_API_URL;
    state.paidBy = Math.min(state.paidBy, 2);
    if (state.splitCount === 3) {
      state.participants = [0, 1, 2];
    } else if (state.splitCount === 1) {
      state.participants = [state.paidBy];
    }
    persistAndRender();
    await postThenSync({ action: "updatePeople", people: state.people });
  }

  function handleNavClick(event) {
    const button = event.target.closest("[data-view]");
    if (!button) return;
    const view = button.dataset.view;
    if (!VIEW_NAMES.includes(view)) return;
    state.view = view;
    window.scrollTo({ top: 0, behavior: "smooth" });
    renderView();
  }

  function render() {
    renderView();
    renderControls();
    renderSummary();
    renderSettlements();
    renderActiveExpenses();
    renderCycleTrend();
    renderCycleList();
    renderSettings();
    setSyncStatus(state.apiUrl ? "Sheet" : "Local");
  }

  function renderView() {
    document.querySelectorAll("[data-view-panel]").forEach(function (panel) {
      panel.classList.toggle("is-active", panel.dataset.viewPanel === state.view);
    });
    els.appNav.querySelectorAll("[data-view]").forEach(function (button) {
      const isActive = button.dataset.view === state.view;
      button.classList.toggle("active", isActive);
      if (isActive) {
        button.setAttribute("aria-current", "page");
      } else {
        button.removeAttribute("aria-current");
      }
    });
  }

  function renderControls() {
    els.paidByGroup.innerHTML = state.people
      .map(function (person, index) {
        return (
          '<button type="button" class="segment ' +
          (state.paidBy === index ? "active" : "") +
          '" data-paid-by="' +
          index +
          '">' +
          personIcon(index) +
          '<span class="chip-label">' +
          escapeHtml(person) +
          "</span>" +
          "</button>"
        );
      })
      .join("");

    els.splitModeGroup.querySelectorAll("[data-split]").forEach(function (button) {
      button.classList.toggle("active", Number(button.dataset.split) === state.splitCount);
    });

    els.participantsGroup.innerHTML = state.people
      .map(function (person, index) {
        return (
          '<button type="button" class="chip ' +
          (state.participants.includes(index) ? "active" : "") +
          '" data-participant="' +
          index +
          '" ' +
          (state.splitCount === 3 || (state.splitCount === 2 && index === state.paidBy) ? "disabled" : "") +
          ">" +
          personIcon(index) +
          '<span class="chip-label">' +
          escapeHtml(person) +
          "</span>" +
          "</button>"
        );
      })
      .join("");
  }

  function renderSummary() {
    const summary = calculateSummary(state.expenses);
    const label = cycleLabel(state.currentCycle);
    els.totalShared.textContent = money(summary.total);
    els.activeCycleText.textContent = "Active spending in " + label;
    els.historyCycleLabel.textContent = label;
    els.personSummary.innerHTML = summary.people
      .map(function (person, index) {
        const balanceClass = person.balance > 0 ? "receive" : person.balance < 0 ? "pay" : "";
        const balanceText =
          person.balance > 0
            ? "Receives " + money(person.balance)
            : person.balance < 0
              ? "Pays " + money(Math.abs(person.balance))
              : "Even";
        return (
          '<article class="summary-card">' +
          "<header><div>" +
          personIcon(index) +
          "<h3>" +
          escapeHtml(person.name) +
          "</h3></div>" +
          '<span class="status-pill ' +
          balanceClass +
          '">' +
          balanceText +
          "</span></header>" +
          '<div class="money-row">' +
          "<div><span>Paid</span><strong>" +
          money(person.paid) +
          "</strong></div>" +
          "<div><span>Share</span><strong>" +
          money(person.share) +
          "</strong></div>" +
          "<div><span>Balance</span><strong>" +
          money(person.balance) +
          "</strong></div>" +
          "</div>" +
          "</article>"
        );
      })
      .join("");
  }

  function renderSettlements() {
    const settlements = calculateSettlements(state.expenses);
    if (!settlements.length) {
      renderEmpty(els.settlementList, "All square");
      renderSettlementFooter(settlements);
      return;
    }
    els.settlementList.innerHTML = settlements
      .map(function (settlement) {
        const id = settlementId(settlement);
        const paid = state.paidSettlements.includes(id);
        return (
          '<div class="settlement-item">' +
          '<div class="row-icon row-icon-transfer" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 7h11"/><path d="m15 4 3 3-3 3"/><path d="M17 17H6"/><path d="m9 14-3 3 3 3"/></svg></div>' +
          '<div class="settlement-copy"><strong>' +
          escapeHtml(settlement.from) +
          " pays " +
          escapeHtml(settlement.to) +
          '</strong><small>Cycle settlement</small></div><div class="settlement-pay"><span>' +
          money(settlement.amount) +
          "</span>" +
          (paid
            ? '<span class="paid-label">✓ Paid</span>'
            : '<button class="pay-button" type="button" data-pay-settlement="' + escapeHtml(id) + '">Pay</button>') +
          "</div></div>"
        );
      })
      .join("");
    renderSettlementFooter(settlements);
  }

  function renderSettlementFooter(settlements) {
    const canClose = canCloseCycle(settlements);
    els.closeCycleButton.disabled = !canClose;
    if (!settlements.length) {
      els.settlementHelper.textContent = "All square. You can close this cycle now.";
      return;
    }
    els.settlementHelper.textContent = canClose
      ? "All settlements are paid. You can close this cycle now."
      : "Mark every settlement as paid before closing this cycle.";
  }

  function renderActiveExpenses() {
    renderExpenseList(els.expenseList, state.expenses, {
      emptyText: "No spending in this cycle yet",
      canDelete: true,
    });
  }

  function renderCycleTrend() {
    const summaries = cycleSummaries().sort(function (a, b) {
      return cycleSortValue(a.cycle) - cycleSortValue(b.cycle);
    });
    if (!summaries.length) {
      renderEmpty(els.cycleTrend, "Close a cycle to see the trend");
      return;
    }

    const visible = summaries.slice(-6);
    const maxTotal = Math.max.apply(
      null,
      visible.map(function (cycle) {
        return cycle.total;
      }),
    );
    const maxBarHeight = 128;
    const minBarHeight = 18;

    els.cycleTrend.innerHTML =
      '<div class="trend-chart" role="img" aria-label="Cycle spending trend">' +
      '<div class="trend-chart-grid" style="grid-template-columns:repeat(' +
      visible.length +
      ', minmax(0, 1fr))">' +
      visible
        .map(function (cycle) {
          const height = maxTotal ? Math.max(minBarHeight, Math.round((cycle.total / maxTotal) * maxBarHeight)) : minBarHeight;
          return '<div class="trend-chart-column"><span class="trend-bar" style="height:' + height + 'px"></span></div>';
        })
        .join("") +
      "</div>" +
      '<div class="trend-label-row" style="grid-template-columns:repeat(' +
      visible.length +
      ', minmax(0, 1fr))">' +
      visible
        .map(function (cycle) {
          return (
            "<span>" +
            "<small>" +
            escapeHtml(cycleLabel(cycle.cycle, { short: true })) +
            "</small>" +
            "<strong>" +
            escapeHtml(compactAmount(cycle.total)) +
            "</strong>" +
            "</span>"
          );
        })
        .join("") +
      "</div>";
  }

  function renderCycleList() {
    const summaries = cycleSummaries().sort(function (a, b) {
      return cycleSortValue(b.cycle) - cycleSortValue(a.cycle);
    });
    if (!summaries.length) {
      renderEmpty(els.cycleList, "No closed cycles yet");
      return;
    }
    els.cycleList.innerHTML = summaries
      .map(function (summary, index) {
        const expenses = expensesForCycle(summary.cycle);
        const countText = summary.expenseCount === 1 ? "1 spending" : summary.expenseCount + " spending";
        return (
          '<details class="cycle-card" ' +
          (index === 0 ? "open" : "") +
          ">" +
          "<summary>" +
          "<div><h3>" +
          escapeHtml(cycleLabel(summary.cycle, { withYear: true })) +
          "</h3><span>" +
          countText +
          "</span></div><strong>" +
          money(summary.total) +
          "</strong></summary>" +
          '<div class="cycle-expenses">' +
          expenseListHtml(expenses, { emptyText: "No spending saved in this cycle", canDelete: false }) +
          "</div>" +
          "</details>"
        );
      })
      .join("");
  }

  function renderExpenseList(target, expenses, options) {
    if (!expenses.length) {
      renderEmpty(target, options.emptyText);
      return;
    }
    target.innerHTML = expenseListHtml(expenses, options);
  }

  function expenseListHtml(expenses, options) {
    if (!expenses.length) {
      return '<div class="empty-state">' + escapeHtml(options.emptyText) + "</div>";
    }
    return expenses
      .map(function (expense) {
        const participants = expense.participants
          .map(function (index) {
            return state.people[index];
          })
          .join(", ");
        return (
          '<article class="expense-item">' +
          '<div class="row-icon row-icon-payment" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h16v10H4z"/><path d="M7 10h.01"/><path d="M17 14h.01"/><circle cx="12" cy="12" r="2.5"/></svg></div>' +
          '<div class="expense-main">' +
          '<div class="expense-title"><strong>' +
          escapeHtml(expense.item) +
          "</strong><span>" +
          money(expense.amount) +
          "</span></div>" +
          '<div class="expense-meta">' +
          readableDate(expense.date) +
          " - " +
          escapeHtml(state.people[expense.paidBy]) +
          " - " +
          escapeHtml(participants) +
          "</div>" +
          "</div>" +
          (options.canDelete
            ? '<button class="delete-button" type="button" aria-label="Delete" title="Delete" data-delete-id="' +
              escapeHtml(expense.id) +
              '">' +
              '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>' +
              "</button>"
            : "") +
          "</article>"
        );
      })
      .join("");
  }

  function renderSettings() {
    els.personInputs.forEach(function (input, index) {
      if (document.activeElement !== input) {
        input.value = state.people[index] || DEFAULT_PEOPLE[index];
      }
    });
  }

  function renderEmpty(target, text) {
    const empty = els.emptyStateTemplate.content.firstElementChild.cloneNode(true);
    empty.textContent = text;
    target.replaceChildren(empty);
  }

  function calculateSummary(expenses) {
    const people = state.people.map(function (name, index) {
      return { name: name, index: index, paid: 0, share: 0, balance: 0 };
    });
    let total = 0;
    expenses.forEach(function (expense) {
      total += expense.amount;
      people[expense.paidBy].paid += expense.amount;
      const share = expense.amount / expense.participants.length;
      expense.participants.forEach(function (personIndex) {
        people[personIndex].share += share;
      });
    });
    people.forEach(function (person) {
      person.paid = Math.round(person.paid);
      person.share = Math.round(person.share);
      person.balance = Math.round(person.paid - person.share);
    });
    return { total: Math.round(total), people: people };
  }

  function calculateSettlements(expenses) {
    const summary = calculateSummary(expenses).people;
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
        settlements.push({
          from: debtor.name,
          to: creditor.name,
          fromIndex: debtor.index,
          toIndex: creditor.index,
          amount: Math.round(amount),
        });
      }
      debtor.amount -= amount;
      creditor.amount -= amount;
      if (debtor.amount < 1) debtorIndex += 1;
      if (creditor.amount < 1) creditorIndex += 1;
    }
    return settlements;
  }

  function settlementId(settlement) {
    return [
      state.currentCycle || currentCycleId(),
      settlement.fromIndex,
      settlement.toIndex,
      Math.round(settlement.amount || 0),
    ].join(":");
  }

  function canCloseCycle(settlements) {
    const currentSettlements = Array.isArray(settlements) ? settlements : calculateSettlements(state.expenses);
    return currentSettlements.every(function (settlement) {
      return state.paidSettlements.includes(settlementId(settlement));
    });
  }

  function cycleSummaries() {
    const map = {};
    state.cycles.forEach(function (cycle) {
      map[cycle.cycle] = Object.assign({}, cycle);
    });
    state.archive.forEach(function (expense) {
      const cycle = expense.cycle || state.currentCycle || currentCycleId();
      if (!map[cycle]) {
        map[cycle] = cycleRecord(cycle, expense.closedAt || expense.createdAt, [], state.people);
      }
      if (!map[cycle]._hasArchiveTotals) {
        map[cycle].total = 0;
        map[cycle].expenseCount = 0;
        map[cycle]._hasArchiveTotals = true;
      }
      map[cycle].total += Number(expense.amount) || 0;
      map[cycle].expenseCount += 1;
    });
    return Object.keys(map).map(function (cycle) {
      map[cycle].total = Math.round(map[cycle].total || 0);
      delete map[cycle]._hasArchiveTotals;
      return map[cycle];
    });
  }

  function expensesForCycle(cycle) {
    return state.archive
      .filter(function (expense) {
        return expense.cycle === cycle;
      })
      .sort(function (a, b) {
        return new Date(b.createdAt || b.closedAt).getTime() - new Date(a.createdAt || a.closedAt).getTime();
      });
  }

  function cycleRecord(cycle, closedAt, expenses, people) {
    return {
      cycle: cycle,
      closedAt: closedAt || new Date().toISOString(),
      total: expenses.reduce(function (sum, expense) {
        return sum + (Number(expense.amount) || 0);
      }, 0),
      expenseCount: expenses.length,
      people: (people || state.people).slice(0, 3),
    };
  }

  function persistAndRender() {
    saveLocal();
    render();
  }

  function loadLocal() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved) return;
      state.people = Array.isArray(saved.people) && saved.people.length === 3 ? saved.people : DEFAULT_PEOPLE.slice();
      state.expenses = Array.isArray(saved.expenses) ? normalizeExpenses(saved.expenses) : [];
      state.archive = Array.isArray(saved.archive) ? normalizeArchive(saved.archive) : [];
      state.cycles = Array.isArray(saved.cycles) ? normalizeCycles(saved.cycles) : [];
      state.paidSettlements = Array.isArray(saved.paidSettlements) ? uniqueStrings(saved.paidSettlements) : [];
      state.currentCycle = validCycle(saved.currentCycle) ? saved.currentCycle : currentCycleId();
      state.apiUrl = DEFAULT_API_URL;
    } catch (error) {
      state.people = DEFAULT_PEOPLE.slice();
      state.expenses = [];
      state.archive = [];
      state.cycles = [];
      state.paidSettlements = [];
      state.currentCycle = currentCycleId();
      state.apiUrl = DEFAULT_API_URL;
    }
  }

  function saveLocal() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        people: state.people,
        expenses: state.expenses,
        archive: state.archive,
        cycles: state.cycles,
        paidSettlements: state.paidSettlements,
        currentCycle: state.currentCycle,
        apiUrl: DEFAULT_API_URL,
      }),
    );
  }

  async function syncFromSheet() {
    if (!state.apiUrl || state.isSyncing) return;
    state.isSyncing = true;
    setSyncStatus("Syncing");
    let status = "Synced";
    try {
      const result = await getSheet();
      applySheetState(result);
    } catch (error) {
      status = "Sheet error";
    } finally {
      state.isSyncing = false;
      setSyncStatus(status);
    }
  }

  async function postThenSync(payload, options) {
    if (!state.apiUrl || state.isSyncing) return false;
    state.isSyncing = true;
    setSyncStatus("Syncing");
    let status = "Synced";
    let ok = true;
    try {
      const postResult = await postSheet(payload);
      if (postResult && postResult.ok === false) {
        throw new Error(postResult.error || "Sheet write failed");
      }
      await delay(350);
      const result = await getSheet();
      applySheetState(result);
      if (
        options &&
        options.expectedExpenseId &&
        !state.expenses.some(function (expense) {
          return expense.id === options.expectedExpenseId;
        })
      ) {
        throw new Error("Expense was not saved to Sheet");
      }
    } catch (error) {
      status = "Sheet error";
      ok = false;
    } finally {
      state.isSyncing = false;
      setSyncStatus(status);
    }
    return ok;
  }

  async function getSheet() {
    if (isAppsScriptUrl(state.apiUrl)) {
      return getSheetJsonp();
    }
    const response = await fetch(withQuery(state.apiUrl, "mode=read"), { method: "GET", cache: "no-store" });
    return response.json();
  }

  async function postSheet(payload) {
    if (isAppsScriptUrl(state.apiUrl)) {
      return getSheetJsonp(payload);
    }
    const response = await fetch(state.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    return response.json();
  }

  function getSheetJsonp(payload) {
    return new Promise(function (resolve, reject) {
      const callbackName = "__houseSplitSheet" + Date.now().toString(36);
      const script = document.createElement("script");
      const timeout = window.setTimeout(function () {
        cleanup();
        reject(new Error("Sheet sync timed out"));
      }, 12000);

      window[callbackName] = function (data) {
        cleanup();
        resolve(data);
      };
      script.onerror = function () {
        cleanup();
        reject(new Error("Sheet sync failed"));
      };
      const query = ["callback=" + encodeURIComponent(callbackName)];
      if (payload) {
        query.push("payload=" + encodeURIComponent(JSON.stringify(payload)));
      } else {
        query.push("mode=read");
      }
      script.src = withQuery(state.apiUrl, query.join("&"));
      document.head.appendChild(script);

      function cleanup() {
        window.clearTimeout(timeout);
        delete window[callbackName];
        script.remove();
      }
    });
  }

  function setSyncStatus(text) {
    els.syncStatus.textContent = text;
    els.syncButton.disabled = state.isSyncing || !state.apiUrl;
  }

  function startAutoSync() {
    window.setInterval(function () {
      if (state.apiUrl && !document.hidden) {
        syncFromSheet();
      }
    }, SYNC_INTERVAL_MS);
    document.addEventListener("visibilitychange", function () {
      if (state.apiUrl && !document.hidden) {
        syncFromSheet();
      }
    });
    window.addEventListener("focus", function () {
      if (state.apiUrl) {
        syncFromSheet();
      }
    });
  }

  function applySheetState(result) {
    if (!result || result.ok === false) {
      throw new Error((result && result.error) || "Sheet read failed");
    }
    if (Array.isArray(result.people) && result.people.length === 3) {
      state.people = result.people;
    }
    if (Array.isArray(result.expenses)) {
      state.expenses = normalizeExpenses(result.expenses);
    }
    if (Array.isArray(result.archive)) {
      state.archive = normalizeArchive(result.archive);
    }
    if (Array.isArray(result.cycles)) {
      state.cycles = normalizeCycles(result.cycles);
    }
    if (Array.isArray(result.paidSettlements)) {
      state.paidSettlements = uniqueStrings(result.paidSettlements);
    }
    if (validCycle(result.currentCycle)) {
      state.currentCycle = result.currentCycle;
    }
    saveLocal();
    render();
  }

  function normalizeExpenses(expenses) {
    return mergeExpenses(
      expenses
        .map(function (expense) {
          return normalizeExpense(expense);
        })
        .filter(function (expense) {
          return expense.amount > 0 && expense.participants.length;
        }),
    );
  }

  function normalizeArchive(expenses) {
    return mergeArchivedExpenses(
      expenses
        .map(function (expense) {
          const normalized = normalizeExpense(expense);
          normalized.cycle = validCycle(expense.cycle) ? expense.cycle : state.currentCycle || currentCycleId();
          normalized.closedAt = expense.closedAt || expense.createdAt || new Date().toISOString();
          return normalized;
        })
        .filter(function (expense) {
          return expense.amount > 0 && expense.participants.length;
        }),
    );
  }

  function normalizeExpense(expense) {
    return {
      id: String(expense.id || Date.now()),
      item: String(expense.item || "Untitled"),
      amount: Number(expense.amount) || 0,
      paidBy: clampIndex(expense.paidBy),
      participants: Array.isArray(expense.participants)
        ? expense.participants.map(clampIndex).filter(unique)
        : [0, 1, 2],
      date: expense.date || today(),
      createdAt: expense.createdAt || new Date().toISOString(),
    };
  }

  function normalizeCycles(cycles) {
    return mergeCycles(
      cycles
        .map(function (cycle) {
          return {
            cycle: validCycle(cycle.cycle) ? cycle.cycle : currentCycleId(),
            closedAt: cycle.closedAt || new Date().toISOString(),
            total: Number(cycle.total) || 0,
            expenseCount: Number(cycle.expenseCount) || 0,
            people: Array.isArray(cycle.people) && cycle.people.length === 3 ? cycle.people : state.people.slice(),
          };
        })
        .filter(function (cycle) {
          return validCycle(cycle.cycle);
        }),
    );
  }

  function formatAmountInput() {
    const number = parseAmount(els.amountInput.value);
    els.amountInput.value = number ? money(number) : "";
  }

  function parseAmount(value) {
    return Number(String(value).replace(/[^\d]/g, ""));
  }

  function money(value) {
    return "Rp " + numberWithDots(value);
  }

  function compactAmount(value) {
    const amount = Math.round(Number(value) || 0);
    const absolute = Math.abs(amount);
    if (absolute >= 1000000) {
      return trimCompact(amount / 1000000) + "jt";
    }
    if (absolute >= 1000) {
      return trimCompact(amount / 1000) + "rb";
    }
    return String(amount);
  }

  function trimCompact(value) {
    return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  }

  function numberWithDots(value) {
    return new Intl.NumberFormat("id-ID", {
      maximumFractionDigits: 0,
    }).format(Math.round(value || 0));
  }

  function today() {
    const date = new Date();
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    return date.toISOString().slice(0, 10);
  }

  function currentCycleId() {
    const date = new Date();
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }

  function nextCycleId(cycle) {
    if (!validCycle(cycle)) return currentCycleId();
    const parts = cycle.split("-");
    const date = new Date(Number(parts[0]), Number(parts[1]), 1);
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }

  function cycleLabel(cycle, options) {
    const opts = options || {};
    if (!validCycle(cycle)) return "This cycle";
    const parts = cycle.split("-");
    const date = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    if (opts.short) {
      return new Intl.DateTimeFormat("en", { month: "short" }).format(date);
    }
    if (opts.withYear) {
      return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(date);
    }
    return new Intl.DateTimeFormat("en", { month: "long" }).format(date);
  }

  function validCycle(cycle) {
    return /^\d{4}-\d{2}$/.test(String(cycle || ""));
  }

  function cycleSortValue(cycle) {
    if (!validCycle(cycle)) return 0;
    return Number(cycle.replace("-", ""));
  }

  function readableDate(value) {
    return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short" }).format(new Date(value));
  }

  function withQuery(url, query) {
    return url + (url.includes("?") ? "&" : "?") + query;
  }

  function mergeExpenses(expenses) {
    const seen = new Set();
    return expenses
      .filter(function (expense) {
        if (seen.has(expense.id)) return false;
        seen.add(expense.id);
        return true;
      })
      .sort(function (a, b) {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      });
  }

  function mergeArchivedExpenses(expenses) {
    const seen = new Set();
    return expenses
      .filter(function (expense) {
        const key = expense.cycle + "-" + expense.id;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(function (a, b) {
        return (
          cycleSortValue(b.cycle) - cycleSortValue(a.cycle) ||
          new Date(b.createdAt || b.closedAt).getTime() - new Date(a.createdAt || a.closedAt).getTime()
        );
      });
  }

  function mergeCycles(cycles) {
    const map = {};
    cycles.forEach(function (cycle) {
      if (!validCycle(cycle.cycle)) return;
      if (!map[cycle.cycle]) {
        map[cycle.cycle] = cycle;
      }
    });
    return Object.keys(map)
      .map(function (cycle) {
        return map[cycle];
      })
      .sort(function (a, b) {
        return cycleSortValue(b.cycle) - cycleSortValue(a.cycle);
      });
  }

  function delay(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, ms);
    });
  }

  function personIcon(index) {
    const icons = ["🐙", "🐧", "🐹"];
    return '<span class="mate-avatar avatar-' + index + '" aria-hidden="true">' + icons[index] + "</span>";
  }

  function isAppsScriptUrl(url) {
    return /script\.google\.com|script\.googleusercontent\.com/.test(url);
  }

  function createId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return String(Date.now()) + "-" + Math.random().toString(36).slice(2);
  }

  function clampIndex(value) {
    const index = Number(value);
    if (index < 0) return 0;
    if (index > 2) return 2;
    return index;
  }

  function unique(value, index, array) {
    return array.indexOf(value) === index;
  }

  function uniqueStrings(values) {
    return (values || [])
      .map(function (value) {
        return String(value || "");
      })
      .filter(function (value, index, array) {
        return value && array.indexOf(value) === index;
      });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  init();
})();
