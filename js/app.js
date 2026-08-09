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
let localGuests = [];
let localDataError = null;
const localReady = CONFIG.MODE === "local"
  ? window.RSVP_DATA.loadGuests()
      .then(guests => { localGuests = guests; return guests; })
      .catch(error => { localDataError = error; throw error; })
  : Promise.resolve([]);

function normalizeName(value = "") {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function matchScore(name, query) {
  const n = normalizeName(name);
  const q = normalizeName(query);
  if (!q) return 0;
  if (n === q) return 1000;
  if (n.startsWith(q)) return 900 - (n.length - q.length);
  if (n.includes(q)) return 800 - n.indexOf(q);

  const nameWords = n.split(" ");
  const queryWords = q.split(" ");
  let score = 0;
  let matchedWords = 0;

  for (const qWord of queryWords) {
    let best = 0;
    for (const nWord of nameWords) {
      if (nWord === qWord) best = Math.max(best, 170);
      else if (nWord.startsWith(qWord)) best = Math.max(best, 145 - Math.abs(nWord.length - qWord.length));
      else if (qWord.length >= 3 && nWord.includes(qWord)) best = Math.max(best, 120);
      else {
        const distance = levenshtein(nWord, qWord);
        const maxLen = Math.max(nWord.length, qWord.length);
        const similarity = 1 - distance / maxLen;
        if (similarity >= 0.68) best = Math.max(best, Math.round(similarity * 100));
      }
    }
    if (best > 0) matchedWords += 1;
    score += best;
  }

  if (queryWords.length > 1 && matchedWords < queryWords.length) return Math.round(score * 0.25);
  return score;
}

function rankGuests(database, query, limit = 5) {
  const q = normalizeName(query);
  if (q.length < 2) return [];

  return database
    .map(guest => ({ guest, score: matchScore(guest.name, q) }))
    .filter(item => item.score >= 70)
    .sort((a, b) => b.score - a.score || a.guest.name.localeCompare(b.guest.name, "es"))
    .slice(0, limit)
    .map(item => item.guest);
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

let jsonpSequence = 0;

function jsonpRequest(baseUrl, params = {}) {
  return new Promise((resolve, reject) => {
    jsonpSequence += 1;

    // Callback deliberadamente simple: solo letras y números.
    // Apps Script lo devuelve como: rsvpCallback123({...})
    const callbackName = `rsvpCallback${Date.now()}${jsonpSequence}`;
    const script = document.createElement("script");
    const url = new URL(baseUrl);
    let finished = false;

    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });
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
      reject(new Error("La conexión está tardando demasiado. Intenta nuevamente."));
    }, 25000);

    window[callbackName] = function (data) {
      if (finished) return;
      cleanup();
      resolve(data);
    };

    script.type = "text/javascript";
    script.async = true;
    script.onerror = () => {
      if (finished) return;
      cleanup();
      reject(new Error("No se pudo conectar con la lista de invitados."));
    };

    script.src = url.toString();
    document.body.appendChild(script);
  });
}

async function searchGuests(name) {
  if (CONFIG.MODE === "local") {
    if (localDataError) throw localDataError;
    await localReady;
    return rankGuests(localGuests, name);
  }

  const data = await jsonpRequest(CONFIG.GOOGLE_SCRIPT_URL, { buscar: name });

  if (!data || !data.ok) {
    throw new Error((data && data.error) || "No se pudo realizar la búsqueda.");
  }

  const resultados = Array.isArray(data.resultados) ? data.resultados : [];
  return resultados.map(guest => ({
    id: String(guest.id || ""),
    name: String(guest.nombre || ""),
    status: "Pendiente",
    note: "",
    updatedAt: ""
  })).filter(guest => guest.id && guest.name);
}

function postRsvpWithHiddenForm(payload) {
  return new Promise((resolve, reject) => {
    const frameName = `rsvpPostFrame_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const iframe = document.createElement("iframe");
    const form = document.createElement("form");

    iframe.name = frameName;
    iframe.style.display = "none";
    iframe.setAttribute("aria-hidden", "true");

    form.method = "POST";
    form.action = CONFIG.GOOGLE_SCRIPT_URL;
    form.target = frameName;
    form.style.display = "none";

    const fields = {
      id: payload.id,
      estado: payload.status,
      mensaje: payload.note || ""
    };

    Object.entries(fields).forEach(([name, value]) => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = String(value ?? "");
      form.appendChild(input);
    });

    let submitted = false;
    let cleaned = false;

    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      setTimeout(() => {
        if (form.parentNode) form.parentNode.removeChild(form);
        if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
      }, 1500);
    }

    iframe.addEventListener("load", () => {
      if (!submitted) return;
      cleanup();
      resolve();
    });

    iframe.addEventListener("error", () => {
      cleanup();
      reject(new Error("No se pudo enviar la confirmación."));
    });

    document.body.appendChild(iframe);
    document.body.appendChild(form);

    try {
      submitted = true;
      form.submit();
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }

    // Aunque el navegador no permita inspeccionar la respuesta por ser otro dominio,
    // el POST ya fue enviado. Damos tiempo a Apps Script para procesarlo y luego
    // verificamos el resultado por JSONP.
    setTimeout(() => {
      if (!cleaned) {
        cleanup();
        resolve();
      }
    }, 2200);
  });
}

async function getRsvpStatus(id) {
  const data = await jsonpRequest(CONFIG.GOOGLE_SCRIPT_URL, {
    accion: "estado",
    id
  });

  if (!data || !data.ok) {
    throw new Error((data && data.error) || "No se pudo verificar la confirmación.");
  }

  return data.invitado || null;
}

async function verifyRsvp(id, expectedStatus, expectedNote) {
  const waits = [500, 900, 1400, 2200];

  for (const wait of waits) {
    await new Promise(resolve => setTimeout(resolve, wait));
    try {
      const guest = await getRsvpStatus(id);
      if (!guest) continue;

      const statusMatches = String(guest.estado || "") === String(expectedStatus || "");
      const noteMatches = String(guest.mensaje || "") === String(expectedNote || "");

      if (statusMatches && noteMatches) return guest;
    } catch (_) {
      // Reintentamos unas veces porque Sheets puede tardar un instante en reflejar el cambio.
    }
  }

  throw new Error("La respuesta no llegó a Google Sheets. Inténtalo nuevamente.");
}

async function saveRsvp(payload) {
  if (CONFIG.MODE === "local") {
    await localReady;
    const index = localGuests.findIndex(g => g.id === payload.id);
    if (index < 0) throw new Error("Invitación no encontrada.");

    const updatedAt = new Date().toISOString();
    const status = payload.attendance === "si" ? "Confirmado" : "No asiste";
    window.RSVP_DATA.updateGuest(payload.id, {
      status,
      note: payload.note,
      updatedAt
    });

    localGuests[index] = {
      ...localGuests[index],
      status,
      note: payload.note,
      updatedAt
    };
    return { ok: true };
  }

  const status = payload.attendance === "si" ? "Confirmado" : "No asiste";

  await postRsvpWithHiddenForm({
    id: payload.id,
    status,
    note: payload.note || ""
  });

  const savedGuest = await verifyRsvp(payload.id, status, payload.note || "");
  return { ok: true, invitado: savedGuest };
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
      <span>${guest.name}</span>
    </button>
  `).join("");
  suggestionsBox.classList.remove("hidden");
  guestNameInput.setAttribute("aria-expanded", "true");
}

function openRsvp(guest) {
  selectedGuest = guest;
  $("#welcomeName").textContent = `¡Hola, ${guest.name.split(" ")[0]}!`;
  $("#guestStatus").textContent = guest.status || "Pendiente";

  rsvpForm.reset();
  if (guest.note) $("#guestNote").value = guest.note;
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
    return;
  }

  try {
    const matches = await searchGuests(query);
    if (guestNameInput.value.trim() === query) renderSuggestions(matches);
  } catch (_) {
    hideSuggestions();
  }
}


if (CONFIG.MODE === "local") {
  localReady.catch(error => {
    showMessage(searchMessage, error.message, "error");
  });
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
    setLoading(button, true, "Buscando…");
    const matches = await searchGuests(name);
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
    showMessage(searchMessage, error.message, "error");
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
    showMessage(rsvpMessage, error.message, "error");
  } finally {
    setLoading(button, false);
  }
});

$("#backBtn").addEventListener("click", resetFlow);
$("#restartBtn").addEventListener("click", resetFlow);
