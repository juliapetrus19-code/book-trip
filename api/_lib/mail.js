// Magic-link e-mails via the Resend REST API (no SDK). Texts in uk / ru / en.
import { httpFetch } from "./fetch.js";
import { HttpError } from "./http.js";

const DEFAULT_FROM = "BookTrip <onboarding@resend.dev>";

export const devLinksEnabled = () => process.env.AUTH_DEV_LINKS === "1";
export const mailConfigured = () => Boolean(process.env.RESEND_API_KEY || devLinksEnabled());

const TEXTS = {
  uk: {
    subject: "Вхід у BookTrip",
    hello: "Привіт!",
    body: "Натисніть кнопку, щоб увійти в BookTrip. Посилання діє 30 хвилин і працює лише для цієї адреси.",
    button: "Увійти в BookTrip",
    fallback: "Якщо кнопка не працює, відкрийте це посилання:",
    ignore: "Якщо ви не намагалися увійти, просто проігноруйте цей лист.",
  },
  ru: {
    subject: "Вход в BookTrip",
    hello: "Привет!",
    body: "Нажмите кнопку, чтобы войти в BookTrip. Ссылка действует 30 минут и работает только для этого адреса.",
    button: "Войти в BookTrip",
    fallback: "Если кнопка не работает, откройте эту ссылку:",
    ignore: "Если вы не пытались войти, просто проигнорируйте это письмо.",
  },
  en: {
    subject: "Sign in to BookTrip",
    hello: "Hi!",
    body: "Click the button to sign in to BookTrip. The link is valid for 30 minutes and only for this address.",
    button: "Sign in to BookTrip",
    fallback: "If the button does not work, open this link:",
    ignore: "If you did not try to sign in, just ignore this e-mail.",
  },
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** { subject, html, text } for a login link. */
export function loginMail(link, lang = "uk") {
  const t = TEXTS[lang] || TEXTS.uk;
  const href = escapeHtml(link);
  const html = `<!doctype html><html lang="${lang in TEXTS ? lang : "uk"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(t.subject)}</title></head>
<body style="margin:0;padding:0;background:#04050b;font-family:Inter,Segoe UI,Arial,sans-serif;color:#e8ecf8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#04050b;padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#0d1124;border:1px solid #1f2747;border-radius:18px;padding:32px 28px">
<tr><td style="font-size:22px;font-weight:800;letter-spacing:.06em;color:#9ef6ff;padding-bottom:20px"><b style="color:#ffffff">BOOK</b>TRIP</td></tr>
<tr><td style="font-size:18px;font-weight:700;color:#ffffff;padding-bottom:8px">${escapeHtml(t.hello)}</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#c4cbe0;padding-bottom:24px">${escapeHtml(t.body)}</td></tr>
<tr><td style="padding-bottom:24px"><a href="${href}" style="display:inline-block;background:#39d6ff;color:#04050b;font-weight:700;font-size:15px;text-decoration:none;padding:13px 26px;border-radius:999px">${escapeHtml(t.button)}</a></td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#8a93b0;padding-bottom:6px">${escapeHtml(t.fallback)}</td></tr>
<tr><td style="font-size:12px;line-height:1.5;word-break:break-all;padding-bottom:20px"><a href="${href}" style="color:#9ef6ff">${href}</a></td></tr>
<tr><td style="font-size:12px;line-height:1.5;color:#8a93b0">${escapeHtml(t.ignore)}</td></tr>
</table></td></tr></table></body></html>`;
  const text = `${t.hello}\n\n${t.body}\n\n${link}\n\n${t.ignore}\n`;
  return { subject: t.subject, html, text };
}

/** Send the login e-mail; throws HttpError(upstream / not_configured) on failure. */
export async function sendLoginMail(to, link, lang) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new HttpError("not_configured", "E-mail is not configured (RESEND_API_KEY is missing)");
  const { subject, html, text } = loginMail(link, lang);
  let res;
  try {
    res = await httpFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: (process.env.MAIL_FROM || "").trim() || DEFAULT_FROM, to: [to], subject, html, text }),
    }, 10_000);
  } catch (err) {
    console.error(`[mail] resend unreachable: ${err && err.message}`);
    throw new HttpError("upstream", "Could not send the e-mail, please try again");
  }
  if (!res.ok) {
    let detail = "";
    try { detail = JSON.stringify(await res.json()).slice(0, 300); } catch { /* ignore */ }
    console.error(`[mail] resend HTTP ${res.status} ${detail}`);
    if (res.status === 401 || res.status === 403) throw new HttpError("not_configured", "The e-mail service rejected the API key or sender");
    throw new HttpError("upstream", "Could not send the e-mail, please try again");
  }
}
