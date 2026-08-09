const $ = (selector) => document.querySelector(selector);
const CONFIG = window.RSVP_CONFIG;

let db = [];
let selectedIds = new Set();
let editingId = null;
let pendingDeleteIds = [];
let sortState = { key: "id", direction: "asc" };
let adminKey = sessionStorage.getItem("matteo-rsvp-admin-key") || "";
let jsonpSequence = 0;

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function statusClass(status) {
  if (status === "Confirmado") return "confirmed";
  if (status === "No asiste") return "no";
  return "pending";
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString("es-CL");
}

function normalizeSortText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function compareGuests(a, b, key, direction) {
  const dir = direction === "desc" ? -1 : 1;
  const av = a[key];
  const bv = b[key];

  const aEmpty = av == null || String(av).trim() === "";
  const bEmpty = bv == null || String(bv).trim() === "";
  if (aEmpty && !bEmpty) return 1;
  if (!aEmpty && bEmpty) return -1;
  if (aEmpty && bEmpty) return String(a.id).localeCompare(String(b.id), "es", { numeric: true });

  if (key === "updatedAt") {
    const at = new Date(av).getTime();
    const bt = new Date(bv).getTime();
    if (at !== bt) return (at - bt) * dir;
  } else {
    const result = normalizeSortText(av).localeCompare(normalizeSortText(bv), "es", {
      sensitivity: "base",
      numeric: true
    });
    if (result !== 0) return result * dir;
  }

  return String(a.id).localeCompare(String(b.id), "es", { numeric: true });
}

function getSortedDb() {
  return [...db].sort((a, b) => compareGuests(a, b, sortState.key, sortState.direction));
}

function renderSortHeaders() {
  document.querySelectorAll(".sort-btn").forEach(button => {
    const active = button.dataset.sort === sortState.key;
    button.classList.toggle("is-active", active);
    const arrows = button.querySelector(".sort-arrows");
    if (arrows) arrows.textContent = active ? (sortState.direction === "asc" ? "↑" : "↓") : "↕";
  });
}

function render() {
  const visibleDb = getSortedDb();
  selectedIds = new Set([...selectedIds].filter(id => db.some(g => g.id === id)));

  $("#statInvites").textContent = db.length;
  $("#statConfirmed").textContent = db.filter(x => x.status === "Confirmado").length;
  $("#statNo").textContent = db.filter(x => x.status === "No asiste").length;

  $("#guestRows").innerHTML = visibleDb.map(g => `
    <tr>
      <td><input class="check row-check" type="checkbox" data-id="${escapeHtml(g.id)}" ${selectedIds.has(g.id) ? "checked" : ""} aria-label="Seleccionar ${escapeHtml(g.name)}"></td>
      <td>${escapeHtml(g.id)}</td>
      <td><strong>${escapeHtml(g.name)}</strong></td>
      <td><span class="status-badge ${statusClass(g.status)}">${escapeHtml(g.status || "Pendiente")}</span></td>
      <td>${escapeHtml(g.note || "—")}</td>
      <td>${escapeHtml(formatDate(g.updatedAt))}</td>
      <td>
        <div class="row-actions">
          <button class="icon-btn edit-row" type="button" data-id="${escapeHtml(g.id)}">Editar</button>
          <button class="icon-btn delete delete-row" type="button" data-id="${escapeHtml(g.id)}">Borrar</button>
        </div>
      </td>
    </tr>
  `).join("");

  $("#emptyState").classList.toggle("hidden", db.length !== 0);

  const allChecked = db.length > 0 && selectedIds.size === db.length;
  const someChecked = selectedIds.size > 0 && !allChecked;
  $("#selectAll").checked = allChecked;
  $("#selectAll").indeterminate = someChecked;
  $("#selectionCount").textContent = `${selectedIds.size} seleccionado${selectedIds.size === 1 ? "" : "s"}`;
  $("#deleteSelected").disabled = selectedIds.size === 0;
  $("#selectAllBtn").textContent = allChecked ? "Quitar selección" : "Seleccionar todos";
  renderSortHeaders();
}

function getAdminKey() {
  if (adminKey) return adminKey;
  const entered = window.prompt("Ingresa la clave del panel de administración:");
  if (!entered) throw new Error("Debes ingresar la clave de administrador para abrir el panel.");
  adminKey = entered.trim();
  sessionStorage.setItem("matteo-rsvp-admin-key", adminKey);
  return adminKey;
}

function jsonpRequest(params = {}) {
  return new Promise((resolve, reject) => {
    jsonpSequence += 1;
    const callbackName = `rsvpAdminCallback${Date.now()}${jsonpSequence}`;
    const script = document.createElement("script");
    const url = new URL(CONFIG.GOOGLE_SCRIPT_URL);
    let finished = false;

    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    url.searchParams.set("prefix", callbackName);

    function cleanup() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("La conexión con Google Sheets está tardando demasiado."));
    }, 25000);

    window[callbackName] = function (data) {
      if (finished) return;
      cleanup();
      resolve(data);
    };

    script.async = true;
    script.type = "text/javascript";
    script.onerror = () => {
      if (finished) return;
      cleanup();
      reject(new Error("No se pudo conectar con Google Sheets. Si usas Brave, revisa Shields."));
    };
    script.src = url.toString();
    document.body.appendChild(script);
  });
}

async function loadDatabase() {
  try {
    const key = getAdminKey();
    const data = await jsonpRequest({ accion: "admin_lista", clave: key });

    if (!data || !data.ok) {
      if (data && data.error === "Clave de administrador incorrecta") {
        sessionStorage.removeItem("matteo-rsvp-admin-key");
        adminKey = "";
      }
      throw new Error((data && data.error) || "No se pudo leer Google Sheets.");
    }

    db = (data.invitados || []).map(g => ({
      id: String(g.id || ""),
      name: String(g.nombre || ""),
      status: String(g.estado || "Pendiente"),
      note: String(g.mensaje || ""),
      updatedAt: g.actualizacion || ""
    })).filter(g => g.id && g.name);

    $("#emptyState").textContent = "No hay invitados para mostrar.";
    render();
  } catch (error) {
    db = [];
    render();
    $("#emptyState").classList.remove("hidden");
    $("#emptyState").textContent = error.message;
  }
}

function postAdmin(fields) {
  return new Promise((resolve, reject) => {
    const frameName = `rsvpAdminPost_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const iframe = document.createElement("iframe");
    const form = document.createElement("form");

    iframe.name = frameName;
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");

    form.method = "POST";
    form.action = CONFIG.GOOGLE_SCRIPT_URL;
    form.target = frameName;
    form.style.display = "none";

    Object.entries(fields).forEach(([name, value]) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = String(value ?? "");
      form.appendChild(input);
    });

    document.body.appendChild(iframe);
    document.body.appendChild(form);

    try {
      form.submit();
    } catch (error) {
      iframe.remove();
      form.remove();
      reject(error);
      return;
    }

    setTimeout(() => {
      iframe.remove();
      form.remove();
      resolve();
    }, 1200);
  });
}

function openModal(selector) {
  $(selector).classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeModals() {
  $("#editModal").classList.add("hidden");
  $("#deleteModal").classList.add("hidden");
  document.body.style.overflow = "";
}

function openEdit(id) {
  const guest = db.find(g => g.id === id);
  if (!guest) return;
  editingId = id;
  $("#editName").value = guest.name || "";
  $("#editStatus").value = guest.status || "Pendiente";
  $("#editNote").value = guest.note || "";
  openModal("#editModal");
  setTimeout(() => $("#editName").focus(), 0);
}

function askDelete(ids) {
  const valid = ids.filter(id => db.some(g => g.id === id));
  if (!valid.length) return;

  pendingDeleteIds = valid;
  if (valid.length === 1) {
    const guest = db.find(g => g.id === valid[0]);
    $("#deleteText").textContent = `Vas a borrar a ${guest.name} de Google Sheets.`;
  } else if (valid.length === db.length) {
    $("#deleteText").textContent = `Seleccionaste los ${valid.length} invitados. Si confirmas, se borrarán de Google Sheets.`;
  } else {
    $("#deleteText").textContent = `Vas a borrar ${valid.length} invitados de Google Sheets.`;
  }
  openModal("#deleteModal");
}

document.querySelector("thead").addEventListener("click", (event) => {
  const button = event.target.closest(".sort-btn");
  if (!button) return;

  const key = button.dataset.sort;
  if (sortState.key === key) {
    sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
  } else {
    sortState = { key, direction: "asc" };
  }
  render();
});

$("#guestRows").addEventListener("change", (event) => {
  const check = event.target.closest(".row-check");
  if (!check) return;
  if (check.checked) selectedIds.add(check.dataset.id);
  else selectedIds.delete(check.dataset.id);
  render();
});

$("#guestRows").addEventListener("click", (event) => {
  const edit = event.target.closest(".edit-row");
  if (edit) return openEdit(edit.dataset.id);
  const del = event.target.closest(".delete-row");
  if (del) askDelete([del.dataset.id]);
});

$("#selectAll").addEventListener("change", (event) => {
  selectedIds = event.target.checked ? new Set(db.map(g => g.id)) : new Set();
  render();
});

$("#selectAllBtn").addEventListener("click", () => {
  selectedIds = selectedIds.size === db.length && db.length > 0 ? new Set() : new Set(db.map(g => g.id));
  render();
});

$("#deleteSelected").addEventListener("click", () => askDelete([...selectedIds]));

$("#editForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!editingId) return;

  const submit = event.submitter;
  if (submit) submit.disabled = true;

  try {
    await postAdmin({
      accion: "admin_actualizar",
      clave: getAdminKey(),
      id: editingId,
      nombre: $("#editName").value.trim(),
      estado: $("#editStatus").value,
      mensaje: $("#editNote").value.trim()
    });
    closeModals();
    await loadDatabase();
  } catch (error) {
    alert(error.message || "No se pudo guardar el cambio.");
  } finally {
    if (submit) submit.disabled = false;
  }
});

$("#confirmDelete").addEventListener("click", async () => {
  if (!pendingDeleteIds.length) return;
  const button = $("#confirmDelete");
  button.disabled = true;

  try {
    await postAdmin({
      accion: "admin_borrar",
      clave: getAdminKey(),
      ids: JSON.stringify(pendingDeleteIds)
    });
    pendingDeleteIds = [];
    selectedIds.clear();
    closeModals();
    await loadDatabase();
  } catch (error) {
    alert(error.message || "No se pudo borrar.");
  } finally {
    button.disabled = false;
  }
});

document.addEventListener("click", (event) => {
  if (event.target.matches("[data-close-modal]")) closeModals();
  if (event.target.classList.contains("modal-backdrop")) closeModals();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModals();
});

loadDatabase();
