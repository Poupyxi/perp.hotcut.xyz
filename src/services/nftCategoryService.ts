import type { RwaNftCategory } from "@/types/rwaNftMarket";

type CategoryInput = {
  name?: string | null;
  description?: string | null;
  collection?: string | null;
  attributes_json?: unknown;
  attributes?: unknown;
};

export const ALLOWED_RWA_NFT_CATEGORIES: Exclude<RwaNftCategory, "unknown">[] = [
  "pokemon",
  "one_piece",
  "basketball",
  "football",
  "hockey",
  "baseball",
  "soccer",
  "yugioh",
  "dragon_ball",
  "magic_the_gathering",
];

const POKEMON_CHARACTERS = [
  "pokemon", "pokémon", "pikachu", "raichu", "charizard", "charmander", "charmeleon",
  "mewtwo", "mew", "bulbasaur", "ivysaur", "venusaur", "squirtle", "wartortle", "blastoise",
  "eevee", "vaporeon", "jolteon", "flareon", "espeon", "umbreon", "leafeon", "glaceon", "sylveon",
  "gengar", "snorlax", "lapras", "dragonite", "lugia", "ho-oh", "rayquaza", "groudon", "kyogre",
  "arceus", "dialga", "palkia", "giratina", "darkrai", "celebi", "jirachi", "deoxys",
  "lucario", "garchomp", "metagross", "salamence", "tyranitar", "blaziken", "swampert", "sceptile",
  "infernape", "empoleon", "torterra", "serperior", "samurott", "emboar", "greninja", "chesnaught",
  "delphox", "decidueye", "incineroar", "primarina", "zacian", "zamazenta", "calyrex",
  "magikarp", "gyarados", "articuno", "zapdos", "moltres", "entei", "raikou", "suicune",
  "scizor", "scyther", "alakazam", "machamp", "golem", "onix", "rhyhorn", "rhydon",
  "ditto", "porygon", "kabuto", "kabutops", "aerodactyl", "snubbull", "togepi",
  "ribombee", "torkoal", "spiritomb", "ninetales", "vulpix", "machop", "marowak", "cubone",
  "reshiram", "zekrom", "kyurem", "victini", "keldeo", "meloetta", "genesect", "diancie",
  "hoopa", "volcanion", "magearna", "marshadow", "necrozma", "tapu", "ultra beast",
  "mimikyu", "lilligant", "houndoom", "ampharos", "lugia",
];

const POKEMON_PATTERNS = [
  "vmax", "vstar", "v-union", "v union", " v ", "/v ", " gx", "/gx",
  " ex ", "/ex ", "ex ", "break ", " break", "full art", "rainbow rare", "trainer gallery",
  "neo discovery", "neo destiny", "neo revelation", "neo genesis",
  "base set", "fossil", "jungle", "team rocket", "gym heroes", "gym challenge",
  "evolutions", "celebrations", "lost origin", "silver tempest", "crown zenith",
  "scarlet & violet", "scarlet and violet", "sword & shield", "sword and shield",
  "sun & moon", "sun and moon", "x & y", "xy ", "diamond & pearl", "diamond and pearl",
  "platinum ", "heartgold", "soulsilver", "black & white",
  "japanese pokemon", "pokemon japanese", "pokemon center",
];

const ONE_PIECE_TERMS = [
  "one piece", "one-piece", "luffy", "zoro", "nami", "sanji", "chopper", "tony tony",
  "robin", "franky", "brook", "jinbe", "jinbei", "usopp", "ace ", "portgas", "sabo",
  "trafalgar", "law ", "shanks", "buggy", "mihawk", "doflamingo", "crocodile",
  "kaido", "kaidou", "big mom", "whitebeard", "blackbeard", "katakuri", "yamato",
  "boa hancock", "perona", "smoker", "akainu", "kizaru", "aokiji", "fujitora",
  "marco", "magellan", "enel", "rob lucci",
  "premium card", "op0", " op1", " op2", " op3", " op4", " op5", " op6", " op7", " op8", " op9",
  "st01", "st02", "st03", "st04", "st05", "st06", "st07", "st08",
  "romance dawn", "paramount war", "pillars of strength", "kingdoms of intrigue",
];

const BASKETBALL_TERMS = [
  "nba", "basketball", "panini basketball", "panini hoops", "panini prizm basketball",
  "topps basketball", "upper deck basketball",
  "lebron", "lebron james", "jordan", "michael jordan", "kobe", "bryant",
  "curry", "stephen curry", "durant", "kevin durant", "luka", "doncic",
  "tatum", "jayson tatum", "giannis", "antetokounmpo", "embiid", "joel embiid",
  "ja morant", "trae young", "zion williamson", "anthony davis",
  "kawhi leonard", "harden", "russell westbrook", "chris paul", "damian lillard",
  "wembanyama", "victor wembanyama", "coby white", "anthony edwards", "lamelo ball",
  "mosaic basketball", "select basketball", "donruss basketball",
];

const FOOTBALL_TERMS = [
  "nfl", "football", "quarterback", "panini football", "prizm football", "rookie football",
  "tom brady", "patrick mahomes", "aaron rodgers", "lamar jackson", "joe burrow",
  "justin herbert", "josh allen", "trevor lawrence", "ja'marr chase", "justin jefferson",
  "saquon barkley", "derrick henry", "christian mccaffrey", "russell wilson",
  "donruss football", "topps football", "panini contenders",
];

const HOCKEY_TERMS = [
  "nhl", "hockey", "upper deck hockey", "rookie hockey", "young guns",
  "mcdavid", "connor mcdavid", "ovechkin", "alex ovechkin", "crosby", "sidney crosby",
  "matthews", "auston matthews", "draisaitl", "leon draisaitl",
];

const BASEBALL_TERMS = [
  "baseball", "mlb", "topps baseball", "topps chrome baseball", "bowman baseball",
  "panini baseball", "rookie baseball",
  "shohei ohtani", "ohtani", "mike trout", "aaron judge", "ronald acuna",
  "fernando tatis", "juan soto", "bryce harper", "vladimir guerrero",
  "babe ruth", "mickey mantle", "lou gehrig",
];

const SOCCER_TERMS = [
  "soccer", "fifa", "uefa", "champions league", "panini soccer", "football club",
  "messi", "lionel messi", "ronaldo", "cristiano", "mbappe", "kylian mbappe",
  "haaland", "erling haaland", "neymar", "lewandowski", "vinicius", "vinicius jr",
  "bellingham", "jude bellingham", "salah", "modric", "benzema", "kane", "harry kane",
  "panini world cup", "topps soccer",
];

const YUGIOH_TERMS = [
  "yu-gi-oh", "yu gi oh", "yugioh", "yugi", "kaiba", "seto kaiba", "joey wheeler",
  "dark magician", "blue-eyes", "blue eyes white dragon", "blue-eyes white dragon",
  "exodia", "kuriboh", "obelisk", "slifer", "ra ", "winged dragon of ra",
  "synchro", "xyz monster", "link monster", "pendulum", "tag force",
  "stardust dragon", "red-eyes", "red eyes black dragon",
  "ghosts from the past", "legendary collection", "duelist pack",
];

const DRAGON_BALL_TERMS = [
  "dragon ball", "dragonball", "dbz", "db super", "goku", "son goku", "vegeta",
  "gohan", "trunks", "piccolo", "frieza", "freeza", "cell ", "buu", "majin",
  "broly", "beerus", "whis", "jiren", "saiyan", "super saiyan", "ssj",
  "bardock", "bulma", "krillin", "yamcha", "tien", "android 17", "android 18",
  "dragon ball fusion", "dragon ball masters", "dragon ball heroes",
];

const MTG_TERMS = [
  "magic the gathering", "magic: the gathering", "mtg ", "planeswalker",
  "black lotus", "mox ", "lightning bolt", "tarmogoyf", "jace ", "liliana",
  "chandra", "garruk", "elspeth", "nicol bolas", "ugin", "teferi",
  "force of will", "counterspell", "wrath of god", "swords to plowshares",
  "alpha edition", "beta edition", "unlimited edition", "revised",
  "double masters", "modern horizons", "commander legends",
];

const KEYWORD_MATCHERS: Record<Exclude<RwaNftCategory, "unknown">, string[]> = {
  pokemon: [...POKEMON_CHARACTERS, ...POKEMON_PATTERNS],
  one_piece: ONE_PIECE_TERMS,
  basketball: BASKETBALL_TERMS,
  football: FOOTBALL_TERMS,
  hockey: HOCKEY_TERMS,
  baseball: BASEBALL_TERMS,
  soccer: SOCCER_TERMS,
  yugioh: YUGIOH_TERMS,
  dragon_ball: DRAGON_BALL_TERMS,
  magic_the_gathering: MTG_TERMS,
};

// Detection priority order (more specific patterns first to avoid e.g. "Goku" in a Pokemon set name).
const PRIORITY_ORDER: Exclude<RwaNftCategory, "unknown">[] = [
  "dragon_ball",
  "yugioh",
  "one_piece",
  "magic_the_gathering",
  "pokemon",
  "basketball",
  "football",
  "hockey",
  "baseball",
  "soccer",
];

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/�/g, "e")
    .toLowerCase();
}

function attributeText(value: unknown): string {
  const attributes = Array.isArray(value) ? value : [];
  return attributes
    .map((attribute) => {
      if (!attribute || typeof attribute !== "object" || Array.isArray(attribute)) return "";
      const row = attribute as Record<string, unknown>;
      return `${row.trait_type ?? row.traitType ?? row.key ?? ""} ${row.value ?? ""}`;
    })
    .join(" ");
}

export function detectRwaNftCategory(nft: CategoryInput): RwaNftCategory {
  const haystack = normalize([
    nft.name,
    nft.description,
    nft.collection,
    attributeText(nft.attributes_json),
    attributeText(nft.attributes),
  ].join(" "));

  for (const category of PRIORITY_ORDER) {
    const keywords = KEYWORD_MATCHERS[category];
    if (keywords.some((keyword) => haystack.includes(normalize(keyword)))) {
      return category;
    }
  }

  return "unknown";
}

export function isAllowedRwaNftCategory(category: string | null | undefined): category is Exclude<RwaNftCategory, "unknown"> {
  return ALLOWED_RWA_NFT_CATEGORIES.includes(category as Exclude<RwaNftCategory, "unknown">);
}
