#!/usr/bin/env python3
"""
Holt aktuelle Wirtschaftsdaten und schreibt sie nach data/data.json (Schweiz, Märkte)
und data/intl.json (Ländervergleich).

Läuft automatisch (GitHub Action, täglich) oder manuell:  python3 scripts/fetch_data.py

Quellen: SNB-Datenportal (enthält auch BFS- und SECO-Zahlen), EZB, Eurostat, OECD,
IWF (World Economic Outlook), Our World in Data, Yahoo Finance.

Fällt eine Quelle aus, werden die bisherigen Daten dieser Reihe behalten und der Fehler
vermerkt. Das Dashboard zeigt dann eine Warnung an. Nur Python-Standardbibliothek.
"""
import csv
import hashlib
import io
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_CH = ROOT / "data" / "data.json"
OUT_INTL = ROOT / "data" / "intl.json"
UA = {"User-Agent": "Mozilla/5.0 (compatible; wirtschaftsdashboard/1.0)", "Accept": "*/*"}
YEAR = datetime.now().year

# ---------------------------------------------------------------------------
# Schweiz: SNB-Datenportal (data.snb.ch)
# id: (cube, dimSel, fromDate, Titel, Einheit, Frequenz, Quelle)
# ---------------------------------------------------------------------------
SNB = {
    "cpi_index":   ("plkopr", "D0(LD2010100)", None, "Landesindex der Konsumentenpreise (LIK)", "Index Dez. 2025 = 100", "M", "BFS via SNB"),
    "cpi_yoy":     ("plkopr", "D0(VVP)", None, "Teuerung gegenüber Vorjahresmonat (LIK)", "%", "M", "BFS via SNB"),
    "unemp_sa":    ("amarbma", "D0(S1)", None, "Arbeitslosenquote (saisonbereinigt)", "%", "M", "SECO via SNB"),
    "unemp":       ("amarbma", "D0(T1)", None, "Arbeitslosenquote (nicht bereinigt)", "%", "M", "SECO via SNB"),
    "unemp_count": ("amarbma", "D0(T0)", None, "Registrierte Arbeitslose", "Personen", "M", "SECO via SNB"),
    "vacancies":   ("amarbma", "D0(S2)", None, "Gemeldete offene Stellen (saisonbereinigt)", "Stellen", "M", "SECO via SNB"),
    "shorttime":   ("amarbma", "D0(K)", None, "Kurzarbeitende", "Personen", "M", "SECO via SNB"),
    "gdp_level":   ("gdpap", "D0(WMF),D1(BBIPS)", None, "Reales BIP pro Quartal (sportevent-bereinigt)", "Mio. CHF", "Q", "SECO via SNB"),
    "gdp_qoq":     ("gdpap", "D0(VVP),D1(BBIPS)", None, "Reales BIP-Wachstum gegenüber Vorquartal", "%", "Q", "SECO via SNB"),
    "cons_qoq":    ("gdpap", "D0(VVP),D1(PHPOE)", None, "Privater Konsum gegenüber Vorquartal", "%", "Q", "SECO via SNB"),
    "inv_qoq":     ("gdpap", "D0(VVP),D1(T1)", None, "Bruttoanlageinvestitionen gegenüber Vorquartal", "%", "Q", "SECO via SNB"),
    "exp_qoq":     ("gdpap", "D0(VVP),D1(T3S)", None, "Exporte gegenüber Vorquartal", "%", "Q", "SECO via SNB"),
    "policy_rate": ("snbgwdzid", "D0(LZ)", "2000-01-01", "SNB-Leitzins", "%", "D", "SNB"),
    "saron":       ("snbgwdzid", "D0(SARON)", "2000-01-01", "SARON (Referenzzins Geldmarkt)", "%", "D", "SNB"),
    "bond10":      ("rendoblid", "D0(10J0)", "1988-01-01", "Rendite 10-jährige Bundesobligationen", "%", "D", "SNB"),
    "eurchf_m":    ("devkum", "D0(M0),D1(EUR1)", None, "EUR/CHF (Monatsmittel)", "CHF je EUR", "M", "SNB"),
    "usdchf_m":    ("devkum", "D0(M0),D1(USD1)", None, "USD/CHF (Monatsmittel)", "CHF je USD", "M", "SNB"),
    "gbpchf_m":    ("devkum", "D0(M0),D1(GBP1)", None, "GBP/CHF (Monatsmittel)", "CHF je GBP", "M", "SNB"),
    "jpychf_m":    ("devkum", "D0(M0),D1(JPY100)", None, "JPY/CHF (Monatsmittel)", "CHF je 100 JPY", "M", "SNB"),
    "m1":          ("snbmonagg", "D0(B),D1(GM1)", None, "Geldmenge M1", "Mio. CHF", "M", "SNB"),
    "m2":          ("snbmonagg", "D0(B),D1(GM2)", None, "Geldmenge M2", "Mio. CHF", "M", "SNB"),
    "m3":          ("snbmonagg", "D0(B),D1(GM3)", None, "Geldmenge M3", "Mio. CHF", "M", "SNB"),
    "cash":        ("snbmonagg", "D0(B),D1(B)", None, "Bargeldumlauf", "Mio. CHF", "M", "SNB"),
    "m1_yoy":      ("snbmonagg", "D0(VV),D1(GM1)", None, "Geldmenge M1, Veränderung gegenüber Vorjahr", "%", "M", "SNB"),
    "m3_yoy":      ("snbmonagg", "D0(VV),D1(GM3)", None, "Geldmenge M3, Veränderung gegenüber Vorjahr", "%", "M", "SNB"),
}

# Finanzmärkte: Yahoo Finance (inoffizielle, aber verbreitete Schnittstelle)
MARKETS = {
    "smi":     ("^SSMI", "SMI (Swiss Market Index)", "Punkte"),
    "spx":     ("^GSPC", "S&P 500 (USA)", "Punkte"),
    "sx5e":    ("^STOXX50E", "Euro Stoxx 50", "Punkte"),
    "gold":    ("GC=F", "Gold", "USD je Unze"),
    "brent":   ("BZ=F", "Erdöl (Brent)", "USD je Fass"),
}

# Monatliche Inflation im Vergleich: Eurostat HVPI (harmonisiert) + OECD für Nicht-EU-Raum
HICP_GEO = {"CH": "CHE", "DE": "DEU", "FR": "FRA", "IT": "ITA", "AT": "AUT", "NL": "NLD",
            "ES": "ESP", "SE": "SWE", "NO": "NOR", "DK": "DNK", "BE": "BEL", "PL": "POL",
            "IE": "IRL", "PT": "PRT", "GR": "GRC", "HU": "HUN", "TR": "TUR",
            "EA20": "EA20", "EU27_2020": "EU27"}
OECD_CPI = ["USA", "GBR", "CAN", "KOR", "AUS"]

# IWF World Economic Outlook (jährlich, inkl. Prognosen), alle Länder
IMF = {
    "PCPIPCH":     ("Inflation (Jahresdurchschnitt)", "%"),
    "NGDP_RPCH":   ("Reales BIP-Wachstum", "%"),
    "NGDPDPC":     ("BIP pro Kopf (nominal)", "USD"),
    "PPPPC":       ("BIP pro Kopf (Kaufkraftparität)", "internat. $"),
    "NGDPD":       ("BIP (nominal)", "Mrd. USD"),
    "LUR":         ("Arbeitslosenquote", "%"),
    "GGXWDG_NGDP": ("Staatsverschuldung", "% des BIP"),
    "BCA_NGDPD":   ("Leistungsbilanzsaldo", "% des BIP"),
    "LP":          ("Bevölkerung", "Mio."),
}

# Our World in Data: CO2
OWID = {
    "co2_pc":    ("co-emissions-per-capita", "CO₂-Emissionen pro Kopf", "t CO₂"),
    "co2_total": ("annual-co2-emissions-per-country", "CO₂-Emissionen total", "t CO₂"),
}

EXTRA_NAMES = {"EA20": "Euroraum", "EU27": "EU (27)", "WLD": "Welt", "UVK": "Kosovo"}


def get(url, timeout=60, tries=3):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(3 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def load(path):
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


# ------------------------------- Abrufe -----------------------------------
def fetch_snb(cube, dimsel, from_date):
    url = (f"https://data.snb.ch/api/cube/{cube}/data/json/de?dimSel={dimsel}"
           f"&fromDate={from_date or '1900-01'}")
    ts = json.loads(get(url))["timeseries"]
    vals = [[v["date"], round(v["value"], 6)] for v in ts[0]["values"] if v.get("value") is not None] if ts else []
    if not vals:
        raise RuntimeError("keine Werte")
    return vals, f"https://data.snb.ch/de/topics/uvo/cube/{cube}"


def fetch_ecb_fx():
    url = ("https://data-api.ecb.europa.eu/service/data/EXR/D.CHF+USD.EUR.SP00.A"
           f"?startPeriod={YEAR - 3}-01-01&format=csvdata")
    by = {"CHF": {}, "USD": {}}
    for r in csv.DictReader(io.StringIO(get(url, timeout=90))):
        if r.get("OBS_VALUE"):
            by[r["CURRENCY"]][r["TIME_PERIOD"]] = float(r["OBS_VALUE"])
    eur = sorted(by["CHF"].items())
    if not eur:
        raise RuntimeError("keine Werte")
    usd = [[d, round(v / by["USD"][d], 5)] for d, v in eur if d in by["USD"]]
    return [[d, v] for d, v in eur], usd


def fetch_yahoo(symbol, rng, interval):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.request.quote(symbol)}"
           f"?range={rng}&interval={interval}")
    res = json.loads(get(url))["chart"]["result"][0]
    ts = res.get("timestamp") or []
    close = res["indicators"]["quote"][0]["close"]
    fmt = "%Y-%m" if interval == "1mo" else "%Y-%m-%d"
    out = {}
    for t, c in zip(ts, close):
        if c is not None:
            out[datetime.fromtimestamp(t, timezone.utc).strftime(fmt)] = round(c, 2)
    if not out:
        raise RuntimeError("keine Werte")
    return sorted([k, v] for k, v in out.items())


def fetch_hicp():
    geos = "".join(f"&geo={g}" for g in HICP_GEO)
    url = ("https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_minr"
           f"?unit=RCH_A&coicop18=TOTAL{geos}")
    j = json.loads(get(url, timeout=120))
    gi = j["dimension"]["geo"]["category"]["index"]
    ti = j["dimension"]["time"]["category"]["index"]
    nt = len(ti)
    times = sorted(ti, key=ti.get)
    out = {}
    for k, v in j["value"].items():
        k = int(k)
        g = [g for g, i in gi.items() if i == k // nt][0]
        out.setdefault(HICP_GEO[g], []).append([times[k % nt], v])
    for k in out:
        out[k].sort()
    if "CHE" not in out:
        raise RuntimeError("Schweiz fehlt")
    return out


def fetch_oecd_cpi():
    url = ("https://sdmx.oecd.org/public/rest/data/OECD.SDD.TPS,DSD_PRICES@DF_PRICES_ALL,1.0/"
           f"{'+'.join(OECD_CPI)}.M.N.CPI.PA._T.N.GY?startPeriod=1996-01&format=csvfile")
    out = {}
    for r in csv.DictReader(io.StringIO(get(url, timeout=120))):
        if r.get("OBS_VALUE"):
            out.setdefault(r["REF_AREA"], {})[r["TIME_PERIOD"]] = round(float(r["OBS_VALUE"]), 2)
    return {k: sorted([d, v] for d, v in s.items()) for k, s in out.items()}


def fetch_imf_countries():
    js = json.loads(get("https://www.imf.org/external/datamapper/api/v1/countries", timeout=60))
    return {k: v.get("label") for k, v in js["countries"].items() if v.get("label")}


def fetch_imf(indicator, valid):
    js = json.loads(get(f"https://www.imf.org/external/datamapper/api/v1/{indicator}", timeout=120))
    allc = js["values"][indicator]
    out = {iso: sorted([y, round(v, 3)] for y, v in s.items() if v is not None)
           for iso, s in allc.items() if iso in valid}
    if "CHE" not in out:
        raise RuntimeError("Schweiz fehlt")
    return out


def fetch_owid(slug):
    url = f"https://ourworldindata.org/grapher/{slug}.csv?v=1&csvType=full&useColumnShortNames=true"
    rows = csv.reader(io.StringIO(get(url, timeout=120)))
    next(rows)
    out = {}
    for r in rows:
        code, year, val = r[1], r[2], r[3]
        if not val or not code:
            continue
        if code == "OWID_WRL":
            code = "WLD"
        elif code.startswith("OWID"):
            continue
        out.setdefault(code, []).append([year, round(float(val), 3)])
    if "CHE" not in out:
        raise RuntimeError("Schweiz fehlt")
    return out


def fetch_german_names():
    js = json.loads(get("https://raw.githubusercontent.com/mledoze/countries/master/countries.json"))
    return {c["cca3"]: c["translations"]["deu"]["common"] for c in js if "deu" in c.get("translations", {})}


# ------------------------------- Ablauf -----------------------------------
def fingerprint(payload):
    """Kennung des aktuellen Inhalts: bei Zeitreihen der neuste Wert, bei Länderdaten ein Hash."""
    if "data" in payload:
        return json.dumps(payload["data"][-1]) if payload["data"] else ""
    return hashlib.sha1(json.dumps(payload.get("countries"), sort_keys=True).encode()).hexdigest()


class Collector:
    def __init__(self, old):
        self.old = old
        self.new = {}
        self.errors = []
        self.ok = 0

    def run(self, key, fn, meta):
        try:
            payload = fn()
            # Seit wann gibt es den aktuellen Wert? Nur ändern, wenn die Quelle etwas Neues liefert.
            old = self.old.get(key, {})
            fp = fingerprint(payload)
            if old.get("fp") == fp:
                changed = old.get("changed")
            elif "fp" not in old:
                changed = None  # erster Lauf mit dieser Funktion: Zeitpunkt unbekannt
            else:
                changed = now_iso()
            self.new[key] = {**meta, "fetched": now_iso(), "fp": fp, "changed": changed, **payload}
            self.ok += 1
            print(f"OK   {key}")
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"{key}: {e}")
            print(f"FAIL {key}: {e}", file=sys.stderr)
            if key in self.old:
                self.new[key] = {**self.old[key], "error": str(e)}


def main():
    old_ch, old_intl = load(OUT_CH), load(OUT_INTL)

    # --- Schweiz & Märkte ---
    ch = Collector(old_ch.get("series", {}))
    for sid, (cube, dimsel, frm, title, unit, freq, src) in SNB.items():
        ch.run(sid, lambda c=cube, d=dimsel, f=frm: dict(zip(("data", "link"), fetch_snb(c, d, f))),
               {"title": title, "unit": unit, "freq": freq, "source": src})

    fx = {}

    def ecb(which):
        if not fx:
            fx["eur"], fx["usd"] = fetch_ecb_fx()
        return {"data": fx[which], "link": "https://data.ecb.europa.eu/data/datasets/EXR"}
    ch.run("eurchf_d", lambda: ecb("eur"), {"title": "EUR/CHF (täglich)", "unit": "CHF je EUR", "freq": "D", "source": "EZB-Referenzkurs"})
    ch.run("usdchf_d", lambda: ecb("usd"), {"title": "USD/CHF (täglich)", "unit": "CHF je USD", "freq": "D", "source": "EZB-Referenzkurs"})

    for mid, (sym, title, unit) in MARKETS.items():
        link = f"https://finance.yahoo.com/quote/{urllib.request.quote(sym)}/"
        ch.run(mid, lambda s=sym: {"data": fetch_yahoo(s, "max", "1mo"), "link": link},
               {"title": title + " (Monatsende)", "unit": unit, "freq": "M", "source": "Yahoo Finance"})
        ch.run(mid + "_d", lambda s=sym: {"data": fetch_yahoo(s, "2y", "1d"), "link": link},
               {"title": title + " (täglich)", "unit": unit, "freq": "D", "source": "Yahoo Finance"})

    # --- International ---
    intl = Collector(old_intl.get("datasets", {}))
    intl.run("hicp", lambda: {"countries": fetch_hicp(), "link": "https://ec.europa.eu/eurostat/databrowser/view/prc_hicp_minr/default/table"},
             {"title": "Inflation (HVPI, harmonisiert) gegenüber Vorjahresmonat", "unit": "%", "freq": "M", "source": "Eurostat"})
    intl.run("oecd_cpi", lambda: {"countries": fetch_oecd_cpi(), "link": "https://data-explorer.oecd.org/"},
             {"title": "Inflation (nationaler KPI) gegenüber Vorjahresmonat", "unit": "%", "freq": "M", "source": "OECD"})

    try:
        imf_names = fetch_imf_countries()
    except Exception as e:  # noqa: BLE001
        imf_names = old_intl.get("imf_names", {})
        intl.errors.append(f"imf_countries: {e}")
    for ind, (title, unit) in IMF.items():
        intl.run(f"imf_{ind}", lambda i=ind: {"countries": fetch_imf(i, imf_names),
                                              "link": f"https://www.imf.org/external/datamapper/{i}"},
                 {"title": title, "unit": unit, "freq": "A", "source": "IWF (World Economic Outlook)",
                  "forecastFrom": YEAR})
    for key, (slug, title, unit) in OWID.items():
        intl.run(key, lambda s=slug: {"countries": fetch_owid(s), "link": f"https://ourworldindata.org/grapher/{s}"},
                 {"title": title, "unit": unit, "freq": "A", "source": "Our World in Data / Global Carbon Project"})

    try:
        names = fetch_german_names()
    except Exception as e:  # noqa: BLE001
        names = old_intl.get("names", {})
        intl.errors.append(f"names: {e}")
    for k, v in imf_names.items():
        names.setdefault(k, v)
    names.update(EXTRA_NAMES)

    if ch.ok + intl.ok == 0:
        print("Keine Quelle erreichbar – Dateien bleiben unverändert.", file=sys.stderr)
        sys.exit(1)

    OUT_CH.parent.mkdir(parents=True, exist_ok=True)
    OUT_CH.write_text(json.dumps({"generated": now_iso(), "trackedSince": old_ch.get("trackedSince") or now_iso(),
                                  "series": ch.new, "errors": ch.errors},
                                 ensure_ascii=False, separators=(",", ":")), "utf-8")
    OUT_INTL.write_text(json.dumps({"generated": now_iso(), "trackedSince": old_intl.get("trackedSince") or now_iso(),
                                    "names": names, "imf_names": imf_names,
                                    "datasets": intl.new, "errors": intl.errors},
                                   ensure_ascii=False, separators=(",", ":")), "utf-8")
    for p in (OUT_CH, OUT_INTL):
        print(f"Geschrieben: {p.name} ({p.stat().st_size // 1024} KB)")
    print(f"Fehler: {len(ch.errors) + len(intl.errors)}")


if __name__ == "__main__":
    main()
