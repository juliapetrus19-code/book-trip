// BookTrip — account, paywall and checkout (owned by app).
//
//   init(ctx)              ctx = { openModal, toast, errorText, navigate, onAccountChange, icons }
//   takeLoginParam()       strips ?login=ok|expired from the URL (call before the router), returns it
//   afterBoot(param)       toast + "signup_done" + reopen the paywall the visitor left for the e-mail
//   openLogin({ intent })  e-mail → magic link ("check your inbox"; devLink only in dev/test)
//   openPaywall({ id, reason, period })   plans + Subscribe (login step first when logged out)
//   plansBlock(health, { from })          price cards + Subscribe + Telegram (Premium modal)
//   refreshLabels()        re-translate the nav button after a language switch
//
// Paddle.js v2 is loaded lazily from cdn.paddle.com only when the visitor starts a checkout.
// Every value that came from the server (e-mail, labels) is rendered with textContent.

import { t, tn, getLang } from "./i18n.js";
import * as api from "./api.js";
import { el, store } from "./util.js";

const PADDLE_SRC = "https://cdn.paddle.com/paddle/v2/paddle.js";
const INTENT_KEY = "bt-intent";
const INTENT_TTL = 2 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const ICON = {
  person: svg('<circle cx="12" cy="8.4" r="3.9"/><path d="M4.6 20.2c1.2-3.6 4-5.5 7.4-5.5s6.2 1.9 7.4 5.5"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  telegram: svg('<path d="M21 4.5 2.8 11.6c-.9.4-.9 1.6.1 1.9l4.6 1.4 1.8 5.4c.3.8 1.3 1 1.9.4l2.6-2.5 4.8 3.5c.7.5 1.6.1 1.8-.7L23 5.8c.2-1-.9-1.8-2-1.3z"/><path d="m7.6 14.9 10.6-7.2-8.4 8.9"/>'),
  mail: svg('<rect x="3" y="5.2" width="18" height="13.6" rx="2.4"/><path d="m3.8 6.6 8.2 6.3 8.2-6.3"/>'),
  back: svg('<path d="M15 5l-7 7 7 7"/>'),
  crown: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3.6 17.6 2.8 8.4l5.1 3.9L12 5.2l4.1 7.1 5.1-3.9-.8 9.2z"/></svg>',
};

let ctx = null;
const st = {
  health: null,
  me: null,
  btn: null,       // account button in the nav bar (wide screens)
  item: null,      // account entry inside the compact nav menu (≤ 420px)
  menu: null,      // { node, close } open account popover
  paywall: null,   // open paywall modal handle
  paddleToken: "",
  activating: false,
  pending: null,   // { id } of the checkout in progress
};
let uidN = 0;
const uid = (p) => `${p}-${++uidN}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// State

const enabled = () => Boolean(st.health && (st.health.account || st.health.billing.enabled));

async function refreshMe() {
  st.me = await api.getMe({ refresh: true });
  renderNav();
  return st.me;
}

function saveIntent(intent) {
  store.set(INTENT_KEY, JSON.stringify({ ...intent, at: Date.now() }));
}

function takeIntent() {
  const raw = store.get(INTENT_KEY);
  store.remove(INTENT_KEY);
  try {
    const v = JSON.parse(raw || "null");
    if (v && typeof v === "object" && Date.now() - (v.at || 0) < INTENT_TTL) return v;
  } catch { /* ignore */ }
  return null;
}

/** Path the magic link returns to (no hash: the server appends "?login=ok"). */
function nextPath(id) {
  if (id && /^[a-z0-9-]{1,100}$/.test(id)) return `/book/${id}`;
  return /^\/book\/[a-z0-9-]{1,100}\/?$/.test(location.pathname) ? location.pathname : "/";
}

// ---------------------------------------------------------------------------------------------
// Nav: account button + account popover

function initNav() {
  const right = document.querySelector(".nav-right");
  const links = document.getElementById("nav-links");
  if (!right) return;
  st.btn = el("button", { type: "button", class: "nav-acc", id: "nav-account", hidden: true, "aria-expanded": "false" });
  st.btn.addEventListener("click", () => onAccountClick(st.btn));
  right.insertBefore(st.btn, document.getElementById("nav-menu"));
  if (links) {
    st.item = el("button", { type: "button", class: "nav-links-btn nav-acc-item", hidden: true });
    st.item.addEventListener("click", () => setTimeout(() => onAccountClick(st.btn), 0));
    links.append(st.item);
  }
  renderNav();
}

function renderNav() {
  if (!st.btn) return;
  const on = enabled();
  st.btn.hidden = !on;
  if (st.item) st.item.hidden = !on;
  document.documentElement.classList.toggle("bt-has-acc", on);
  const user = st.me?.user || null;
  st.btn.classList.toggle("is-in", Boolean(user));
  st.btn.classList.toggle("is-sub", Boolean(user?.subscribed));
  st.btn.title = user ? user.email : t("acc.signIn");
  st.btn.setAttribute("aria-label", user ? `${t("acc.menu")}: ${user.email}` : t("acc.signIn"));
  st.btn.setAttribute("aria-haspopup", user ? "true" : "dialog");
  st.btn.dataset.email = user ? user.email : "";
  if (user) st.btn.replaceChildren(el("span", { class: "nav-acc-letter", "aria-hidden": "true", text: (user.email[0] || "?").toUpperCase() }));
  else st.btn.innerHTML = ICON.person;
  if (st.item) st.item.textContent = user ? user.email : t("acc.signIn");
}

export function refreshLabels() {
  renderNav();
  if (st.menu) closeMenu();
}

function onAccountClick(anchor) {
  if (st.menu) { closeMenu(); return; }
  if (st.me?.user) openMenu(anchor);
  else openLogin();
}

function planText(me) {
  const u = me.user;
  if (u.subscribed) return u.plan === "year" ? t("acc.planYear") : u.plan === "month" ? t("acc.planMonth") : t("acc.planActive");
  return me.paywall ? `${t("acc.free")} · ${tn("pay.freeLeft", me.freeLeft)}` : t("acc.free");
}

function openMenu(anchor) {
  closeMenu();
  const me = st.me;
  if (!me?.user) return;
  const billing = st.health?.billing?.enabled;
  const id = uid("bt-accmenu");
  const actions = [];
  if (billing && me.user.subscribed) {
    actions.push(el("button", { type: "button", class: "bt-accmenu-btn", text: t("acc.manage"), onclick: async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      try { location.assign((await api.billingPortal()).url); } catch { ctx.toast(t("acc.portalError"), { error: true }); b.disabled = false; }
    } }));
  } else if (billing) {
    actions.push(el("button", { type: "button", class: "bt-accmenu-btn is-accent", text: t("acc.subscribe"), onclick: () => { closeMenu(); openPaywall({ reason: "subscribe" }); } }));
  }
  actions.push(el("button", { type: "button", class: "bt-accmenu-btn", text: t("acc.logout"), onclick: async (e) => {
    e.currentTarget.disabled = true;
    try { await api.logout(); } catch { /* the cookie may already be gone */ }
    closeMenu();
    await refreshMe();
    ctx.toast(t("acc.loggedOut"));
    ctx.onAccountChange?.({ subscribed: false });
  } }));
  const node = el("div", { class: "bt-accmenu", id, role: "group", "aria-label": t("acc.menu") },
    el("p", { class: "bt-accmenu-mail", text: me.user.email }),
    el("p", { class: `bt-accmenu-plan${me.user.subscribed ? " is-on" : ""}`, text: planText(me) }),
    el("div", { class: "bt-accmenu-actions" }, actions));
  const nav = document.getElementById("nav");
  const r = nav ? nav.getBoundingClientRect() : { bottom: 74, right: window.innerWidth - 12 };
  node.style.top = `${Math.round(r.bottom + 8)}px`;
  node.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
  document.body.append(node);
  anchor?.setAttribute("aria-expanded", "true");
  anchor?.setAttribute("aria-controls", id);

  const onDown = (e) => { if (!node.contains(e.target) && !anchor?.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    if (e.key === "Escape") { e.stopPropagation(); closeMenu(); anchor?.focus(); }
  };
  const onFocus = (e) => { if (e.relatedTarget && !node.contains(e.relatedTarget) && e.relatedTarget !== anchor) closeMenu(); };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  node.addEventListener("focusout", onFocus);
  window.addEventListener("bt:route", closeMenu, { once: true });
  st.menu = {
    node,
    close() {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      anchor?.setAttribute("aria-expanded", "false");
      node.remove();
    },
  };
  node.querySelector("button")?.focus({ preventScroll: true });
}

function closeMenu() {
  const m = st.menu;
  st.menu = null;
  m?.close();
}

// ---------------------------------------------------------------------------------------------
// Login (magic link)

/** Login step: e-mail form → "check your inbox". Returns a node; `onBack` adds a back button. */
function loginView({ labelId, lead, next, onBack = null }) {
  const box = el("div", { class: "bt-login" });
  const showForm = (value = "") => {
    const inputId = uid("bt-email");
    const input = el("input", {
      id: inputId, type: "email", name: "email", class: "bt-input", autocomplete: "email", inputmode: "email",
      autocapitalize: "off", spellcheck: "false", maxlength: "254", required: true, placeholder: t("acc.emailPh"),
      "aria-describedby": `${inputId}-err`,
    });
    input.value = value;
    const err = el("p", { class: "bt-field-err", id: `${inputId}-err`, "aria-live": "polite" });
    const submit = el("button", { type: "submit", class: "btn-glow" }, el("span", { text: t("acc.send") }));
    const form = el("form", { class: "bt-login-form", novalidate: true },
      el("label", { class: "bt-label", for: inputId, text: t("acc.email") }),
      el("div", { class: "bt-login-row" }, input, submit),
      err);
    const setErr = (msg) => {
      err.textContent = msg || "";
      if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
    };
    input.addEventListener("input", () => { if (err.textContent && EMAIL_RE.test(input.value.trim())) setErr(""); });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = input.value.trim();
      if (!EMAIL_RE.test(email) || email.length > 254) { setErr(t("acc.badEmail")); input.focus(); return; }
      setErr("");
      submit.disabled = true;
      submit.firstChild.textContent = t("acc.sending");
      try {
        const res = await api.authStart(email, getLang(), next);
        api.sendEvent("signup_start");
        showSent(email, res.devLink);
      } catch (error) {
        const ae = api.toApiError(error);
        submit.disabled = false;
        submit.firstChild.textContent = t("acc.send");
        if (ae.code === "not_configured") setErr(t("acc.notConfigured"));
        else if (ae.code === "bad_request") setErr(t("acc.badEmail"));
        else ctx.toast(ctx.errorText(ae), { error: true });
      }
    });
    box.replaceChildren(
      onBack ? el("button", { type: "button", class: "bt-linkbtn bt-login-back", onclick: onBack }, el("span", { html: ICON.back }), el("span", { text: t("acc.back") })) : null,
      el("p", { class: "bt-kicker", text: "BookTrip" }),
      el("h2", { class: "bt-h", id: labelId, text: t("acc.title") }),
      el("p", { class: "bt-lead", text: lead }),
      form,
      telegramHint());
    setTimeout(() => input.focus({ preventScroll: true }), 30);
  };
  const showSent = (email, devLink) => {
    let dev = null;
    if (devLink) {
      try {
        const u = new URL(devLink, location.origin);
        if (u.origin === location.origin) dev = el("a", { class: "bt-devlink", href: u.href, text: t("acc.devLink") });
      } catch { /* ignore a malformed link */ }
    }
    const again = el("button", { type: "button", class: "btn-ghost", text: t("acc.again"), onclick: () => showForm(email) });
    const title = el("h2", { class: "bt-h", id: labelId, tabindex: "-1", text: t("acc.sentTitle") });
    box.replaceChildren(
      el("span", { class: "bt-ico bt-login-ico", html: ICON.mail }),
      title,
      el("p", { class: "bt-lead bt-login-sent", role: "status", text: t("acc.sentText", { email }) }),
      dev,
      el("div", { class: "bt-actions" }, again));
    title.focus({ preventScroll: true });
  };
  showForm();
  return box;
}

function telegramHint() {
  const tg = st.health?.telegram;
  if (!tg) return null;
  return el("p", { class: "bt-small" }, el("a", { href: `https://t.me/${tg}`, target: "_blank", rel: "noopener", text: t("pay.telegram") }));
}

/** Standalone sign-in modal. `intent` (e.g. { kind: "paywall", period, id }) survives the e-mail round trip. */
export function openLogin({ intent = null } = {}) {
  if (intent) saveIntent(intent);
  const labelId = uid("bt-login-title");
  const node = loginView({ labelId, lead: intent ? t("acc.leadPay") : t("acc.lead"), next: nextPath(intent?.id) });
  return ctx.openModal(node, { labelledBy: labelId, className: "bt-narrow" });
}

// ---------------------------------------------------------------------------------------------
// Plans + Subscribe

const priceOf = (h, period) => h.billing.prices.find((p) => p.period === period) || null;

/** Price cards (radio group). → { node, value() } */
function planPicker(h, preferred) {
  const name = uid("bt-plan");
  const periods = h.billing.prices.map((p) => p.period);
  let value = periods.includes(preferred) ? preferred : periods.includes("year") ? "year" : periods[0];
  const cards = h.billing.prices.map((p) => {
    const input = el("input", { type: "radio", name, value: p.period, class: "bt-plan-input" });
    input.checked = p.period === value;
    const card = el("label", { class: `bt-plan${p.period === "year" ? " is-best" : ""}${input.checked ? " is-checked" : ""}` },
      input,
      el("span", { class: "bt-plan-name", text: t(p.period === "year" ? "pay.year" : "pay.month") }),
      el("span", { class: "bt-plan-price", text: p.label || "—" }),
      el("span", { class: "bt-plan-per", text: t(p.period === "year" ? "pay.perYear" : "pay.perMonth") }),
      p.period === "year" && periods.length > 1 ? el("span", { class: "bt-plan-best", text: t("pay.best") }) : null);
    input.addEventListener("change", () => {
      value = p.period;
      for (const c of node.querySelectorAll(".bt-plan")) c.classList.toggle("is-checked", c.contains(node.querySelector(".bt-plan-input:checked")));
    });
    return card;
  });
  const node = el("fieldset", { class: "bt-plans" }, el("legend", { class: "sr-only", text: t("pay.choose") }), cards);
  return { node, value: () => value };
}

function telegramButton() {
  const tg = st.health?.telegram;
  if (!tg) return null;
  return el("a", { class: "btn-ghost bt-tg", href: `https://t.me/${tg}`, target: "_blank", rel: "noopener" },
    el("span", { html: ICON.telegram }), el("span", { text: t("pay.telegram") }));
}

function legalLinks() {
  const a = (href, key) => el("a", { href, target: "_blank", rel: "noopener", text: t(key) });
  return el("p", { class: "bt-legal" },
    el("span", { text: `${t("pay.merchant")} ` }),
    a("/terms", "legal.terms"), " · ", a("/privacy", "legal.privacy"), " · ", a("/refund", "legal.refund"));
}

/**
 * Plans + Subscribe + Telegram for the Premium modal (or "coming soon" + Telegram when billing is
 * off). Logged-out visitors get the sign-in modal first.
 */
export function plansBlock(h, { from = "premium", id = null } = {}) {
  st.health = h;
  if (!h.billing.enabled) {
    return el("div", { class: "bt-soon" },
      el("p", { class: "bt-soon-h" }, el("span", { class: "bt-pill", text: t("pay.soonTitle") })),
      el("p", { class: "bt-lead", text: t("pay.soon") }),
      el("div", { class: "bt-actions" }, telegramButton()));
  }
  const picker = planPicker(h);
  const status = el("p", { class: "bt-pay-status", role: "status", "aria-live": "polite" });
  const btn = el("button", { type: "button", class: "btn-glow bt-subscribe" }, el("span", { text: t("pay.subscribe") }));
  btn.addEventListener("click", () => subscribe(picker.value(), {
    id, button: btn, status,
    toLogin: (period) => openLogin({ intent: { kind: "paywall", period, id } }),
  }));
  return el("div", { class: `bt-plans-block is-${from}` },
    picker.node,
    el("div", { class: "bt-actions" }, btn, telegramButton()),
    status,
    legalLinks());
}

/** Paywall modal: why, what you get, plans; Subscribe → sign-in step (logged out) or Paddle checkout. */
export async function openPaywall({ id = null, reason = "limit", period = null } = {}) {
  if (st.paywall) return st.paywall;
  const h = st.health || await api.getHealth();
  st.health = h;
  if (!h.billing.enabled) { ctx.navigate("#/premium"); return null; }
  if (!st.me) await refreshMe();
  if (st.paywall) return st.paywall;
  const labelId = uid("bt-pay-title");
  const node = el("div", { class: "bt-pay" });
  const handle = ctx.openModal(node, {
    labelledBy: labelId,
    className: "bt-mid bt-paymodal",
    onClose: () => { if (st.paywall === handle) st.paywall = null; },
  });
  st.paywall = handle;

  const showPlans = (preferred = period) => {
    const picker = planPicker(h, preferred);
    const status = el("p", { class: "bt-pay-status", role: "status", "aria-live": "polite" });
    const btn = el("button", { type: "button", class: "btn-glow bt-subscribe" }, el("span", { text: t("pay.subscribe") }));
    btn.addEventListener("click", () => subscribe(picker.value(), {
      id, button: btn, status,
      toLogin: (p) => {
        saveIntent({ kind: "paywall", period: p, id });
        node.replaceChildren(loginView({ labelId, lead: t("acc.leadPay"), next: nextPath(id), onBack: () => showPlans(p) }));
      },
    }));
    const limit = reason === "limit";
    node.replaceChildren(
      el("div", { class: "bt-prem-hero" },
        el("p", { class: "badge bt-prem-badge" }, el("i", { html: ICON.crown }), el("b", { text: t("pay.kicker") })),
        el("h2", { class: "bt-h bt-prem-h", id: labelId, text: limit ? t("pay.title") : t("pay.titleSub") }),
        el("p", { class: "bt-lead", text: limit ? tn("pay.lead", h.freeBooks) : t("pay.leadSub") })),
      el("ul", { class: "bt-pay-list" }, t("pay.bullets").map((line) => el("li", {}, el("span", { html: ICON.check }), el("span", { text: line })))),
      picker.node,
      el("div", { class: "bt-actions" }, btn, telegramButton()),
      status,
      legalLinks());
  };
  showPlans();
  api.sendEvent("paywall_shown", id);
  return handle;
}

function closePaywall() {
  const p = st.paywall;
  st.paywall = null;
  p?.close("api");
}

async function subscribe(period, { id, button, status, toLogin }) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    const me = await refreshMe();
    if (!me.user) { toLogin(period); return; }
    if (me.user.subscribed) {
      closePaywall();
      ctx.toast(t("pay.subscribed"));
      ctx.onAccountChange?.({ subscribed: true });
      return;
    }
    api.sendEvent("checkout_start", id);
    status.textContent = t("pay.opening");
    const co = await api.billingCheckout(period);
    const Paddle = await loadPaddle();
    initPaddle(Paddle, co);
    st.pending = { id };
    closePaywall();
    Paddle.Checkout.open({
      items: [{ priceId: co.priceId, quantity: 1 }],
      customer: co.email ? { email: co.email } : undefined,
      customData: co.customData,
      settings: { displayMode: "overlay", locale: getLang(), theme: "dark" },
    });
  } catch (err) {
    const e = api.toApiError(err);
    status.textContent = "";
    if (e.code === "login_required") toLogin(period);
    else ctx.toast(t("pay.error"), { error: true });
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Paddle.js

let paddlePromise = null;

function loadPaddle() {
  if (window.Paddle?.Checkout) return Promise.resolve(window.Paddle);
  paddlePromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = PADDLE_SRC;
    s.async = true;
    const fail = (err) => {
      clearTimeout(timer);
      paddlePromise = null;
      s.remove();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error("Paddle.js timed out")), 20000);
    s.onload = () => {
      clearTimeout(timer);
      if (window.Paddle?.Checkout) resolve(window.Paddle);
      else fail(new Error("Paddle.js did not initialise"));
    };
    s.onerror = () => fail(new Error("Paddle.js failed to load"));
    document.head.append(s);
  });
  return paddlePromise;
}

function initPaddle(Paddle, co) {
  if (st.paddleToken === co.clientToken) return;
  if (co.env === "sandbox") Paddle.Environment?.set?.("sandbox");
  const options = { token: co.clientToken, eventCallback: onPaddleEvent };
  if (st.paddleToken && typeof Paddle.Update === "function") Paddle.Update(options);
  else Paddle.Initialize(options);
  st.paddleToken = co.clientToken;
}

function onPaddleEvent(ev) {
  if (ev && ev.name === "checkout.completed") activate();
}

/** After checkout.completed: "Payment received, activating…" while the webhook lands (poll /api/me ≤ 30 s). */
async function activate() {
  if (st.activating) return;
  st.activating = true;
  const labelId = uid("bt-act-title");
  const msg = el("p", { class: "bt-lead", role: "status", text: t("pay.activating") });
  const node = el("div", { class: "bt-activate" },
    el("div", { class: "bt-spin", "aria-hidden": "true" }),
    el("h2", { class: "bt-h", id: labelId, text: t("pay.kicker") }),
    msg);
  const handle = ctx.openModal(node, { labelledBy: labelId, className: "bt-narrow" });
  const t0 = Date.now();
  let me = null;
  while (Date.now() - t0 < 30000) {
    me = await api.getMe({ refresh: true });
    if (me.user?.subscribed) break;
    await sleep(2000);
  }
  st.activating = false;
  st.me = me;
  renderNav();
  if (me?.user?.subscribed) {
    handle.close("api");
    try { window.Paddle?.Checkout?.close?.(); } catch { /* ignore */ }
    ctx.toast(t("pay.done"), { duration: 5200 });
    ctx.onAccountChange?.({ subscribed: true, id: st.pending?.id || null });
  } else {
    msg.textContent = t("pay.slow");
  }
  st.pending = null;
}

// ---------------------------------------------------------------------------------------------
// Boot

/** Read and strip ?login=ok|expired (the magic link landed here). Call before the router. */
export function takeLoginParam() {
  let value = null;
  try {
    const url = new URL(location.href);
    value = url.searchParams.get("login");
    if (value === null) return null;
    url.searchParams.delete("login");
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  } catch { return null; }
  return value === "ok" || value === "expired" ? value : null;
}

export function init(context) {
  ctx = context;
  initNav();
  api.getHealth().then(async (h) => {
    st.health = h;
    renderNav();
    if (!enabled()) return; // no accounts, no billing: nothing to ask /api/me
    st.me = await api.getMe();
    renderNav();
  });
}

/** Login return: toast, event, and the paywall the visitor left to confirm the e-mail. */
export async function afterBoot(param) {
  if (!param) return;
  const h = await api.getHealth();
  st.health = h;
  if (param === "expired") {
    ctx.toast(t("acc.loginExpired"), { error: true, duration: 6000 });
    if (enabled()) openLogin({ intent: null });
    return;
  }
  const me = await refreshMe();
  ctx.toast(me.user ? t("acc.loginOk", { email: me.user.email }) : t("acc.loginOkShort"), { duration: 5200 });
  api.sendEvent("signup_done");
  ctx.onAccountChange?.({ subscribed: Boolean(me.user?.subscribed) });
  const intent = takeIntent();
  if (intent?.kind === "paywall" && me.user && !me.user.subscribed && h.billing.enabled) {
    await sleep(400); // let a paywall from the book route open first (it is reused)
    openPaywall({ id: intent.id || null, reason: "subscribe", period: intent.period || null });
  }
}
