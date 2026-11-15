# Official brand and feature names, per language

**Exception: the electric backup.** Use the immersion heater word (immersion heater / elpatron / elektrisch element / Elektroheizpatrone / elkolbe / elpatron), never additional heat / tillsats / bijverwarming / Zusatzheizung / tilleggsvarme / tilskud, even where NIBE's display says so (maintainer, 2026-11-15). That covers the operating mode ("Immersion heater only", "Endast elpatron", "Alleen elektrisch element", "Nur Elektroheizpatrone", "Bare elkolbe", "Kun elpatron") and the settings NIBE names after additional heat (180, 185, 679). Rows 6b, 6c, 7f and 7g record NIBE's wording, not the app's.

Researched 2026-11-15 for the rule in CLAUDE.md: brand and NIBE names are written exactly as their owner writes them, in every language. The app uses "Smart Price Adaption" without the ™.

## Sources

NIBE S1155 manuals, edition 2425-2 (2024), downloaded from assetstore.nibe.se. The URL pattern is
`https://assetstore.nibe.se/hcms/v2.3/entity/document/<id>/storage/<base64("<id>/0/master")>`.

| Key | Document | Asset id | Doc no. |
|---|---|---|---|
| IHB-en | Installer manual S1155, EN | 889948 | IHB EN 2425-2 731887 |
| IHB-sv | Installatörshandbok S1155, SV | 889955 | IHB SV 2425-2 731870 |
| IHB-nl | Installateurshandleiding S1155, NL | 889924 | IHB NL 2425-2 731874 |
| IHB-de | Installateurhandbuch S1155, DE | 889946 | IHB DE 2425-2 731885 |
| IHB-no | Installatørhåndbok S1155, NO | 889952 | IHB NO 2425-2 731889 |
| IHB-da | Installatørhåndbog S1155, DA | 889957 | IHB DA 2425-2 731871 |
| UHB-xx | User manuals S1155: en 890000, sv 889990, nl 889991, de 889984, no 889992, da 889985 | | UHB xx 2425-2 |
| IHB-en-2021 | Older installer manual S1155, EN (cross-check) | 121142 | IHB EN 2150-1 631752 |

All IHB quotes come from the menu-tree list ("Menu system" chapter) and the "MENU x.y" sections.
Homey app strings come from Homey's own web app locale bundles at my.homey.app
(`/assets/index-Cxh3WlZV.js` for English, plus `nl-CzJhVlFH.js`, `de-fz8N3X8V.js`, `sv-CJvxh05n.js`,
`no-CCfYZJf4.js` and `da-BR0PMH6x.js`), as fetched on 2026-11-15. Marketing copy comes from homey.app/{en-us,nl-nl,de-de,sv-se,no-no,da-dk}/.
support.homey.app returned 403 to scripted fetches, so it wasn't used.

Only the S1155 was checked. The other S-series manuals (S1255, S2125, SMO S40, VVM S320) use the same
display software, but I didn't download them.

## NIBE names (display and manual)

| # | Name | en | sv | nl | de | no | da |
|---|---|---|---|---|---|---|---|
| 1 | Smart price adaption (menu 4.2.5) | **Smart Price Adaption™** in the menu list. In body text: "Smart price adaption™ adjusts some of the installation's…" | Smart Price Adaption™ (in English). Body: "Smart price adaption™ anpassar del av…" | Smart Price Adaption™ (in English). Body: "Smart price adaption™ stemt het verbruik…" | Smart Price Adaption™ (in English). Body: "Smart price adaption™ verlagert einen Teil…" | Smart Price Adaption™ (in English). Body: "Smart price adaption™ fordeler deler av…" | Smart Price Adaption™ (in English). Body: "Smart price adaption™ tilpasser en del…" |
| 2a | Hot water demand menu 2.2 (title) | Hot water demand | Varmvattenbehov | Warmwatervraag | Brauchwasserbedarf | Varmtvannsbehov | Varmtvandsbehov |
| 2b | Demand modes (2.2 "Alternatives") | Small, Medium, Large, Smart control | Litet, Medel, Stort, Smart control | Klein, Gemiddeld, Groot, Smart control | Niedrig, Mittel, Hoch, Smart control | Lite, Middels, Stort, Smart control | Lille, Middelstort, Stort, Smart control |
| 2c | Smart control casing | "Smart control" in the UI and as the option. Prose sometimes has "Smart Control" (for example "See menu 2.2 for more information about Smart Control") | Smart control | Smart control (prose: "Smart Control") | Smart control (prose: "Smart Control") | Smart control | Smart control (prose: "Smart Control") |
| 3 | myUplink | myUplink | myUplink | myUplink | myUplink | myUplink | myUplink |
| 4 | Smart Energy Source (menu 4.6) | Smart Energy Source™ | Smart Energy Source™ | Smart Energy Source™ | Smart Energy Source™ | Smart Energy Source™ | Smart Energy Source™ |
| 5a | More hot water (menu 2.1) | More hot water | Mer varmvatten | Meer warmwater | Mehr Brauchwasser | Mer varmtvann | Mere varmtvand |
| 5b | One-time option in 2.1 | "One-time incr." | "Engångshöjning" | "Eenm. verh." | "Einm. Erhöhung" | "Engangsøkning" | "Engangshævning" |
| 6a | Operating mode (menu 4.1, title) | Operating mode | Driftläge | Bedrijfsstand | Betriebsmodus | Driftsstilling | Driftsindstilling |
| 6b | Operating modes | Auto, Manual, Add. heat only | Auto, Manuellt, Endast tillsats | Auto, Handmatig, Alleen bijverw | Auto, Manuell, Nur Zusatzheizung | Auto, Manuelt, Bare till.varme | Auto, Manuelt, Kun tilskud |
| 6c | Manual sub-options | Compressor, Add. heat, Heating | Kompressor, Tillsats, Värme | Compressor, Bijverw., Verw. | Verdichter, ZH, Heizung | Kompressor, Till.varme, Varme | Kompressor, Tilskud, Varme |
| 7a | Heat curve (menu 1.30.1) | Curve, heating ("heating curve" in prose) | Kurva, värme ("värmekurva") | Stooklijn | Kurve, Heizung ("Heizkurve") | Kurve, varme ("varmekurve") | Kurve, varme ("varmekurve") |
| 7b | Curve offset (menu 1.1.1 value without room sensor) | "set value for heating (curve offset)" | "inställt värde för värme (kurvförskjutning)" | "instelwaarde voor verwarming (verschuiving stooklijn)" | "eingestellten Wert für die Heizung (Parallelverschiebung)". The 1.30.1 tip uses "Kurvenverschiebung" | "innstilt verdi for varme (kurveforskyvning)" | "indstillede varmeværdi (kurveforskydning)" |
| 7c | Point offset (menu 1.30.8) | Point offset | Punktförskjutning | Puntverschuiving | Punktverschiebung | Punktforskyvning | Punktforskydning |
| 7d | Room sensor settings (menu 1.3 / 1.3.3) | Room sensor settings | Rumsgivarinställningar | Instellingen ruimtesensor | Raumfühlereinstellungen | Romfølerinnstillinger | Rumfølerindstillinger |
| 7e | Room sensor (noun) | room sensor | rumsgivare | ruimtesensor (also "ruimtevoeler" in 1.1.1) | Raumfühler | romføler | rumføler |
| 7f | Additional heat (generic) | additional heat / "Add. heat" | tillsats | bijverwarming | Zusatzheizung (abbr. ZH) | tilleggsvarme / "Till.varme" | tilskud |
| 7g | Immersion heater | immersion heater ("Quick start with immersion heater") | elpatron ("Snabbstart med elpatron") | elektrisch verwarmingselement ("Snelstart met elektrisch verwarmingselement"). Also "elektrische bijverwarming" | Elektroheizpatrone ("Schnellstart mit Elektroheizpatrone") | elkolbe ("Hurtigstart med elkolbe") | el-patron ("Hurtig start med el-patron") |
| 7h | Away mode (menu 4.5) | Away mode | Bortaläge | Weg-modus | Abwesenheitsmodus | Bortemodus | Væk-tilstand |
| 7i | Holiday (scheduling, menu 6, UHB) | "Holiday" activated in menu 6 | "Semester" | "Vakantie" | „Urlaub" | "Ferie" | "Ferie" |
| 7j | Outdoor sensor BT1 | outdoor temperature sensor (BT1) | utegivare (BT1) | buitentemperatuursensor (BT1) | Außenluftfühler (BT1) | uteføler (BT1) | udeføler (BT1) |
| 7k | Plus functions (menu 4.2) | Plus functions | Plusfunktioner | Plusfuncties | Plusfunktionen | Plussfunksjoner | Plusfunktioner |
| 7l | SG Ready (menu 4.2.3) | SG Ready | SG Ready | SG Ready | SG Ready | SG Ready | SG Ready |

Notes on row 1: in every language the menu-tree entry and the setting list ("low electricity price (Smart Price
Adaption)") use **Title Case**, and the explanatory body text uses **sentence case** ("Smart price adaption™"). The 2021
EN manual has the same split, so NIBE is inconsistent with itself. The name stays in English in all six languages, and
it is always spelled "Adaption", never "Adaptation". The ™ is attached in menu titles and the first body mention.

## Homey names (Homey's own app and site)

| # | Name | en | sv | nl | de | no | da | Source |
|---|---|---|---|---|---|---|---|---|
| 8a | Homey | Homey | Homey | Homey | Homey | Homey | Homey | homey.app all locales |
| 8b | Homey Pro | Homey Pro (also "Homey Pro mini") | same | same | same | same | same | homey.app all locales |
| 8c | Homey Energy (brand) | Homey Energy (for example "Homey Energy Dongle") | same | same | same | same | same | homey.app nl/de/sv/da pages |
| 8d | Energy (app tab) | Energy | Energi | Energie | Energie | Energi | Energi | web app `navigation.energy` |
| 8e | Insights (app tab) | Insights | Insikter | Inzichten | Einblicke | Innsikter | Insights | web app `navigation.insights`. Marketing: sv and da "Homey Insights", nl "Homey Insights", de "Homey Einblicke", no "Homey Innsikter" |
| 8f | Flow | Flow / Flows (tab "Flows") | Flow (tab "Flow", "Nytt Flow") | Flow (tab "Flow", "Nieuwe Flow") | Flow (tab "Flow", "Neuer Flow") | Flow (tab "Flow", "Ny Flow") | Flow (tab "Flow", "Nyt Flow") | web app `navigation.flows` |
| 8g | Flow card | Flow card | Flow-kort | Flow-kaartjes | Flow-Karten | Flow-kortene | Flow-kort | homey.app section-flow |
| 8h | Advanced Flow | Advanced Flow | Advanced Flow | Advanced Flow | Advanced Flow | Advanced Flow | Advanced Flow | web app `advancedFlowTitle` |
| 8i | Repair (device menu) | Repair / "Repair device" | Reparera / "Reparera enhet" | Repareren / "Apparaat repareren" | Reparieren / "Gerät reparieren" | Reparer / "Reparer enhet" | Reparer / "Reparer enhed" | web app `device.repair`, `repairDevice` |
| 8j | Timeline | Timeline | Tidslinje | Tijdlijn | Zeitleiste | Tidslinje | Tidslinje | web app `notifications.title` / `timelineHint` |
| 8k | Dashboards | Dashboards | Dashboards (heading). Body: "instrumentpaneler" | Dashboards | Dashboards | Dashboards (heading). Body: "dashbord" | Dashboards | homey.app section-dashboards (marketing only, not in web app bundles) |
| 8l | Widgets | Widgets | widgetar | widgets | Widgets | kontrollprogrammer | widgets | homey.app section-widgets (marketing only) |
| 8m | Device (Homey tile) | Device(s) | Enhet(er) | Apparaat / Apparaten | Gerät(e) | Enhet(er) | Enhed(er) | web app `navigation.devices` |

Unverified: the Homey **mobile** app strings for Dashboards and Widgets. The web app bundles don't contain them, so those
two rows use homey.app marketing copy, which isn't always identical to the app.

## Cells that differ from plain English

- Smart Price Adaption™, Smart Energy Source™, Smart control, myUplink and SG Ready stay **in English** in all six
  languages. Don't translate them.
- Hot water demand modes are translated, except Smart control: sv Litet/Medel/Stort, nl Klein/Gemiddeld/Groot,
  de **Niedrig/Mittel/Hoch** (not Klein/Groß), no Lite/Middels/Stort, da Lille/Middelstort/Stort.
- Operating modes: "Auto" stays everywhere. Manual is translated (see row 6b). The third mode uses the immersion heater
  word, not NIBE's (see the exception at the top).
- de calls hot water "Brauchwasser" (not Warmwasser) and the curve offset "Parallelverschiebung" (display value) or
  "Kurvenverschiebung" (tip text).
- nl uses "Stooklijn" for the heat curve and "Weg-modus" for Away mode. "ruimtesensor" is the menu term.
- Away mode (4.5) is not Holiday. Holiday is a separate scheduling mode in menu 6: Semester (sv), Vakantie (nl),
  Urlaub (de), Ferie (no, da).
- Homey: Insights is localized in the app in sv (Insikter), nl (Inzichten), de (Einblicke) and no (Innsikter), but
  **da keeps "Insights"**. The Energy tab is localized (Energi/Energie), while "Homey Energy" as a product stays.
  Timeline becomes Tidslinje, Tijdlijn or Zeitleiste. Repair becomes Reparera, Repareren, Reparieren or Reparer.
  "Flow" and "Advanced Flow" are never translated.
