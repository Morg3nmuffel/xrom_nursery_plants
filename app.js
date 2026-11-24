const state = {
  cart: 0,
  chatStep: "idle",
  profile: { light: null, care: null },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function scrollToId(id) {
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showToast(text) {
  const toast = $("#toast");
  $("#toast-text").textContent = text;
  toast.classList.add("visible");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("visible"), 2600);
}

function addMessage(type, html, quickReplies = []) {
  const messages = $("#chat-messages");
  const row = document.createElement("div");
  row.className = `message-row ${type === "user" ? "user-row" : "assistant-row"}`;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = type === "user" ? "В" : "Л";
  const bubble = document.createElement("div");
  bubble.className = `message-bubble ${type === "user" ? "user-bubble" : "assistant-bubble"}`;
  bubble.innerHTML = `<span class="message-time">${type === "user" ? "Вы" : "Лея · сейчас"}</span><div>${html}</div>`;
  if (quickReplies.length) {
    const replies = document.createElement("div");
    replies.className = "quick-replies";
    quickReplies.forEach((reply) => {
      const button = document.createElement("button");
      button.className = "quick-reply";
      button.type = "button";
      button.dataset.prompt = reply;
      button.textContent = reply;
      replies.appendChild(button);
    });
    bubble.appendChild(replies);
  }
  row.append(avatar, bubble);
  messages.appendChild(row);
  messages.scrollTop = messages.scrollHeight;
}

function askForLight() {
  state.chatStep = "light";
  return {
    text: "Отлично. Сколько естественного света в месте, куда вы хотите поставить растение?",
    replies: ["Много света", "Рассеянный свет", "Почти темно"],
  };
}

function askForCare() {
  state.chatStep = "care";
  return {
    text: "И как обычно с поливом? Вы скорее забываете о нём или готовы ухаживать регулярно?",
    replies: ["Часто забываю", "Поливаю регулярно", "Хочу минимум ухода"],
  };
}

function recommendation() {
  state.chatStep = "done";
  const { light, care } = state.profile;
  if (light === "Почти темно" || care === "Часто забываю" || care === "Хочу минимум ухода") {
    return `<strong>Мой выбор — сансевиерия Moonshine.</strong><br>Она спокойно относится к тени, просит полив примерно раз в 2–3 недели и не обидится, если вы уедете на выходные.<br><br><span class="recommendation-meta">учебная цена · 1 290 ₽ · в наличии</span>`;
  }
  if (light === "Рассеянный свет") {
    return `<strong>Мой выбор — пеперомия Hope.</strong><br>Компактная, любит рассеянный свет и не требует сложных ритуалов. Хороший вариант для первого растения или рабочего стола.<br><br><span class="recommendation-meta">учебная цена · 1 490 ₽ · в наличии</span>`;
  }
  return `<strong>Мой выбор — фикус Elastica.</strong><br>Если света достаточно, он быстро даст объём и будет расти вместе с пространством. Полив — после просыхания верхних 3–4 см грунта.<br><br><span class="recommendation-meta">учебная цена · 3 190 ₽ · в наличии</span>`;
}

function answerTo(text) {
  const value = text.toLowerCase();
  const isRecommendation = value.includes("подбер") || value.includes("подбор") || value.includes("посовет") || value.includes("для офиса") || value.includes("хочу растение");

  if (state.chatStep === "light") {
    state.profile.light = text;
    return askForCare();
  }
  if (state.chatStep === "care") {
    state.profile.care = text;
    return { text: recommendation() };
  }
  if (isRecommendation) {
    state.profile = { light: null, care: null };
    return askForLight();
  }
  if (value.includes("сансев") || value.includes("щуч") || value.includes("полив") && value.includes("тень")) {
    return { text: "Сансеверию лучше поливать после полного просыхания грунта — в среднем раз в 2–3 недели. Зимой интервал можно увеличить. Главное правило: лучше недолить, чем перелить.", replies: ["Подбери мне растение", "А если листья желтеют?"] };
  }
  if (value.includes("фикус") && (value.includes("лист") || value.includes("опад") || value.includes("уход"))) {
    return { text: "Фикус может сбрасывать листья из-за резкой смены места, сквозняка, перелива или пересушки. Проверьте: стоит ли он стабильно, не касается ли батареи и успевает ли верхний слой грунта просыхать между поливами?" };
  }
  if (value.includes("свет") || value.includes("тень") || value.includes("темн") || value.includes("ванн")) {
    return { text: "Для места с небольшим количеством света в учебном каталоге подходят сансевиерия Moonshine и калатея Orbifolia. Даже теневыносливым растениям нужен рассеянный дневной свет — полностью без окна не обойдётся ни одно растение." };
  }
  if (value.includes("калат") || value.includes("влажн")) {
    return { text: "Калатея любит мягкий рассеянный свет, равномерную влажность грунта и влажный воздух. Не ставьте её у батареи и не поливайте холодной водой из-под крана." };
  }
  if (value.includes("цен") || value.includes("налич") || value.includes("есть ли")) {
    return { text: "В этом PoC цены и остатки учебные. В каталоге сейчас отмечены: сансевиерия — 1 290 ₽, пеперомия — 1 490 ₽, калатея — 2 690 ₽, фикус — 3 190 ₽. Для реального запуска эти данные подключаются к учётной системе питомника." };
  }
  return { text: "В учебной базе пока нет точного ответа на этот вопрос. Я не буду придумывать — передайте его команде, и мы добавим проверенный ответ в следующую версию.", replies: ["Оставить вопрос команде", "Подбери мне растение"] };
}

function sendPrompt(text) {
  if (!text || !text.trim()) return;
  addMessage("user", `<p>${escapeHtml(text.trim())}</p>`);
  const answer = answerTo(text.trim());
  window.setTimeout(() => addMessage("assistant", `<p>${answer.text}</p>`, answer.replies || []), 180);
}

function escapeHtml(text) {
  return text.replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#039;", '"': "&quot;" })[char]);
}

function updateCart(name) {
  state.cart += 1;
  $(".cart-count").textContent = state.cart;
  showToast(`${name} добавлено в учебную корзину`);
}

function initFilters() {
  $$(".filter-button").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".filter-button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      const filter = button.dataset.filter;
      $$(".product-card").forEach((card) => {
        card.classList.toggle("is-hidden", filter !== "all" && !card.dataset.category.split(" ").includes(filter));
      });
    });
  });
}

function initReveal() {
  const items = $$(".reveal");
  if (!("IntersectionObserver" in window)) {
    items.forEach((item) => item.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver((entries, instance) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        instance.unobserve(entry.target);
      }
    });
  }, { threshold: .13 });
  items.forEach((item) => observer.observe(item));
}

document.addEventListener("click", (event) => {
  const scrollTarget = event.target.closest("[data-scroll]");
  if (scrollTarget) {
    event.preventDefault();
    scrollToId(scrollTarget.dataset.scroll);
    $("#mobile-nav").classList.remove("is-open");
  }

  const prompt = event.target.closest("[data-prompt]");
  if (prompt) {
    sendPrompt(prompt.dataset.prompt);
    $("#chat-input").focus();
  }

  const addButton = event.target.closest("[data-add]");
  if (addButton) updateCart(addButton.dataset.add);

  const favorite = event.target.closest(".favorite-button");
  if (favorite) {
    favorite.classList.toggle("saved");
    favorite.textContent = favorite.classList.contains("saved") ? "♥" : "♡";
    showToast(favorite.classList.contains("saved") ? "Добавлено в избранное" : "Убрано из избранного");
  }

  const action = event.target.closest("[data-action]");
  if (action) {
    if (action.dataset.action === "menu") $("#mobile-nav").classList.toggle("is-open");
    if (action.dataset.action === "search") {
      scrollToId("consultant");
      window.setTimeout(() => $("#chat-input").focus(), 500);
    }
    if (action.dataset.action === "download") showToast("В демо прайс доступен в учебном режиме");
    if (action.dataset.action === "show-more") showToast("Полный каталог подключается к следующему этапу PoC");
    if (action.dataset.action === "about") showToast("Раздел о питомнике будет дополнен реальными данными");
  }
});

$("#chat-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#chat-input");
  sendPrompt(input.value);
  input.value = "";
});

$("#question-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#question");
  if (!input.value.trim()) {
    input.focus();
    return;
  }
  $("#form-success").hidden = false;
  input.value = "";
  showToast("Вопрос записан в учебную очередь");
});

$("#subscribe-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#subscribe-form input");
  $("#subscribe-success").textContent = "Готово — письмо отправлено в учебном режиме.";
  input.value = "";
});

initFilters();
initReveal();
