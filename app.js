(function () {
  const STORAGE_KEY = "house-split-state-v1";
  const DEFAULT_PEOPLE = ["You", "Mate 1", "Mate 2"];
  const state = {
    people: DEFAULT_PEOPLE.slice(),
    expenses: [],
    apiUrl: "",
    splitCount: 3,
    paidBy: 0,
    participants: [0, 1, 2],
    isSyncing: false,
  };

  const els = {
    cycleLabel: document.getElementById("cycleLabel"),
    totalShared: document.getElementById("totalShared"),
    expenseForm: document.getElementById("expenseForm"),
    itemInput: document.getElementById("itemInput"),
    amountInput: document.getElementById("amountInput"),
    dateInput: document.getElementById("dateInput"),
    paidByGroup: document.getElementById("paidByGroup"),
    splitModeGroup: document.getElementById("splitModeGroup"),
    participantsGroup: document.getElementById("participantsGroup"),
    personSummary: document.getElementById("personSummary"),
    settlementList: document.getElementById("settlementList"),
    expenseList: document.getElementById("expenseList"),
    syncStatus: document.getElementById("syncStatus"),
    syncButton: document.getElementById("syncButton"),
    closeMonthButton: document.getElementById("closeMonthButton"),
    settingsButton: document.getElementById("settingsButton"),
    settingsDialog: document.getElementById("settingsDialog"),
    apiUrlInput: document.getElementById("apiUrlInput"),
    clearApiButton: document.getElementById("clearApiButton"),
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
    els.dateInput.value = today();
    bindEvents();
    render();
    if (state.apiUrl) {
      syncFromSheet();
    }
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
    els.closeMonthButton.addEventListener("click", closeMonth);
    els.settingsButton.addEventListener("click", openSettings);
    els.clearApiButton.addEventListener("click", clearApiUrl);
    els.saveSettingsButton.addEventListener("click", saveSettings);
    els.expenseList.addEventListener("click", deleteExpense);
  }

  function addExpense(event) {
    event.preventDefault();
    const item = els.itemInput.value.trim();
    const amount = parseAmount(els.amountInput.value);
    if (!item || !amount || state.participants.length !== state.splitCount) {
      return;
    }

    state.expenses.unshift({
      id: createId(),
      item,
      amount,
      paidBy: state.paidBy,
      participants: state.participants.slice().sort(),
      date: els.dateInput.value || today(),
      createdAt: new Date().toISOString(),
    });

    els.itemInput.value = "";
    els.amountInput.value = "";
    els.itemInput.focus();
    persistAndRender();
    saveToSheet();
  }

  function deleteExpense(event) {
    const button = event.target.closest("[data-delete-id]");
    if (!button) return;
    state.expenses = state.expenses.filter(function (expense) {
      return expense.id !== button.dataset.deleteId;
    });
    persistAndRender();
    saveToSheet();
  }

  async function closeMonth() {
    if (!state.expenses.length) return;
    const confirmed = window.confirm("Reset this month after everyone has paid?");
    if (!confirmed) return;
    const currentExpenses = state.expenses.slice();
    state.expenses = [];
    persistAndRender();
    if (state.apiUrl) {
      try {
        await postSheet({ action: "closeMonth", expenses: currentExpenses, people: state.people });
        setSyncStatus("Synced");
      } catch (error) {
        state.expenses = currentExpenses;
        persistAndRender();
        setSyncStatus("Sheet error");
      }
    }
  }

  function setSplitMode(event) {
    const button = event.target.closest("[data-split]");
    if (!button) return;
    state.splitCount = Number(button.dataset.split);
    if (state.splitCount === 3) {
      state.participants = [0, 1, 2];
    } else {
      const preferred = state.participants.filter(function (index) {
        return index !== state.paidBy;
      });
      const nextPerson = preferred.length
        ? preferred[0]
        : [0, 1, 2].find(function (index) {
            return index !== state.paidBy;
          });
      state.participants = [state.paidBy, nextPerson];
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
    }
    renderControls();
  }

  function toggleParticipant(event) {
    const button = event.target.closest("[data-participant]");
    if (!button || state.splitCount === 3) return;
    const personIndex = Number(button.dataset.participant);
    if (personIndex === state.paidBy) {
      return;
    }
    state.participants = [state.paidBy, personIndex];
    renderControls();
  }

  function openSettings() {
    els.personInputs.forEach(function (input, index) {
      input.value = state.people[index] || DEFAULT_PEOPLE[index];
    });
    els.apiUrlInput.value = state.apiUrl;
    if (typeof els.settingsDialog.showModal === "function") {
      els.settingsDialog.showModal();
    } else {
      els.settingsDialog.setAttribute("open", "");
    }
  }

  function saveSettings() {
    state.people = els.personInputs.map(function (input, index) {
      return input.value.trim() || DEFAULT_PEOPLE[index];
    });
    state.apiUrl = els.apiUrlInput.value.trim();
    state.paidBy = Math.min(state.paidBy, 2);
    if (state.splitCount === 3) {
      state.participants = [0, 1, 2];
    }
    persistAndRender();
    closeSettings();
    saveToSheet();
  }

  function clearApiUrl() {
    state.apiUrl = "";
    els.apiUrlInput.value = "";
    persistAndRender();
  }

  function closeSettings() {
    if (typeof els.settingsDialog.close === "function") {
      els.settingsDialog.close();
    } else {
      els.settingsDialog.removeAttribute("open");
    }
  }

  function render() {
    els.cycleLabel.textContent = monthLabel();
    renderControls();
    renderSummary();
    renderSettlements();
    renderExpenses();
    setSyncStatus(state.apiUrl ? "Sheet" : "Local");
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
          (state.splitCount === 3 || index === state.paidBy ? "disabled" : "") +
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
    const summary = calculateSummary();
    els.totalShared.textContent = money(summary.total);
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
    const settlements = calculateSettlements();
    if (!settlements.length) {
      renderEmpty(els.settlementList, "All square");
      return;
    }
    els.settlementList.innerHTML = settlements
      .map(function (settlement) {
        return (
          '<div class="settlement-item">' +
          '<div class="row-icon row-icon-transfer" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 7h11"/><path d="m15 4 3 3-3 3"/><path d="M17 17H6"/><path d="m9 14-3 3 3 3"/></svg></div>' +
          '<div class="settlement-copy"><strong>' +
          escapeHtml(settlement.from) +
          " pays " +
          escapeHtml(settlement.to) +
          "</strong><small>Monthly settlement</small></div><span>" +
          money(settlement.amount) +
          "</span></div>"
        );
      })
      .join("");
  }

  function renderExpenses() {
    if (!state.expenses.length) {
      renderEmpty(els.expenseList, "No spending yet");
      return;
    }
    els.expenseList.innerHTML = state.expenses
      .map(function (expense) {
        const participants = expense.participants
          .map(function (index) {
            return state.people[index];
          })
          .join(", ");
        return (
          '<article class="expense-item">' +
          '<div class="row-icon row-icon-payment" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M6 7V5h12v2"/><path d="M6 7v12h12V7"/><path d="M9 11v4"/><path d="M12 11v4"/><path d="M15 11v4"/></svg></div>' +
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
          '<button class="delete-button" type="button" aria-label="Delete" title="Delete" data-delete-id="' +
          escapeHtml(expense.id) +
          '">' +
          '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>' +
          "</button>" +
          "</article>"
        );
      })
      .join("");
  }

  function renderEmpty(target, text) {
    const empty = els.emptyStateTemplate.content.firstElementChild.cloneNode(true);
    empty.textContent = text;
    target.replaceChildren(empty);
  }

  function calculateSummary() {
    const people = state.people.map(function (name) {
      return { name: name, paid: 0, share: 0, balance: 0 };
    });
    let total = 0;
    state.expenses.forEach(function (expense) {
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

  function calculateSettlements() {
    const summary = calculateSummary().people;
    const debtors = summary
      .filter(function (person) {
        return person.balance < 0;
      })
      .map(function (person) {
        return { name: person.name, amount: Math.abs(person.balance) };
      });
    const creditors = summary
      .filter(function (person) {
        return person.balance > 0;
      })
      .map(function (person) {
        return { name: person.name, amount: person.balance };
      });
    const settlements = [];
    let debtorIndex = 0;
    let creditorIndex = 0;
    while (debtors[debtorIndex] && creditors[creditorIndex]) {
      const debtor = debtors[debtorIndex];
      const creditor = creditors[creditorIndex];
      const amount = Math.min(debtor.amount, creditor.amount);
      if (amount > 0) {
        settlements.push({ from: debtor.name, to: creditor.name, amount: Math.round(amount) });
      }
      debtor.amount -= amount;
      creditor.amount -= amount;
      if (debtor.amount < 1) debtorIndex += 1;
      if (creditor.amount < 1) creditorIndex += 1;
    }
    return settlements;
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
      state.apiUrl = saved.apiUrl || "";
    } catch (error) {
      state.people = DEFAULT_PEOPLE.slice();
      state.expenses = [];
    }
  }

  function saveLocal() {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        people: state.people,
        expenses: state.expenses,
        apiUrl: state.apiUrl,
      }),
    );
  }

  async function syncFromSheet() {
    if (!state.apiUrl || state.isSyncing) return;
    state.isSyncing = true;
    setSyncStatus("Syncing");
    try {
      const result = await getSheet();
      if (Array.isArray(result.people) && result.people.length === 3) {
        state.people = result.people;
      }
      if (Array.isArray(result.expenses)) {
        state.expenses = normalizeExpenses(result.expenses);
      }
      saveLocal();
      render();
      setSyncStatus("Synced");
    } catch (error) {
      setSyncStatus("Sheet error");
    } finally {
      state.isSyncing = false;
    }
  }

  async function saveToSheet() {
    if (!state.apiUrl || state.isSyncing) return;
    state.isSyncing = true;
    setSyncStatus("Syncing");
    try {
      await postSheet({ action: "replace", people: state.people, expenses: state.expenses });
      setSyncStatus("Synced");
    } catch (error) {
      setSyncStatus("Sheet error");
    } finally {
      state.isSyncing = false;
    }
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
      await postSheetNoCors(payload);
      return { ok: true };
    }
    const response = await fetch(state.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    return response.json();
  }

  function getSheetJsonp() {
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
      script.src = withQuery(state.apiUrl, "mode=read&callback=" + encodeURIComponent(callbackName));
      document.head.appendChild(script);

      function cleanup() {
        window.clearTimeout(timeout);
        delete window[callbackName];
        script.remove();
      }
    });
  }

  function postSheetNoCors(payload) {
    return fetch(state.apiUrl, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
  }

  function setSyncStatus(text) {
    els.syncStatus.textContent = text;
    els.syncButton.disabled = state.isSyncing || !state.apiUrl;
  }

  function normalizeExpenses(expenses) {
    return expenses
      .map(function (expense) {
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
      })
      .filter(function (expense) {
        return expense.amount > 0 && expense.participants.length;
      });
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

  function monthLabel() {
    return new Intl.DateTimeFormat("en", { month: "long", year: "numeric" }).format(new Date());
  }

  function readableDate(value) {
    return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short" }).format(new Date(value));
  }

  function withQuery(url, query) {
    return url + (url.includes("?") ? "&" : "?") + query;
  }

  function personIcon(index) {
    const icons = ["🦆", "🐧", "🦭"];
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
