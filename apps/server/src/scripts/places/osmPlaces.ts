/**
 * Turns OpenStreetMap features on and around the University of Ghana campus
 * into CampusRide places: which features become places, in which category,
 * under what name and aliases, with duplicates merged. Pure (no network, no
 * database), so the rules are tested once and the list they produce is
 * reviewable as a CSV before anything is seeded (see fetchOsmPlaces.ts).
 *
 * OSM data is © OpenStreetMap contributors, ODbL; wherever places are shown
 * the apps show that credit (PLACES_ATTRIBUTION).
 */
import path from "node:path";
import { CAMPUS_GATES, haversineDistanceMeters, isInServiceArea, normalizeSearchText, type PlaceCategory } from "@rida/shared";

/** The reviewed list: written by fetchOsmPlaces.ts, read by seedPlaces.ts. */
export const PLACES_CSV = path.resolve(__dirname, "../../../prisma/data/campus-places.csv");

export interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface PlaceRow {
  name: string;
  category: PlaceCategory;
  latitude: number;
  longitude: number;
  aliases: string[];
  /** "osm:way/278303018" — the seed's key for "already have this one". */
  source: string;
  /** Anything a reviewer should double-check. */
  note: string;
}

/** The OSM campus boundary (way). Everything inside it is considered. */
export const UG_CAMPUS_WAY_ID = 308668766;

/**
 * Off-campus spots to include, by OSM id. Empty: the service area is the
 * Legon campus only, and off-campus service is a future feature (owner,
 * 2026-10-12). The campus query can't see outside the boundary, so this is
 * where such spots would go back, e.g.
 * "relation/8418096": { name: "Accra Mall", category: "LANDMARK" }.
 */
export const OFF_CAMPUS_ALLOWLIST: Record<string, { name: string; category: PlaceCategory; aliases?: string[] }> = {};

/**
 * Places OSM doesn't name as such. The gates come from CAMPUS_GATES in
 * @rida/shared (drivers never pass a gate: each is pinned on its INSIDE);
 * Legon Barrier is between the two 'Legon Barrier' bus stops (OSM nodes
 * 4981090364, 5028768235), inside the UG E-card lift gates, kept by the
 * owner 2026-10-12.
 */
export const MANUAL_PLACES: PlaceRow[] = [
  ...CAMPUS_GATES.map((g) => ({
    name: g.name,
    category: "GATE" as const,
    latitude: g.inside.latitude,
    longitude: g.inside.longitude,
    aliases: [...g.aliases],
    source: g.source,
    note: "",
  })),
  {
    name: "Legon Barrier",
    category: "GATE",
    latitude: 5.64154,
    longitude: -0.19768,
    aliases: ["Barrier"],
    source: "manual:legon-barrier",
    note: "",
  },
];

/** OSM ids to leave out: unclear, private, duplicated under another name, or not somewhere a car stops. */
export const EXCLUDE = new Set<string>([
  "node/7147491430", // "Alexander Kwapong Hall" tagged as a wastewater plant
  "node/6720686104", // "Balme Library" tagged as a fountain (the library itself is relation/7304886)
  "node/11303117010", // Balme Library Fountain (duplicate)
  "way/320067568", // Balme Library Fountain (duplicate)
  "node/7147521853", // "HIlla Limann" fountain
  "way/1548976998", // second "Legon Hall" outline (kept: way/427645339)
  "node/2369709555", // "Bush Canteen" fast food near Noguchi (kept: the food court way/628957891)
  "node/4246099076", // "Bush Canteen" restaurant (duplicate of the food court)
  "way/631051067", // church parking space
  "way/631051064", // church parking
  "way/631051065", // church parking
  "way/631051066", // church parking space
  "node/9660303974", // Muslim prayer lounge (a room, not a stop)
  "way/444487572", // unnamed-ish "University of Ghana" outline
  "way/308668766", // the campus itself
  "relation/12759086", // district
  "relation/1991855", // district
  "relation/12803764", // Accra
  "relation/20426437", // neighbourhood boundary
  "relation/20426438", // neighbourhood boundary
  "node/8404233112", // "Legon" town point
  "node/9660303977", // Commonwealth Hall Chapel — riders say "Commonwealth Hall"
  "node/11222432477", // Commonwealth Hall Library — likewise
  "node/9660303979", // Commonwealth Hall Observatory — likewise
  "node/9661039848", // "Hall Library" — a room in a hall
  "way/718588091", // Mensah Sarbah Hall Mosque — riders say "Sarbah"
  "way/278303045", // "Anglican Church Legon Hall" — 20 m from the main Anglican church (kept)
  "relation/5912384", // "International House" — removed by the owner, 2026-10-12
  "way/394125199", // "International House" (second outline)
  "way/320073867", // "Legon Main Entrance" building — unclear; the Main Gate is added by hand
]);

/** OSM name → the name riders know (or a tidier one). */
export const RENAME: Record<string, string> = {
  "The Balme Library": "Balme Library",
  "Dep't of History": "Department of History",
  "Dep't of Sociology": "Department of Sociology",
  "Chemistry Department, University of Ghana": "Department of Chemistry",
  "Physics Department, University of Ghana": "Department of Physics",
  "Department of Economics, University of Ghana": "Department of Economics",
  "Maths Dept": "Department of Mathematics",
  "Mathematics Dept": "Department of Mathematics",
  "Computer Science Dept": "Department of Computer Science",
  "African Studies Dept": "Institute of African Studies",
  "Commonwealth Dinning hall": "Commonwealth Hall Dining Hall",
  "Department of Archaelogy": "Department of Archaeology",
  "Museum of Archaelogy": "Museum of Archaeology",
  "Confusious Institute": "Confucius Institute",
  "Career and councelling dept": "Careers and Counselling Centre",
  "Modern language department": "Department of Modern Languages",
  "Language Center": "Language Centre",
  "School of Performing Art": "School of Performing Arts",
  "Altectic Oval Basket ball court": "Athletic Oval Basketball Court",
  "Legon hall barbeque joint": "Legon Hall Barbeque Joint",
  "Maison Francais": "Maison Française",
  "college of education": "College of Education",
  "communication dept": "Department of Communication Studies",
  "Old law faculty": "Old Law Faculty",
  "Institute of Statistical and Social and Economic Research (ISSER)": "ISSER",
  "University of Ghana Medical Center Limited": "University of Ghana Medical Centre",
  "Elizabeth Frances Sey Hall": "Elizabeth Frances Sey Hall",
  "Earth Science": "Department of Earth Science",
  "Earth Science Department, Legon": "Department of Earth Science",
  "Department of Geography and Resource Development, Legon": "Department of Geography and Resource Development",
  "College of Agric and Consumer Science, Legon": "College of Agriculture and Consumer Sciences",
  "LECIAD, Legon": "LECIAD",
  "RSGIS Lab, Legon": "RSGIS Lab",
  "Graduate School, Legon": "School of Graduate Studies",
  "Pent Food Court": "Pentagon Food Court",
  "tickels restaurant": "Tickels Restaurant",
  "bervels": "Bervels",
  "family health shio": "Family Health Shop",
  "Akuafo Hall Main": "Akuafo Hall",
  "Faculty of Arts, Languages": "Faculty of Arts (Languages)",
  Total: "Total Filling Station",
  Oando: "Oando Filling Station",
  "University of Ghana banking square": "Banking Square",
  "Legon Pool Side (University of Ghana)": "Legon Pool Side",
  "University of Ghana Computing Systems (UGCS)": "UG Computing Systems",
  "New N Block, NNB": "New N Block",
  "Anglican Church- Main Church": "Anglican Church (Main)",
  "Larway Oraca Building": "Larway Oraca Building",
};

/** Extra search words riders use. Keyed by the FINAL name. */
export const ALIASES: Record<string, string[]> = {
  "Balme Library": ["Balme", "Main Library", "Library"],
  "Commonwealth Hall": ["Vandals", "Vandal City", "Commonwealth", "Vandal"],
  "Mensah Sarbah Hall": ["Sarbah", "Sarbah Hall"],
  "Akuafo Hall": ["Akuafo", "Akuafo Main"],
  "Legon Hall": ["Legon"],
  "Volta Hall": ["Volta"],
  "Jean Nelson Aka Hall": ["Jean Nelson", "JNAH"],
  "Elizabeth Frances Sey Hall": ["Sey", "Elizabeth Sey", "Sey Hall"],
  "Dr. Hilla Limann Hall": ["Limann", "Hilla Limann"],
  "Alexander Kwapong Hall": ["Kwapong"],
  "James Topp Nelson Yankah Hall": ["TF", "TF Hall", "Nelson Yankah"],
  "Jubilee Hall": ["Jubilee"],
  "International Students Hostel 1": ["ISH", "ISH 1"],
  "International Students Hostel 2": ["ISH 2"],
  "University of Ghana Business School": ["UGBS", "Business School"],
  "University of Ghana Medical Centre": ["UGMC", "Medical Centre", "Medical Center"],
  "University of Ghana Hospital": ["Legon Hospital", "Hospital", "Health Services"],
  "University of Ghana Sports Stadium": ["Stadium", "Legon Stadium", "Sports Stadium"],
  "Night Market": ["Night Mkt"],
  "Central Cafeteria": ["CC", "Cafeteria"],
  "James Quartey Building": ["JQB"],
  "K. A. Busia Building": ["KAB", "Busia"],
  "New N Block": ["NNB", "N Block"],
  "Noguchi Memorial Institute for Medical Research": ["Noguchi", "NMIMR"],
  "Valco Trust Hostel Phase 1": ["Valco", "Valco Trust"],
  "Valco Trust Hostel Phase 2": ["Valco 2"],
  "School of Engineering Sciences": ["Engineering", "SES"],
  "SRC Union Building": ["SRC", "Union Building"],
  "Great Hall": ["Legon Great Hall"],
  "University of Ghana Registry": ["Registry"],
  "University of Ghana Botanical Gardens": ["Botanical Gardens", "Botanical Garden"],
  "University of Ghana Bookshop": ["Bookshop"],
  "Legon City Mall": ["City Mall"],
  "Pentagon Block A": ["Pentagon"],
  "Pentagon Block B": ["Pentagon"],
  "Pentagon Block C": ["Pentagon"],
  "Pentagon Food Court": ["Pent food court"],
  "Banking Square": ["Banks", "UG Banking Square"],
  "Athletic Oval": ["Oval"],
  "Legon Pool Side": ["Swimming Pool", "Pool Side", "Pool"],
  "UG Gymnasium": ["Gym"],
  "School of Law": ["Law School", "Law Faculty"],
  "Department of Computer Science": ["Computer Science", "CS"],
  "Institute of African Studies": ["African Studies"],
  "Centre for Remote Sensing and Geographic Information Service": ["CERSGIS"],
  "West Africa Centre for Crop Improvement": ["WACCI"],
  "Legon Police Station": ["Police Station", "Police"],
  "University Fire Station Legon": ["Fire Station"],
  "Cedi Conference Centre": ["CEDI"],
  "UGBS Graduate Campus": ["UGBS Graduate"],
  "Total Filling Station": ["Total", "Total Legon"],
  "Oando Filling Station": ["Oando"],
  "UG Computing Systems": ["UGCS"],
  "ISSER Building": ["ISSER"],
  "Jubilee Circle": ["Jubilee roundabout"],
  "Little Legon": ["Staff village"],
  "Faculty of Arts (Languages)": ["Faculty of Arts", "Arts"],
};

/**
 * What a reviewer should double-check, by final name. Empty: the owner
 * reviewed the list on 2026-10-12 (kept: Akuafo Hall Annex and Annex A–D,
 * "Faculty of Arts (Languages)", the food-court Bush Canteen).
 */
export const NOTES: Record<string, string> = {};

/** "James Quartey Building, JQB" → name "James Quartey Building", alias "JQB". */
export function splitAbbreviation(name: string): { name: string; alias: string | null } {
  const m = /^(.+?),\s*([A-Z][A-Z0-9 ]{1,7})$/.exec(name.trim());
  return m ? { name: m[1]!.trim(), alias: m[2]!.trim() } : { name: name.trim(), alias: null };
}

const ROAD = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|footway|path|track|cycleway|steps|pedestrian)(_link)?$/;

/** Names that are a room, a block letter or a fixture, not somewhere a car stops. */
const NOT_A_STOP =
  /^(block\s*[a-z]?|blocke|office|generator|rest station|cash office|east legon(\s*\d+)?|.*washroom.*|.*store room.*|dance (office|practical.*)|secretary's office|small food vendor|food vendors|mobile money|laptop repairs.*|samsung shop|aunty nancy's shop|lizalex|isser annex pagoda.*|.*parking.*|.*car park.*|graduate block c.*|energy building|gis lab.*|soil science|statistics|n block|economics department|physics|dance practical venue|rips building|home science annex|chemistry department extension|balme library extension|information studies labs|ecowas coastal.*|nature and food development.*|internal audit directorate|public affairs directorate|ghana dance ensemble|j\.h\. kwabena nketia archives|archeology lecturers offices|geography lecturers office|agric science extension|distance education center|department of family and consumer sciences annex.*|the office of the provost.*|institute of statistical.*|frank torto chemistry building|biotechnology centre|ghana water company.*|electricity company of ghana.*|wsloop|pilosoft services|cirrus networks|gmi motors|michelin|nailcanta|mishvet.*|jsq sewage.*|mellow foods.*|ot 50|university staff house|vice chancellor's residence|florence a\.dolphyne charlets|the baby nest|legon primary school|university of ghana basic school|ayido valley flat block [a-e])$/i;

/** The category for a feature, or null when it shouldn't be a place at all. */
export function categorize(tags: Record<string, string>): PlaceCategory | null {
  const name = tags.name ?? "";
  if (!name || NOT_A_STOP.test(name.trim())) return null;
  // Named roundabouts ("Jubilee Circle") and junctions are where people say "pick me up at".
  if ((tags.junction === "roundabout" && /circle$/i.test(name.trim())) || tags.junction === "yes") return "LANDMARK";
  if (tags.highway && (ROAD.test(tags.highway) || tags.highway === "bus_stop" || tags.highway === "traffic_signals")) return null;
  if (tags.type === "route" || tags.boundary || tags.place === "town") return null;
  if (tags.place === "neighbourhood") return /^little legon$/i.test(name.trim()) ? "LANDMARK" : null;

  const amenity = tags.amenity;
  const lower = name.toLowerCase();
  const hallish = /\bhall\b/.test(lower) && !/great hall|kingdom hall|church|dining|dinning|library|mosque|chapel|ict|observatory|barbeque|basketball|laundromat/.test(lower);

  if (hallish && (tags.tourism === "hostel" || tags.building === "dormitory" || tags.building === "yes" || tags.building === "house")) return "HALL";
  if (tags.tourism === "hostel" || tags.building === "dormitory") return "HOSTEL";
  if (["restaurant", "fast_food", "food_court", "cafe", "marketplace"].includes(amenity ?? "")) return "FOOD";
  if (["supermarket", "convenience", "food", "general"].includes(tags.shop ?? "")) return "FOOD";
  if (tags.barrier === "gate") return "GATE";
  if (
    ["college", "university", "school"].includes(amenity ?? "") ||
    tags.building === "university" ||
    ["university", "research", "education"].includes(tags.office ?? "") ||
    /\b(department|dept|faculty|school of|institute|centre for|center for|college of|confucius|language centre|counselling|lecture|maison|computing systems)\b/.test(lower) ||
    (tags.building !== undefined && /\b(building|n block|nnb|jqb|kab)\b/.test(lower) && !/union building/.test(lower))
  ) {
    return "FACULTY";
  }
  if (
    ["library", "hospital", "clinic", "post_office", "police", "fire_station", "place_of_worship", "fuel", "bus_station", "taxi", "theatre", "conference_centre", "studio", "pharmacy"].includes(amenity ?? "") ||
    ["stadium", "track", "swimming_pool", "fitness_centre", "sports_centre", "park", "garden"].includes(tags.leisure ?? "") ||
    ["mall", "books"].includes(tags.shop ?? "") ||
    ["attraction", "museum", "guest_house", "hotel"].includes(tags.tourism ?? "") ||
    tags.place === "square" ||
    tags.man_made === "observatory" ||
    /great hall|registry|src union|banking square|kufuor|amphitheatre|bookshop|guest centre/.test(lower)
  ) {
    return "LANDMARK";
  }
  return null;
}

function positionOf(el: OsmElement): { latitude: number; longitude: number } | null {
  const lat = el.center?.lat ?? el.lat;
  const lon = el.center?.lon ?? el.lon;
  return lat === undefined || lon === undefined ? null : { latitude: Number(lat.toFixed(6)), longitude: Number(lon.toFixed(6)) };
}

/** Kept when two candidates share a name: the one with the most specific tags wins. */
function specificity(tags: Record<string, string>): number {
  if (tags.amenity || tags.tourism || tags.leisure || tags.shop) return 2;
  if (tags.office || tags.building === "university") return 1;
  return 0;
}

const CATEGORY_ORDER: PlaceCategory[] = ["HALL", "HOSTEL", "FACULTY", "GATE", "FOOD", "LANDMARK", "OTHER"];

/**
 * The reviewable place list: OSM features categorized, renamed, aliased and
 * de-duplicated (one place per name within MERGE_METERS), plus the manual
 * gates and the off-campus allowlist; inside the service area only; sorted
 * by category, then name.
 */
export const MERGE_METERS = 200;

export function buildPlaceRows(campus: readonly OsmElement[], offCampus: readonly OsmElement[]): PlaceRow[] {
  const candidates: Array<PlaceRow & { rank: number }> = [];

  for (const el of campus) {
    const key = `${el.type}/${el.id}`;
    if (EXCLUDE.has(key) || !el.tags?.name) continue;
    if (NOT_A_STOP.test(el.tags.name.trim())) continue;
    const split = splitAbbreviation(RENAME[el.tags.name.trim()] ?? el.tags.name);
    const name = RENAME[split.name] ?? split.name;
    // Categorized by the tidied name ("Dep't of History" → "Department of History").
    const category = categorize({ ...el.tags, name });
    const at = positionOf(el);
    if (!category || !at) continue;
    const aliases = [
      ...(split.alias ? [split.alias] : []),
      ...(el.tags.short_name ? [el.tags.short_name] : []),
      ...(el.tags.alt_name ? [el.tags.alt_name] : []),
    ];
    candidates.push({ name, category, ...at, aliases, source: `osm:${key}`, note: "", rank: specificity(el.tags) });
  }

  for (const el of offCampus) {
    const spec = OFF_CAMPUS_ALLOWLIST[`${el.type}/${el.id}`];
    const at = positionOf(el);
    if (!spec || !at) continue;
    candidates.push({
      name: spec.name,
      category: spec.category,
      ...at,
      aliases: spec.aliases ?? [],
      source: `osm:${el.type}/${el.id}`,
      note: "",
      rank: 3,
    });
  }

  // One place per name nearby: keep the most specific, the first on a tie.
  const kept: Array<PlaceRow & { rank: number }> = [];
  for (const c of candidates.sort((a, b) => b.rank - a.rank)) {
    const twin = kept.find(
      (k) => normalizeSearchText(k.name) === normalizeSearchText(c.name) && haversineDistanceMeters(k, c) <= MERGE_METERS,
    );
    if (twin) {
      twin.aliases.push(...c.aliases);
      continue;
    }
    const farTwin = kept.find((k) => normalizeSearchText(k.name) === normalizeSearchText(c.name));
    if (farTwin) c.note = `Another "${c.name}" is ${Math.round(haversineDistanceMeters(farTwin, c))} m away — keep both?`;
    kept.push(c);
  }

  const rows: PlaceRow[] = [...kept.map(({ rank: _rank, ...row }) => row), ...MANUAL_PLACES.map((p) => ({ ...p }))]
    .filter((row) => isInServiceArea(row))
    .map((row) => {
      const aliases = [...row.aliases, ...(ALIASES[row.name] ?? [])].map((a) => a.trim()).filter(Boolean);
      const unique = [...new Map(aliases.map((a) => [normalizeSearchText(a), a])).values()].filter(
        (a) => normalizeSearchText(a) !== normalizeSearchText(row.name),
      );
      return { ...row, aliases: unique, note: [row.note, NOTES[row.name]].filter(Boolean).join(" ") };
    });

  return rows.sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || a.name.localeCompare(b.name),
  );
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

export const CSV_HEADER = ["name", "category", "latitude", "longitude", "aliases", "source", "note"] as const;

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Aliases are joined with "|" in one cell. */
export function toCsv(rows: readonly PlaceRow[]): string {
  const lines = [CSV_HEADER.join(",")];
  for (const r of rows) {
    lines.push(
      [r.name, r.category, String(r.latitude), String(r.longitude), r.aliases.join("|"), r.source, r.note].map(csvCell).join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out;
}

/** Reads the reviewed CSV back. Throws with the line number on anything malformed. */
export function fromCsv(text: string): PlaceRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = parseCsvLine(lines[0] ?? "");
  if (CSV_HEADER.some((h, i) => header[i] !== h)) throw new Error(`CSV header must be: ${CSV_HEADER.join(",")}`);
  return lines.slice(1).map((line, i) => {
    const [name, category, lat, lng, aliases, source, note] = parseCsvLine(line);
    const latitude = Number(lat);
    const longitude = Number(lng);
    const where = `line ${i + 2}`;
    if (!name?.trim()) throw new Error(`${where}: name is empty`);
    if (!CATEGORY_ORDER.includes(category as PlaceCategory)) throw new Error(`${where}: unknown category "${category}"`);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error(`${where}: latitude/longitude must be numbers`);
    if (!isInServiceArea({ latitude, longitude })) throw new Error(`${where}: ${name} is outside the service area`);
    if (!source?.trim()) throw new Error(`${where}: source is empty`);
    return {
      name: name.trim(),
      category: category as PlaceCategory,
      latitude,
      longitude,
      aliases: (aliases ?? "").split("|").map((a) => a.trim()).filter(Boolean),
      source: source.trim(),
      note: note ?? "",
    };
  });
}
