/**
 * extract_deck_profile.ts
 *
 * Thin wrapper: decodes a deck code and outputs a JSON with character names,
 * card names, and element info. For detailed skill costs/damage, use the
 * character-profiles.json from eval-char-comb.
 *
 * Usage:
 *   pnpm exec gnx scripts/extract_deck_profile.ts <deck_code>
 */

const { staticDecode, getNameSync } = require("../../assets-manager/src/index");

function main() {
  const deckCode = process.argv[2];
  if (!deckCode) {
    console.error("Usage: pnpm exec gnx scripts/extract_deck_profile.ts <deck_code>");
    process.exit(1);
  }

  const decoded = staticDecode(deckCode);
  const chars = decoded.characters.map((id: number) => ({
    id,
    name: getNameSync(id),
  }));
  const cards = decoded.cards
    .filter((id: number) => id !== 0)
    .map((id: number) => ({ id, name: getNameSync(id) ?? `Card-${id}` }));

  console.log(JSON.stringify({ deckCode, characters: chars, cards }, null, 2));
}

main();
