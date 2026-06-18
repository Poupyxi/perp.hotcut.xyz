export function categoryIcon(category: string | null | undefined) {
  if (!category) return null;

  const normalized = category.toLowerCase().replace(/-cards?$/, "").replace(/-/g, "_");

  if (normalized === "pokemon" || normalized === "pokémon") return "/IconPOKEMON.png";
  if (normalized === "one_piece") return "/IconONEPIECE.png";
  if (normalized === "basketball" || normalized === "nba") return "/IconNBA.png";
  if (normalized === "football" || normalized === "nfl") return "/IconNFL.png";
  if (normalized === "hockey" || normalized === "nhl") return "/IconNHL.png";
  if (normalized === "baseball" || normalized === "mlb") return "/IconMLB.png";
  if (normalized === "soccer") return "/IconSOCCER.png";
  if (normalized === "yugioh" || normalized === "yu_gi_oh") return "/IconYUGIOH.png";
  if (normalized === "dragon_ball") return "/IconDRAGONBALL.png";
  if (normalized === "magic_the_gathering" || normalized === "mtg") return "/IconMAGIC.png";

  return null;
}
