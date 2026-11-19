// utils/university.js
// Single source of truth for campus identity across listings, search and analytics.
// Free-typed university text ("UCC", "u.c.c", "University of Cape Coast") all
// resolve to ONE stable key ("ucc"). Unknown institutions still get a stable
// slug key, so grouping and filtering never silently break.

const UNIVERSITIES = [
  { key: "ucc", short: "UCC", name: "University of Cape Coast", aliases: ["ucc", "university of cape coast", "cape coast university"] },
  { key: "ug", short: "UG", name: "University of Ghana", aliases: ["ug", "legon", "ug legon", "university of ghana", "university of ghana legon"] },
  { key: "knust", short: "KNUST", name: "Kwame Nkrumah University of Science and Technology", aliases: ["knust", "kwame nkrumah university of science and technology", "kwame nkrumah university"] },
  { key: "uew", short: "UEW", name: "University of Education, Winneba", aliases: ["uew", "university of education winneba", "university of education", "uew winneba"] },
  { key: "uds", short: "UDS", name: "University for Development Studies", aliases: ["uds", "university for development studies"] },
  { key: "umat", short: "UMaT", name: "University of Mines and Technology", aliases: ["umat", "university of mines and technology", "university of mines"] },
  { key: "uhas", short: "UHAS", name: "University of Health and Allied Sciences", aliases: ["uhas", "university of health and allied sciences"] },
  { key: "upsa", short: "UPSA", name: "University of Professional Studies, Accra", aliases: ["upsa", "university of professional studies accra", "university of professional studies"] },
  { key: "gimpa", short: "GIMPA", name: "Ghana Institute of Management and Public Administration", aliases: ["gimpa", "ghana institute of management and public administration"] },
  { key: "ashesi", short: "Ashesi", name: "Ashesi University", aliases: ["ashesi", "ashesi university"] },
  { key: "uenr", short: "UENR", name: "University of Energy and Natural Resources", aliases: ["uenr", "university of energy and natural resources"] },
  { key: "cktutas", short: "CKT-UTAS", name: "C. K. Tedam University of Technology and Applied Sciences", aliases: ["cktutas", "ckt utas", "ck tedam university of technology and applied sciences"] },
  { key: "aamusted", short: "AAMUSTED", name: "Akenten Appiah-Menka University of Skills Training and Entrepreneurial Development", aliases: ["aamusted", "akenten appiah menka university of skills training and entrepreneurial development"] },
  { key: "gctu", short: "GCTU", name: "Ghana Communication Technology University", aliases: ["gctu", "gtuc", "ghana communication technology university", "ghana technology university college"] },
  { key: "uesd", short: "UESD", name: "University of Environment and Sustainable Development", aliases: ["uesd", "university of environment and sustainable development"] },
  { key: "umac", short: "UMaC", name: "University of Media, Arts and Communication", aliases: ["umac", "university of media arts and communication"] },
  { key: "vvu", short: "VVU", name: "Valley View University", aliases: ["vvu", "valley view university"] },
  { key: "central", short: "Central", name: "Central University", aliases: ["central university", "central university ghana", "central university college"] },
  { key: "cug", short: "CUG", name: "Catholic University of Ghana", aliases: ["cug", "catholic university of ghana", "catholic university college of ghana"] },
  { key: "pug", short: "PUG", name: "Presbyterian University, Ghana", aliases: ["pug", "presbyterian university", "presbyterian university ghana", "presbyterian university college"] },
  { key: "mug", short: "MUG", name: "Methodist University Ghana", aliases: ["mug", "methodist university", "methodist university ghana", "methodist university college ghana"] },
  { key: "pentvars", short: "Pentecost", name: "Pentecost University", aliases: ["pentvars", "pentecost university", "pentecost university college"] },
  { key: "knutsford", short: "Knutsford", name: "Knutsford University", aliases: ["knutsford university", "knutsford"] },
  { key: "wiuc", short: "WIUC", name: "Wisconsin International University College", aliases: ["wiuc", "wisconsin international university college"] },
  { key: "anu", short: "ANU", name: "All Nations University", aliases: ["anu", "all nations university", "all nations university college"] },
  { key: "atu", short: "ATU", name: "Accra Technical University", aliases: ["atu", "accra technical university"] },
  { key: "kstu", short: "KsTU", name: "Kumasi Technical University", aliases: ["kstu", "kumasi technical university"] },
  { key: "ktu", short: "KTU", name: "Koforidua Technical University", aliases: ["ktu", "koforidua technical university"] },
  { key: "ttu", short: "TTU", name: "Takoradi Technical University", aliases: ["ttu", "takoradi technical university"] },
  { key: "cctu", short: "CCTU", name: "Cape Coast Technical University", aliases: ["cctu", "cape coast technical university"] },
  { key: "htu", short: "HTU", name: "Ho Technical University", aliases: ["htu", "ho technical university"] },
  { key: "stu", short: "STU", name: "Sunyani Technical University", aliases: ["stu", "sunyani technical university"] },
  { key: "tatu", short: "TaTU", name: "Tamale Technical University", aliases: ["tatu", "tamale technical university"] },
  { key: "btu", short: "BTU", name: "Bolgatanga Technical University", aliases: ["btu", "bolgatanga technical university"] },
]

// Lowercase, strip accents and punctuation, expand "uni"/"univ", drop filler words.
// Applied identically to user input AND to every alias, so matching is symmetric.
const clean = (value) =>
  String(value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.'’`]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(uni|univ)\b/g, "university")
    .replace(/\b(the|of|at|in|for|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const compact = (value) => value.replace(/ /g, "")

const exactMap = new Map()      // cleaned alias -> key
const compactMap = new Map()    // alias without spaces -> key ("u c c" => "ucc")
const longAliases = []          // multi-word names, for "contains" matching
const acronymAliases = new Map() // single-token acronyms, for whole-token matching

for (const uni of UNIVERSITIES) {
  for (const raw of [uni.key, uni.short, uni.name, ...uni.aliases]) {
    const alias = clean(raw)
    if (!alias) continue
    exactMap.set(alias, uni.key)
    compactMap.set(compact(alias), uni.key)
    if (alias.includes(" ")) longAliases.push({ alias, key: uni.key })
    else if (alias.length <= 9) acronymAliases.set(alias, uni.key)
  }
}
longAliases.sort((a, b) => b.alias.length - a.alias.length) // longest match wins

const byKey = new Map(UNIVERSITIES.map((u) => [u.key, u]))

/** Stable key for any free-typed university text. "" when input is empty. */
export function universityKey(input) {
  const c = clean(input)
  if (!c) return ""
  const direct = exactMap.get(c) || compactMap.get(compact(c))
  if (direct) return direct
  const padded = ` ${c} `
  for (const { alias, key } of longAliases) if (padded.includes(` ${alias} `)) return key
  for (const token of c.split(" ")) if (acronymAliases.has(token)) return acronymAliases.get(token)
  return c.replace(/ /g, "-").slice(0, 60) // unknown institution: stable slug
}

/** Display name for a key, or "" if the key is not a known campus. */
export function universityName(key) {
  return byKey.get(key)?.name || ""
}

/** Campus list for dropdowns / autocomplete. */
export const CAMPUSES = UNIVERSITIES.map(({ key, short, name }) => ({ key, short, name }))

export { clean as normalizeCampusText }
