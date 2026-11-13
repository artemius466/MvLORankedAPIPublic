// The officially assigned ISO 3166-1 alpha-2 codes - what a player may set as
// their profile country (see users.updateCountry / PUT /me/country). Kept in
// sync with frontend/js/countries.js, which renders the same list into the
// profile settings dropdown; there is no bundler here to share one copy
// between server and browser, and the list is stable enough that duplicating
// it is cheaper than building one.
//
// Just codes, not names: Intl.DisplayNames resolves a valid code to its
// English name at render time (both here and in the browser) rather than
// this file carrying 249 name strings that would need translating too.
// DisplayNames alone cannot validate, though - it happily returns malformed
// input back unchanged instead of throwing - so this whitelist is what
// actually decides whether a code is acceptable.
const CODES = new Set(`
AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ
BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ
CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ
DE DJ DK DM DO DZ
EC EE EG EH ER ES ET
FI FJ FK FM FO FR
GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY
HK HM HN HR HT HU
ID IE IL IM IN IO IQ IR IS IT
JE JM JO JP
KE KG KH KI KM KN KP KR KW KY KZ
LA LB LC LI LK LR LS LT LU LV LY
MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ
NA NC NE NF NG NI NL NO NP NR NU NZ
OM
PA PE PF PG PH PK PL PM PN PR PS PT PW PY
QA
RE RO RS RU RW
SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ
TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ
UA UG UM US UY UZ
VA VC VE VG VI VN VU
WF WS
YE YT
ZA ZM ZW
`.split(/\s+/).filter(Boolean));

function isValid(code) {
  return typeof code === 'string' && CODES.has(code);
}

module.exports = { CODES, isValid };
