const $ = (selector) => document.querySelector(selector);
const CONFIG = window.RSVP_CONFIG;

const searchCard = $("#searchCard");
const rsvpCard = $("#rsvpCard");
const successCard = $("#successCard");
const searchForm = $("#searchForm");
const rsvpForm = $("#rsvpForm");
const searchMessage = $("#searchMessage");
const rsvpMessage = $("#rsvpMessage");
const guestNameInput = $("#guestName");
const suggestionsBox = $("#nameSuggestions");

let selectedGuest = null;
let currentMatches = [];
let suggestionTimer = null;
let activeSearchController = null;

function normalizeName(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function showMessage(el, text, type = "info") {
  el.textContent = text;
  el.className = `message ${type}`;
}

function hideMessage(el) {
  el.textContent = "";
  el.className = "message hidden";
}

function setLoading(button, state, label) {
  if (!button.dataset.original) button.dataset.original = button.innerHTML;
  button.disabled = state;
  button.innerHTML = state ? label : button.dataset.original;
}

function apiUrl(params = {}) {
  const url = new URL(CONFIG.API_URL);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
}

async function apiGet(params = {}, options = {}) {
  const response = await fetch(apiUrl(params), {
    method: "GET",
    mode: "cors",
    cache: "no-store",
    signal: options.signal,
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    throw new Error(`No se pudo conectar con la base de datos (${response.status}).`);
  }

  const data = await response.json();
  if (!data || data.ok !== true) {
    throw new Error((data && data.error) || "La base de datos respondió con un error.");
  }
  return data;
}

async function apiPost(payload) {
  const response = await fetch(CONFIG.API_URL, {
    method: "POST",
    mode: "cors",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`No se pudo guardar la respuesta (${response.status}).`);
  }

  const data = await response.json();
  if (!data || data.ok !== true) {
    throw new Error((data && data.error) || "No se pudo guardar la respuesta.");
  }
  return data;
}

async function searchGuests(name, signal) {
  const data = await apiGet({ buscar: name }, { signal });
  const resultados = Array.isArray(data.resultados) ? data.resultados : [];

  return resultados
    .map(guest => ({
      id: String(guest.id || ""),
      name: String(guest.nombre || ""),
      status: "Pendiente",
      note: "",
      updatedAt: ""
    }))
    .filter(guest => guest.id && guest.name);
}

async function saveRsvp(payload) {
  return apiPost({
    accion: "confirmar",
    id: payload.id,
    asistencia: payload.attendance,
    mensaje: payload.note || ""
  });
}

function hideSuggestions() {
  currentMatches = [];
  suggestionsBox.innerHTML = "";
  suggestionsBox.classList.add("hidden");
  guestNameInput.setAttribute("aria-expanded", "false");
}

function renderSuggestions(matches) {
  currentMatches = matches;
  if (!matches.length) {
    hideSuggestions();
    return;
  }

  suggestionsBox.innerHTML = matches.map((guest, index) => `
    <button class="suggestion-item" type="button" role="option" data-index="${index}">
      <span class="suggestion-icon">♡</span>
      <span>${escapeHtml(guest.name)}</span>
    </button>
  `).join("");

  suggestionsBox.classList.remove("hidden");
  guestNameInput.setAttribute("aria-expanded", "true");
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openRsvp(guest) {
  selectedGuest = guest;
  $("#welcomeName").textContent = `¡Hola, ${guest.name.split(" ")[0]}!`;
  $("#guestStatus").textContent = guest.status || "Pendiente";

  rsvpForm.reset();
  hideMessage(rsvpMessage);
  hideSuggestions();

  searchCard.classList.add("hidden");
  successCard.classList.add("hidden");
  rsvpCard.classList.remove("hidden");
  rsvpCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetFlow() {
  selectedGuest = null;
  searchForm.reset();
  rsvpForm.reset();
  hideMessage(searchMessage);
  hideMessage(rsvpMessage);
  hideSuggestions();
  rsvpCard.classList.add("hidden");
  successCard.classList.add("hidden");
  searchCard.classList.remove("hidden");
  guestNameInput.focus();
}

async function updateSuggestions() {
  const query = guestNameInput.value.trim();
  hideMessage(searchMessage);

  if (normalizeName(query).length < 2) {
    hideSuggestions();
    if (activeSearchController) activeSearchController.abort();
    return;
  }

  if (activeSearchController) activeSearchController.abort();
  activeSearchController = new AbortController();

  try {
    const matches = await searchGuests(query, activeSearchController.signal);
    if (guestNameInput.value.trim() === query) renderSuggestions(matches);
  } catch (error) {
    if (error.name === "AbortError") return;
    hideSuggestions();
    showMessage(searchMessage, "No se pudo conectar con la lista. Intenta nuevamente.", "error");
  }
}

guestNameInput.addEventListener("input", () => {
  clearTimeout(suggestionTimer);
  suggestionTimer = setTimeout(updateSuggestions, 250);
});

suggestionsBox.addEventListener("click", (event) => {
  const button = event.target.closest(".suggestion-item");
  if (!button) return;
  const guest = currentMatches[Number(button.dataset.index)];
  if (!guest) return;
  guestNameInput.value = guest.name;
  openRsvp(guest);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".search-combobox")) hideSuggestions();
});

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage(searchMessage);
  const button = searchForm.querySelector("button[type='submit']");
  const name = guestNameInput.value.trim();

  if (normalizeName(name).length < 2) {
    showMessage(searchMessage, "Escribe al menos dos letras de tu nombre para buscarte.", "error");
    return;
  }

  try {
    if (activeSearchController) activeSearchController.abort();
    activeSearchController = new AbortController();
    setLoading(button, true, "Buscando…");

    const matches = await searchGuests(name, activeSearchController.signal);
    if (!matches.length) {
      hideSuggestions();
      showMessage(searchMessage, "No encontramos una coincidencia. Prueba con tu nombre, apellido o una parte de ambos.", "error");
      return;
    }

    const exact = matches.find(g => normalizeName(g.name) === normalizeName(name));
    if (exact || matches.length === 1) {
      openRsvp(exact || matches[0]);
      return;
    }

    renderSuggestions(matches);
    showMessage(searchMessage, "Encontramos varias coincidencias. Selecciona tu nombre de la lista.", "info");
  } catch (error) {
    if (error.name !== "AbortError") showMessage(searchMessage, error.message, "error");
  } finally {
    setLoading(button, false);
  }
});

rsvpForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  hideMessage(rsvpMessage);
  const button = rsvpForm.querySelector("button[type='submit']");
  const attendance = rsvpForm.querySelector("input[name='attendance']:checked")?.value;

  if (!attendance) {
    showMessage(rsvpMessage, "Selecciona si podrás asistir o no.", "error");
    return;
  }

  const payload = {
    id: selectedGuest.id,
    attendance,
    note: $("#guestNote").value.trim()
  };

  try {
    setLoading(button, true, "Guardando…");
    await saveRsvp(payload);

    rsvpCard.classList.add("hidden");
    successCard.classList.remove("hidden");
    $("#successTitle").textContent = attendance === "si" ? "¡Qué alegría!" : "Gracias por avisarnos";
    $("#successText").textContent = attendance === "si"
      ? "Tu asistencia quedó confirmada. ¡Te esperamos para celebrar la llegada de Matteo!"
      : "Tu respuesta quedó registrada. Gracias por acompañarnos con tu cariño aunque esta vez no puedas venir.";
    successCard.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (error) {
    showMessage(rsvpMessage, error.message || "No se pudo guardar tu respuesta.", "error");
  } finally {
    setLoading(button, false);
  }
});

$("#backBtn").addEventListener("click", resetFlow);
$("#restartBtn").addEventListener("click", resetFlow);
