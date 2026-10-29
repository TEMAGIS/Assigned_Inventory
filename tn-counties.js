// ============================================================================
//  TN_COUNTIES — map of 5-digit FIPS code → { county, region }.
//  Used by the editable address row in the detail modal to convert a
//  Census geocoder result (which returns FIPS) into the human-readable
//  county name and TEMA region (East / Middle / Southeast / West).
//
//  Generated from regions.csv. Update the CSV + regenerate if TEMA
//  ever changes county-to-region assignments.
// ============================================================================

export const TN_STATE_FIPS = '47';

export const TN_COUNTIES = {
  '47001': { county: 'Anderson', region: 'East' },
  '47003': { county: 'Bedford', region: 'Middle' },
  '47005': { county: 'Benton', region: 'West' },
  '47007': { county: 'Bledsoe', region: 'Southeast' },
  '47009': { county: 'Blount', region: 'East' },
  '47011': { county: 'Bradley', region: 'Southeast' },
  '47013': { county: 'Campbell', region: 'East' },
  '47015': { county: 'Cannon', region: 'Middle' },
  '47017': { county: 'Carroll', region: 'West' },
  '47019': { county: 'Carter', region: 'East' },
  '47021': { county: 'Cheatham', region: 'Middle' },
  '47023': { county: 'Chester', region: 'West' },
  '47025': { county: 'Claiborne', region: 'East' },
  '47027': { county: 'Clay', region: 'Middle' },
  '47029': { county: 'Cocke', region: 'East' },
  '47031': { county: 'Coffee', region: 'Southeast' },
  '47033': { county: 'Crockett', region: 'West' },
  '47035': { county: 'Cumberland', region: 'East' },
  '47037': { county: 'Davidson', region: 'Middle' },
  '47039': { county: 'Decatur', region: 'West' },
  '47041': { county: 'DeKalb', region: 'Middle' },
  '47043': { county: 'Dickson', region: 'Middle' },
  '47045': { county: 'Dyer', region: 'West' },
  '47047': { county: 'Fayette', region: 'West' },
  '47049': { county: 'Fentress', region: 'East' },
  '47051': { county: 'Franklin', region: 'Southeast' },
  '47053': { county: 'Gibson', region: 'West' },
  '47055': { county: 'Giles', region: 'Middle' },
  '47057': { county: 'Grainger', region: 'East' },
  '47059': { county: 'Greene', region: 'East' },
  '47061': { county: 'Grundy', region: 'Southeast' },
  '47063': { county: 'Hamblen', region: 'East' },
  '47065': { county: 'Hamilton', region: 'Southeast' },
  '47067': { county: 'Hancock', region: 'East' },
  '47069': { county: 'Hardeman', region: 'West' },
  '47071': { county: 'Hardin', region: 'West' },
  '47073': { county: 'Hawkins', region: 'East' },
  '47075': { county: 'Haywood', region: 'West' },
  '47077': { county: 'Henderson', region: 'West' },
  '47079': { county: 'Henry', region: 'West' },
  '47081': { county: 'Hickman', region: 'Middle' },
  '47083': { county: 'Houston', region: 'Middle' },
  '47085': { county: 'Humphreys', region: 'Middle' },
  '47087': { county: 'Jackson', region: 'Middle' },
  '47089': { county: 'Jefferson', region: 'East' },
  '47091': { county: 'Johnson', region: 'East' },
  '47093': { county: 'Knox', region: 'East' },
  '47095': { county: 'Lake', region: 'West' },
  '47097': { county: 'Lauderdale', region: 'West' },
  '47099': { county: 'Lawrence', region: 'Middle' },
  '47101': { county: 'Lewis', region: 'Middle' },
  '47103': { county: 'Lincoln', region: 'Middle' },
  '47105': { county: 'Loudon', region: 'East' },
  '47107': { county: 'McMinn', region: 'Southeast' },
  '47109': { county: 'McNairy', region: 'West' },
  '47111': { county: 'Macon', region: 'Middle' },
  '47113': { county: 'Madison', region: 'West' },
  '47115': { county: 'Marion', region: 'Southeast' },
  '47117': { county: 'Marshall', region: 'Middle' },
  '47119': { county: 'Maury', region: 'Middle' },
  '47121': { county: 'Meigs', region: 'Southeast' },
  '47123': { county: 'Monroe', region: 'East' },
  '47125': { county: 'Montgomery', region: 'Middle' },
  '47127': { county: 'Moore', region: 'Middle' },
  '47129': { county: 'Morgan', region: 'East' },
  '47131': { county: 'Obion', region: 'West' },
  '47133': { county: 'Overton', region: 'Middle' },
  '47135': { county: 'Perry', region: 'Middle' },
  '47137': { county: 'Pickett', region: 'East' },
  '47139': { county: 'Polk', region: 'Southeast' },
  '47141': { county: 'Putnam', region: 'Middle' },
  '47143': { county: 'Rhea', region: 'Southeast' },
  '47145': { county: 'Roane', region: 'East' },
  '47147': { county: 'Robertson', region: 'Middle' },
  '47149': { county: 'Rutherford', region: 'Middle' },
  '47151': { county: 'Scott', region: 'East' },
  '47153': { county: 'Sequatchie', region: 'Southeast' },
  '47155': { county: 'Sevier', region: 'East' },
  '47157': { county: 'Shelby', region: 'West' },
  '47159': { county: 'Smith', region: 'Middle' },
  '47161': { county: 'Stewart', region: 'Middle' },
  '47163': { county: 'Sullivan', region: 'East' },
  '47165': { county: 'Sumner', region: 'Middle' },
  '47167': { county: 'Tipton', region: 'West' },
  '47169': { county: 'Trousdale', region: 'Middle' },
  '47171': { county: 'Unicoi', region: 'East' },
  '47173': { county: 'Union', region: 'East' },
  '47175': { county: 'Van Buren', region: 'Southeast' },
  '47177': { county: 'Warren', region: 'Southeast' },
  '47179': { county: 'Washington', region: 'East' },
  '47181': { county: 'Wayne', region: 'Middle' },
  '47183': { county: 'Weakley', region: 'West' },
  '47185': { county: 'White', region: 'Southeast' },
  '47187': { county: 'Williamson', region: 'Middle' },
  '47189': { county: 'Wilson', region: 'Middle' },
};

// Build a 5-digit FIPS string from separate state + county codes (as the
// Census geocoder returns them). Pads the county to 3 digits.
export function buildFips(stateFips, countyFips) {
  const s = String(stateFips || '').padStart(2, '0');
  const c = String(countyFips || '').padStart(3, '0');
  return s + c;
}

// Look up a TN county + region by 5-digit FIPS. Returns null if the
// FIPS isn't a TN county (so callers can decide whether to warn).
export function lookupTnCounty(fips) {
  if (!fips) return null;
  return TN_COUNTIES[String(fips)] || null;
}

// Pre-built case-insensitive name → entry map. Used by the ArcGIS
// geocoder path which returns county names ("Davidson") rather than
// FIPS codes. We strip a trailing " County" suffix that ArcGIS
// sometimes returns so the lookup matches either form.
const TN_COUNTIES_BY_NAME = (() => {
  const out = {};
  for (const fips of Object.keys(TN_COUNTIES)) {
    const entry = TN_COUNTIES[fips];
    out[entry.county.toLowerCase()] = { ...entry, fips };
  }
  return out;
})();

export function lookupTnCountyByName(name) {
  if (!name) return null;
  let key = String(name).trim().toLowerCase();
  key = key.replace(/\s+county$/i, '').trim();
  return TN_COUNTIES_BY_NAME[key] || null;
}
