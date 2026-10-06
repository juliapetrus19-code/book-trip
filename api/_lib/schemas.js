// JSON schemas for Claude structured outputs (output_config.format).
// Rules: every object has additionalProperties:false and lists ALL properties in "required";
// no min/max/length constraints (counts are enforced in the prompts and clamped in sanitize.js).
import * as E from "./enums.js";

const str = { type: "string" };
const strArr = { type: "array", items: str };
const en = (values) => ({ type: "string", enum: values });

function obj(properties) {
  return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
}

const cover = obj({ bg: str, bg2: str, fg: str, accent: str, motif: en(E.COVER_MOTIFS) });
const bookRef = obj({ title: str, author: str });

export const RESOLVE_SCHEMA = obj({
  found: { type: "boolean" },
  id: str,
  title: str,
  originalTitle: str,
  author: str,
  year: { anyOf: [{ type: "integer" }, { type: "null" }] },
  genre: str,
  tagline: str,
  cover,
  suggestions: { type: "array", items: bookRef },
});

export const OVERVIEW_SCHEMA = obj({
  known: { type: "boolean" },
  summary: strArr,
  themes: strArr,
  terms: { type: "array", items: obj({ term: str, definition: str }) },
  similar: { type: "array", items: obj({ title: str, author: str, why: str }) },
});

const appearance = obj({
  creature: en(E.CREATURES),
  gender: en(E.GENDERS),
  age: en(E.AGES),
  build: en(E.BUILDS),
  skin: str,
  hair: obj({ style: en(E.HAIR_STYLES), color: str }),
  facialHair: en(E.FACIAL_HAIR),
  eyes: str,
  top: obj({ kind: en(E.TOP_KINDS), color: str, accent: str, pattern: en(E.PATTERNS) }),
  bottom: obj({ kind: en(E.BOTTOM_KINDS), color: str }),
  shoes: str,
  headwear: en(E.HEADWEAR),
  headwearColor: str,
  accessory: en(E.ACCESSORIES),
  accessoryColor: str,
  holding: en(E.HOLDING),
});

export const CHARACTERS_SCHEMA = obj({
  known: { type: "boolean" },
  characters: {
    type: "array",
    items: obj({
      id: str,
      name: str,
      role: en(E.ROLES),
      traits: strArr,
      description: str,
      appearance,
      portraitPrompt: str,
    }),
  },
});

const scene = obj({
  title: str,
  setting: en(E.SETTINGS),
  time: en(E.TIMES),
  weather: en(E.WEATHER),
  cast: strArr,
  props: { type: "array", items: en(E.SCENE_PROPS) },
  action: en(E.ACTIONS),
  camera: en(E.CAMERAS),
  mood: en(E.MOODS),
  narration: str,
  line: { anyOf: [obj({ speaker: str, text: str }), { type: "null" }] },
});

export const FILM_SCHEMA = obj({
  known: { type: "boolean" },
  title: str,
  intro: str,
  outro: str,
  scenes: { type: "array", items: scene },
  videoPrompts: strArr,
});
