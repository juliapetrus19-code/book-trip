// BookTrip — prompts for the anime look (character portraits + film key frames).
// Pure ES module with no DOM access: imported by the browser (js/anime.js) and by the server (api/anime.js),
// so both build exactly the same prompt for the same book (and therefore hit the same cached image).
//
// Image models read English best, so prompts are built from the language-neutral parts of a book:
// the English portraitPrompt of each character, the scene enums (setting, time, weather, mood, action, camera)
// and, when available, the English scene narration.

export const ANIME_STYLE =
  "anime illustration, hand-drawn 2D cel shading, clean line art, expressive eyes, soft painterly background, " +
  "cinematic lighting, rich colours, high detail, masterpiece";
export const ANIME_AVOID = "no text, no captions, no letters, no watermark, no logo, no signature, no frame, no border";

const SETTING = {
  meadow: "a wide flowery meadow", forest: "a deep old forest", village: "a small rustic village", city: "a bustling old city street",
  street: "a narrow cobbled street", room: "a cosy room interior", library: "a candle-lit library full of books", palace: "a grand palace hall",
  ballroom: "a glittering ballroom", church: "an old stone church", tavern: "a warm wooden tavern", castle: "a medieval castle",
  cave: "a dark cave", mountains: "high rocky mountains", swamp: "a misty swamp", train: "an old steam train", sea: "the open sea", ship: "the deck of a sailing ship", island: "a lonely island shore",
  desert: "a vast sand desert", snow: "a snowy winter landscape", garden: "a blooming garden", space: "outer space among stars",
  battlefield: "a smoky battlefield", school: "an old school hall",
};
const TIME = { dawn: "at dawn, pink sky", day: "in bright daylight", dusk: "at golden dusk", night: "at night, moonlight" };
const WEATHER = { clear: "", rain: "in the rain", snow: "with falling snow", fog: "in thick fog", stars: "under a starry sky", wind: "in strong wind" };
const MOOD = {
  calm: "peaceful atmosphere", magical: "magical glowing atmosphere", tense: "tense dramatic atmosphere", joyful: "joyful warm atmosphere",
  melancholic: "melancholic atmosphere", epic: "epic heroic atmosphere", mysterious: "mysterious atmosphere", romantic: "romantic atmosphere",
};
const ACTION = {
  talk: "talking to each other", walk: "walking together", dance: "dancing", fight: "in a dynamic fight", travel: "on a journey",
  discover: "discovering something amazing", rest: "resting", celebrate: "celebrating", sad: "grieving", chase: "in a chase",
};
const CAMERA = {
  orbit: "medium shot", dolly_in: "medium close-up", pan: "panoramic medium shot", crane: "high-angle shot", fly_over: "aerial shot", close_up: "close-up shot",
};

const str = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
const cut = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "").replace(/[\s,;:–—-]+$/, ""));
const INDOOR = new Set(["room", "library", "ballroom", "church", "tavern", "palace", "school", "cave", "train"]);
/** Narration is written as "you are inside the story": keep only the sentences that describe the scene itself. */
const thirdPerson = (text) => str(text).split(/(?<=[.!?])\s+/).filter((s) => !/\b(you|your|yours|yourself)\b/i.test(s)).join(" ");

/** Stable 32-bit seed from a string (FNV-1a), so the same character / frame is drawn the same way. */
export function seedFor(key) {
  let h = 0x811c9dc5;
  for (const ch of String(key)) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) % 2147483647;
}

/** Portrait of one character. `book` = { title, author } (any language), `character` = { portraitPrompt, name }. */
export function portraitPromptFor(book, character) {
  const who = str(character.portraitPrompt) || `a character named ${str(character.name)}`;
  const from = str(book.originalTitle) || str(book.title);
  return `${ANIME_STYLE}. Character portrait, upper body, facing the viewer, simple soft background. ${cut(who, 420)}` +
    (from ? ` From the story "${cut(from, 80)}".` : "") + ` ${ANIME_AVOID}.`;
}

/**
 * Key frame `frame` (0 = wide establishing shot, 1 = closer shot on the cast) of one film scene.
 * `scene` = shared scene enums + cast ids; `castById` = Map id → { portraitPrompt, name };
 * `narrationEn` (optional) = the English narration of the scene.
 */
export function scenePromptFor(book, scene, castById, { frame = 0, narrationEn = "" } = {}) {
  const place = [SETTING[scene.setting] || str(scene.setting).replace(/_/g, " "), INDOOR.has(scene.setting) ? "" : TIME[scene.time] || "", INDOOR.has(scene.setting) ? "" : WEATHER[scene.weather] || ""].filter(Boolean).join(", ");
  const cast = (Array.isArray(scene.cast) ? scene.cast : []).map((id) => castById.get(id)).filter(Boolean).slice(0, frame === 0 ? 3 : 2);
  const people = cast.map((c) => cut(str(c.portraitPrompt) || str(c.name), frame === 0 ? 150 : 220)).join("; ");
  const shot = frame === 0 ? "Wide cinematic establishing shot, 16:9" : `${CAMERA[scene.camera] || "medium shot"}, 16:9, focus on the characters`;
  const act = ACTION[scene.action] || "";
  const moment = thirdPerson(narrationEn);
  const story = moment ? ` Moment: ${cut(moment, 260)}` : "";
  const from = str(book.originalTitle) || str(book.title);
  return `${ANIME_STYLE}, anime movie still. ${shot}. Scene: ${place}.` +
    (people ? ` Characters ${act}: ${people}.` : "") + story +
    ` ${MOOD[scene.mood] || ""}.` + (from ? ` From the story "${cut(from, 80)}".` : "") + ` ${ANIME_AVOID}.`;
}

/** Image sizes per kind (the providers round to what they support). */
export const ANIME_SIZE = { portrait: { w: 768, h: 768 }, frame: { w: 1024, h: 576 } };
