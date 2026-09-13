import { randomInt } from "node:crypto"

/** BRIEF-20: the room's NAME, not its capability — safe to print, forward,
 *  screenshot, log. Three words drawn from this list, joined by hyphens
 *  (`harbor-lantern-ember`), because a name is something a person says out
 *  loud on a phone call and then types back from memory.
 *
 *  Curated, not `/usr/share/dict/words`: every entry is a short, concrete
 *  noun with one common pronunciation — no homophones that blur together
 *  spoken aloud ("sea"/"see", "flour"/"flower", "bear"/"bare"), nothing
 *  whose spelling is a guess from hearing it once (no silent letters, no
 *  regional spelling forks), nothing awkward to thumb-type on a phone
 *  keyboard. Unlike `code.ts`'s alphabet, which optimizes for reading a
 *  short string off a screen, this list optimizes for a person relaying it
 *  by voice and the other end getting it right the first time. */
export const SLUG_WORDS: readonly string[] = [
  "harbor",
  "lantern",
  "ember",
  "willow",
  "canyon",
  "meadow",
  "granite",
  "cedar",
  "amber",
  "copper",
  "maple",
  "birch",
  "summit",
  "valley",
  "orchard",
  "harvest",
  "compass",
  "anchor",
  "beacon",
  "bramble",
  "cobalt",
  "coral",
  "cotton",
  "crystal",
  "current",
  "delta",
  "desert",
  "dune",
  "ebony",
  "falcon",
  "feather",
  "fern",
  "field",
  "flint",
  "forest",
  "fountain",
  "garden",
  "glacier",
  "glade",
  "gravel",
  "hollow",
  "horizon",
  "hazel",
  "island",
  "ivory",
  "jasper",
  "juniper",
  "lagoon",
  "lake",
  "ledge",
  "lily",
  "linden",
  "lodge",
  "marble",
  "marsh",
  "meridian",
  "mesa",
  "mint",
  "moss",
  "oak",
  "oasis",
  "orbit",
  "otter",
  "paper",
  "pebble",
  "pepper",
  "pine",
  "plaza",
  "prairie",
  "quartz",
  "quill",
  "raven",
  "reef",
  "ridge",
  "river",
  "rose",
  "saffron",
  "sage",
  "sandbar",
  "shale",
  "shore",
  "silver",
  "sparrow",
  "spruce",
  "storm",
  "stream",
  "sunset",
  "tavern",
  "thistle",
  "timber",
  "tundra",
  "turtle",
  "violet",
  "walnut",
  "warbler",
  "waterfall",
  "wharf",
  "wheat",
  "willowherb",
  "wren",
]

const WORD_COUNT = 3

function pickWord(random: (() => number) | undefined): string {
  const index = random ? Math.floor(random() * SLUG_WORDS.length) : randomInt(SLUG_WORDS.length)
  const word = SLUG_WORDS[index]
  if (word === undefined) {
    throw new Error(`slug wordlist index out of range: ${index}`)
  }
  return word
}

/** BRIEF-20: three independent draws joined by hyphens. A collision between
 *  two rooms is handled by the caller re-drawing a fresh slug, never by
 *  appending a counter — a counter (`harbor-lantern-ember-2`) would make two
 *  rooms read as variants of each other, which is exactly the identity
 *  confusion a unique name exists to prevent. */
export function generateSlug(random?: () => number): string {
  const words: string[] = []
  for (let i = 0; i < WORD_COUNT; i++) {
    words.push(pickWord(random))
  }
  return words.join("-")
}

/** Case/whitespace tolerant, the same posture as `normalizeCode` — a member
 *  typing a slug back from memory should not have to match its exact case. */
export function normalizeSlug(input: string): string {
  return input.trim().toLowerCase()
}
