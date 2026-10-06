// BookTrip — enums for the API. MUST stay identical to js/enums.js (tests/enums.test.mjs checks this).
// Unknown values must be tolerated by consumers (fall back to the first item or a sensible default).

export const LANGS = ["ru", "uk", "en"];

export const COVER_MOTIFS = ["star", "rose", "crown", "sword", "ship", "key", "eye", "tree", "moon", "sun", "castle", "mask", "feather", "heart", "skull", "compass", "wave", "mountain", "bird", "book", "ring", "flame", "clock", "leaf", "lantern", "wand", "fox", "anchor", "dagger", "hat"];

export const ROLES = ["protagonist", "antagonist", "supporting", "minor"];

export const CREATURES = ["human", "elf", "dwarf", "hobbit", "fox", "cat", "dog", "rabbit", "bear", "owl", "dragon", "snake", "horse", "robot", "ghost", "mouse", "bird", "wolf", "pig", "lion"];
export const GENDERS = ["male", "female", "neutral"];
export const AGES = ["child", "teen", "adult", "elder"];
export const BUILDS = ["slim", "average", "broad", "small", "tall"];
export const HAIR_STYLES = ["none", "short", "long", "bun", "ponytail", "curly", "spiky", "bob", "braids", "mohawk", "wavy", "messy"];
export const FACIAL_HAIR = ["none", "mustache", "beard", "long_beard", "stubble"];
export const TOP_KINDS = ["shirt", "tshirt", "jacket", "coat", "dress", "robe", "armor", "sweater", "suit", "tunic", "vest", "gown"];
export const PATTERNS = ["plain", "stripes", "checks", "dots", "embroidery"];
export const BOTTOM_KINDS = ["pants", "skirt", "shorts", "robe", "none"];
export const HEADWEAR = ["none", "crown", "wizard_hat", "top_hat", "cap", "bow", "hood", "helmet", "headscarf", "flower_wreath", "feather_hat", "beanie", "tiara", "bandana", "tricorn", "straw_hat"];
export const ACCESSORIES = ["none", "glasses", "round_glasses", "scarf", "cape", "backpack", "necklace", "eyepatch", "monocle", "wings", "tie", "bowtie", "belt_sword"];
export const HOLDING = ["none", "wand", "sword", "book", "lantern", "rose", "staff", "pipe", "shield", "bow_weapon", "umbrella", "cup", "key", "flower", "letter", "rapier", "pistol", "telescope", "map", "basket", "microphone", "candle", "spear", "magnifier"];

export const SETTINGS = ["space", "forest", "city", "village", "castle", "desert", "sea", "ship", "room", "snow", "garden", "mountains", "school", "ballroom", "battlefield", "cave", "island", "street", "train", "meadow", "library", "tavern", "palace", "swamp", "church"];
export const TIMES = ["dawn", "day", "dusk", "night"];
export const WEATHER = ["clear", "rain", "snow", "fog", "stars", "wind"];
export const ACTIONS = ["talk", "walk", "dance", "fight", "travel", "discover", "rest", "celebrate", "sad", "chase"];
export const CAMERAS = ["orbit", "dolly_in", "pan", "crane", "fly_over", "close_up"];
export const MOODS = ["calm", "magical", "tense", "joyful", "melancholic", "epic", "mysterious", "romantic"];
export const SCENE_PROPS = ["tree", "pine", "palm", "house", "tower", "castle", "lamp", "rose", "flower", "rock", "volcano", "star", "moon", "planet", "boat", "ship", "table", "chair", "bookshelf", "fire", "fountain", "bench", "fence", "well", "carriage", "chest", "door", "bridge", "tent", "crystal", "clock", "piano", "statue", "cake", "barrel", "cart", "throne", "bed", "desk", "window", "mushroom", "bush", "sign", "telescope", "cauldron", "candles", "gate", "grave", "train"];

/** A complete, valid default Appearance (used to fill gaps in partial data). */
export const DEFAULT_APPEARANCE = Object.freeze({
  creature: "human", gender: "neutral", age: "adult", build: "average", skin: "#e8b48f",
  hair: { style: "short", color: "#3b2a1a" }, facialHair: "none", eyes: "#2f2a26",
  top: { kind: "shirt", color: "#3a6ea5", accent: "#f2efe8", pattern: "plain" },
  bottom: { kind: "pants", color: "#2b2b35" }, shoes: "#4a3020",
  headwear: "none", headwearColor: "#222222", accessory: "none", accessoryColor: "#222222", holding: "none",
});
