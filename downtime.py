#!/usr/bin/python3
"""Ping every place on the downtime list and report which ones are down."""

import ipaddress
import json
import os
import re
import socket
import subprocess
import sys
import threading
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
HOME = Path.home()
DESKTOP_LIST = HOME / "Desktop" / "Full_Downtime_Check_List.txt"
BUNDLED_LIST = ROOT / "places.txt"
WORLD_LIST = HOME / "Desktop" / "world_governments_websites.txt"
BUNDLED_WORLD = ROOT / "world-governments.txt"
INSTITUTIONS_LIST = HOME / "Downloads" / "Top_Global_Institutions_List.txt"
BUNDLED_INSTITUTIONS = ROOT / "institutions.txt"
EXCHANGES_LIST = ROOT / "world-exchanges.txt"
TRANSPORT_LIST = HOME / "Desktop" / "transportation_websites.txt"
BUNDLED_TRANSPORT = ROOT / "transportation.txt"
STORES_LIST = ROOT / "stores.txt"
SERVICES_LIST = ROOT / "service-sites.txt"
COMMUNICATIONS_LIST = ROOT / "communications.txt"
MILITARY_LIST = ROOT / "military.txt"
SHIPPING_LIST = ROOT / "shipping.txt"
FOOD_LIST = ROOT / "food.txt"
WEATHER_LIST = ROOT / "weather.txt"
EXTRA_BANKS_LIST = ROOT / "banks-national.txt"
EXTRA_UTILITIES_LIST = ROOT / "utilities-national.txt"
EXTRA_GOVERNMENT_LIST = ROOT / "government-extra.txt"
SKIP_HOSTS = {"stockanalysis.com", "wikipedia.org", "newsweek.com", "rankings.newsweek.com"}
COUNTRY_LABELS = (
    ("united states", "United States"),
    ("united kingdom", "United Kingdom"),
    ("south korea", "South Korea"),
    ("saudi arabia", "Saudi Arabia"),
    ("hong kong", "Hong Kong"),
    ("south africa", "South Africa"),
    ("sri lanka", "Sri Lanka"),
    ("new zealand", "New Zealand"),
    ("switzerland", "Switzerland"),
    ("netherlands", "Netherlands"),
    ("singapore", "Singapore"),
    ("australia", "Australia"),
    ("germany", "Germany"),
    ("france", "France"),
    ("canada", "Canada"),
    ("china", "China"),
    ("japan", "Japan"),
    ("india", "India"),
    ("brazil", "Brazil"),
    ("spain", "Spain"),
    ("italy", "Italy"),
    ("israel", "Israel"),
    ("sweden", "Sweden"),
    ("denmark", "Denmark"),
    ("austria", "Austria"),
    ("russia", "Russia"),
    ("turkey", "Turkey"),
    ("thailand", "Thailand"),
    ("poland", "Poland"),
    ("taiwan", "Taiwan"),
    ("mexico", "Mexico"),
    ("indonesia", "Indonesia"),
    ("vietnam", "Vietnam"),
    ("bangladesh", "Bangladesh"),
    ("malaysia", "Malaysia"),
    ("philippines", "Philippines"),
    ("pakistan", "Pakistan"),
    ("argentina", "Argentina"),
    ("chile", "Chile"),
    ("peru", "Peru"),
    ("finland", "Finland"),
    ("usa", "United States"),
    ("uk", "United Kingdom"),
    ("us", "United States"),
)
BAR_LINE = re.compile(r"^=+$")
URL_IN_TEXT = re.compile(r"https?://[^\s<>\"')\],;]+", re.I)
BARE_HOST = re.compile(r"\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b", re.I)
LIST_KINDS = {
    "MAJOR NATIONWIDE SERVICES": "tech",
    "MAJOR NATIONWIDE BANKS": "banks",
    "MAIN GOVERNMENT SITES": "government",
    "NE ARKANSAS LOCAL BANKS": "banks",
    "NE ARKANSAS LOCAL UTILITIES": "utilities",
}
SAVED_PATH = ROOT / "added-places.txt"
CACHE_PATH = ROOT / "locations.json"
WORKERS = 24
LOOKUP_WORKERS = 8
PING_WAIT = 2
TCP_WAIT = 3

socket.setdefaulttimeout(TCP_WAIT)


def load_sections(path: Path) -> list[tuple[str, list[dict]]]:
    sections: list[tuple[str, list[dict]]] = []
    title = "Places"
    group: list[dict] = []
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith(("Note:", "Generated:", "- ", "#")):
            continue
        if line.startswith("===") and line.endswith("==="):
            if group:
                sections.append((title, group))
                group = []
            title = line.strip("= ").strip() or "Places"
            # Added places are loaded from the saved file, not this list.
            if title.upper() == "ADDED PLACES":
                title = ""
            continue
        if not title:
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 2 or len(parts) > 3 or not parts[0] or not parts[1]:
            continue
        group.append({"name": parts[0], "address": parts[1]})
    if group and title:
        sections.append((title, group))
    return sections


def parse_saved_line(parts: list[str]) -> dict:
    entry = {"name": parts[0], "address": parts[1].lower()}
    if len(parts) >= 3 and parts[2]:
        entry["location"] = parts[2]
    if len(parts) >= 5:
        try:
            entry["lat"] = float(parts[3])
            entry["lon"] = float(parts[4])
        except ValueError:
            pass
    return entry


def load_saved() -> list[dict]:
    if not SAVED_PATH.is_file():
        return []
    entries: list[dict] = []
    seen: set[str] = set()
    for raw in SAVED_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 2 or not parts[0] or not parts[1]:
            continue
        entry = parse_saved_line(parts)
        if entry["address"] in seen:
            continue
        seen.add(entry["address"])
        entries.append(entry)
    return entries


def saved_line(entry: dict) -> str:
    parts = [entry["name"], entry["address"]]
    location = entry.get("location") or ""
    lat = entry.get("lat")
    lon = entry.get("lon")
    if location or lat is not None:
        parts.append(location)
    if lat is not None and lon is not None:
        parts.append(f"{lat}")
        parts.append(f"{lon}")
    return " | ".join(parts)


def write_saved(entries: list[dict]) -> None:
    lines = [
        "# Places added from the Downtime menu.",
        "# Name | address | location | latitude | longitude",
    ]
    for entry in entries:
        lines.append(saved_line(entry))
    SAVED_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def all_entries(sections: list[tuple[str, list[dict]]]) -> list[dict]:
    return [entry for _, group in sections for entry in group]


def active_list() -> Path | None:
    if DESKTOP_LIST.is_file():
        return DESKTOP_LIST
    if BUNDLED_LIST.is_file():
        return BUNDLED_LIST
    return None


def collect_sections() -> tuple[list[tuple[str, list[dict]]], str | None]:
    error = None
    path = active_list()
    if path is not None:
        sections = load_sections(path)
    else:
        sections = []
        error = "Cannot find the downtime list."
    saved = load_saved()
    if saved:
        sections.append(("ADDED PLACES", saved))
    return sections, error


def color(text: str, code: str) -> str:
    if not code or not sys.stdout.isatty():
        return text
    return f"\033[{code}m{text}\033[0m"


def ask(prompt: str) -> str | None:
    try:
        return input(prompt)
    except EOFError:
        print()
        return None


def normalize_address(raw: str) -> str | None:
    text = raw.strip()
    if not text or "|" in text or any(char.isspace() for char in text):
        return None
    if "://" not in text and "/" in text:
        text = "http://" + text
    if "://" in text:
        host = urlparse(text).hostname
        if not host:
            return None
        text = host
    text = text.lower().rstrip(".")
    if not valid_address(text):
        return None
    return text


def valid_address(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    try:
        host = host.encode("idna").decode("ascii")
    except UnicodeError:
        return False
    if not host or len(host) > 253 or "." not in host:
        return False
    for label in host.split("."):
        if not label or len(label) > 63:
            return False
        if label.startswith("-") or label.endswith("-"):
            return False
        if not all(char.isalnum() or char == "-" for char in label):
            return False
    return True


def find_entry(entries: list[dict], address: str) -> dict | None:
    wanted = address.lower()
    for entry in entries:
        if entry["address"].lower() == wanted:
            return entry
    return None


def is_ipv6(host: str) -> bool:
    try:
        return ipaddress.ip_address(host).version == 6
    except ValueError:
        return False


def is_public(ip: ipaddress._BaseAddress) -> bool:
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


def ping_command(host: str) -> list[str]:
    # Linux ping takes -4/-6 and -W in seconds. macOS ping has no family flag
    # and -W is milliseconds. IPv6 on macOS is ping6.
    wait = str(PING_WAIT * 1000 if sys.platform == "darwin" else PING_WAIT)
    if sys.platform == "darwin":
        binary = "ping6" if is_ipv6(host) else "ping"
        return [binary, "-n", "-c", "1", "-W", wait, host]
    family = "-6" if is_ipv6(host) else "-4"
    return ["ping", family, "-n", "-c", "1", "-W", wait, host]


def answers_ping(host: str) -> bool:
    try:
        result = subprocess.run(
            ping_command(host),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=PING_WAIT + 3,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


def ipv4_addresses(host: str) -> list[str]:
    # getaddrinfo does not honor the socket timeout, so abandon a slow lookup.
    found: list[str] = []

    def resolve() -> None:
        try:
            infos = socket.getaddrinfo(host, None, socket.AF_INET, socket.SOCK_STREAM)
        except OSError:
            return
        for info in infos:
            ip = info[4][0]
            if ip not in found:
                found.append(ip)

    worker = threading.Thread(target=resolve, daemon=True)
    worker.start()
    worker.join(TCP_WAIT)
    return found


def public_ip(host: str) -> str | None:
    try:
        ip = ipaddress.ip_address(host)
        candidates = [ip]
    except ValueError:
        candidates = []
        for raw in ipv4_addresses(host):
            try:
                candidates.append(ipaddress.ip_address(raw))
            except ValueError:
                continue
    for ip in candidates:
        if ip.version == 4 and is_public(ip):
            return str(ip)
    return None


def port_targets(host: str) -> list[str]:
    try:
        ipaddress.ip_address(host)
        return [host]
    except ValueError:
        return ipv4_addresses(host)


def port_open(ip: str, port: int) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=TCP_WAIT):
            return True
    except OSError:
        return False


def check(entry: dict) -> str:
    host = entry["address"]
    if answers_ping(host):
        return "up"
    # Some sites ignore ping while the service itself is up.
    for ip in port_targets(host)[:2]:
        if port_open(ip, 443) or port_open(ip, 80):
            return "up"
    return "down"


def load_cache() -> dict:
    if not CACHE_PATH.is_file():
        return {}
    try:
        data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def write_cache(cache: dict) -> None:
    CACHE_PATH.write_text(json.dumps(cache, indent=2) + "\n", encoding="utf-8")


def format_location(data: dict) -> str:
    city = str(data.get("city") or "").strip()
    region = str(data.get("region") or "").strip()
    postal = str(data.get("postal") or "").strip()
    country = str(data.get("country") or "").strip()
    if city and region:
        place = f"{city}, {region}"
        if postal:
            place = f"{place} {postal}"
        if country:
            place = f"{place}, {country}"
        return place
    return ", ".join(part for part in (city, region, postal, country) if part)


def lookup_ip(ip: str) -> dict | None:
    request = urllib.request.Request(
        f"https://ipwho.is/{ip}",
        headers={"User-Agent": "downtime-check"},
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            data = json.loads(response.read().decode("utf-8", errors="replace"))
    except (OSError, urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return None
    if not isinstance(data, dict) or not data.get("success"):
        return None
    try:
        lat = float(data["latitude"])
        lon = float(data["longitude"])
    except (KeyError, TypeError, ValueError):
        return None
    location = format_location(data)
    if not location:
        return None
    return {
        "location": location,
        "city": str(data.get("city") or "").strip(),
        "region": str(data.get("region") or "").strip(),
        "country": str(data.get("country") or "").strip(),
        "lat": lat,
        "lon": lon,
    }


def locate_host(host: str, cache: dict | None = None) -> dict | None:
    """Find a public location for a domain or IP. Private addresses have none."""
    owned = cache is None
    if cache is None:
        cache = load_cache()
    ip = public_ip(host)
    if ip is None:
        return None
    cached = cache.get(ip)
    if isinstance(cached, dict) and cached.get("location"):
        found = dict(cached)
        found["ip"] = ip
        return found
    found = lookup_ip(ip)
    if found is None:
        return {"ip": ip}
    found["ip"] = ip
    cache[ip] = {
        "location": found["location"],
        "city": found.get("city") or "",
        "region": found.get("region") or "",
        "country": found.get("country") or "",
        "lat": found["lat"],
        "lon": found["lon"],
    }
    if owned:
        write_cache(cache)
    return found


def attach_locations(entries: list[dict]) -> None:
    cache = load_cache()
    pending: list[tuple[dict, str]] = []
    for entry in entries:
        if entry.get("location") and entry.get("lat") is not None and entry.get("lon") is not None:
            ip = public_ip(entry["address"])
            if ip:
                entry["ip"] = ip
                cached = cache.get(ip)
                if isinstance(cached, dict):
                    entry["city"] = cached.get("city") or entry.get("city") or ""
                    entry["region"] = cached.get("region") or entry.get("region") or ""
                    entry["country"] = cached.get("country") or country_from_location(entry.get("location") or "")
            continue
        ip = public_ip(entry["address"])
        if ip is None:
            if entry.get("location"):
                pass
            else:
                try:
                    numeric = ipaddress.ip_address(entry["address"])
                    entry["location"] = "Local network" if not is_public(numeric) else "Location not found"
                except ValueError:
                    entry["location"] = "Location not found"
            continue
        entry["ip"] = ip
        cached = cache.get(ip)
        if isinstance(cached, dict) and cached.get("location"):
            entry["location"] = cached["location"]
            entry["city"] = cached.get("city") or ""
            entry["region"] = cached.get("region") or ""
            entry["country"] = cached.get("country") or country_from_location(entry["location"])
            entry["lat"] = cached.get("lat")
            entry["lon"] = cached.get("lon")
            continue
        pending.append((entry, ip))

    if not pending:
        return

    print(f"Finding locations for {len(pending)} places...")

    def fetch(item: tuple[dict, str]) -> tuple[dict, str, dict | None]:
        entry, ip = item
        return entry, ip, lookup_ip(ip)

    with ThreadPoolExecutor(max_workers=LOOKUP_WORKERS) as pool:
        futures = [pool.submit(fetch, item) for item in pending]
        for future in as_completed(futures):
            entry, ip, found = future.result()
            if found is None:
                entry["location"] = entry.get("location") or "Location not found"
                continue
            entry.update(found)
            entry["ip"] = ip
            cache[ip] = {
                "location": found["location"],
                "city": found.get("city") or "",
                "region": found.get("region") or "",
                "country": found.get("country") or "",
                "lat": found["lat"],
                "lon": found["lon"],
            }
    write_cache(cache)


def checked_address(entry: dict) -> str:
    host = entry["address"]
    ip = entry.get("ip")
    if ip and ip != host:
        return f"{host} ({ip})"
    return host


def remember_added_locations(entries: list[dict]) -> None:
    saved = load_saved()
    if not saved:
        return
    by_address = {entry["address"].lower(): entry for entry in entries}
    changed = False
    for entry in saved:
        current = by_address.get(entry["address"].lower())
        if current is None:
            continue
        for key in ("location", "lat", "lon"):
            if current.get(key) not in (None, "", "Location not found", "Local network") and entry.get(key) != current.get(key):
                entry[key] = current[key]
                changed = True
    if changed:
        write_saved(saved)


def run_check(sections: list[tuple[str, list[dict]]], heading: str = "Downtime check") -> int:
    entries = all_entries(sections)
    if not entries:
        print("No places to check.")
        return 2

    total = len(entries)
    added = len(next((group for title, group in sections if title == "ADDED PLACES"), []))
    print()
    print(heading)
    print(f"{total} places")
    if added:
        print(f"{added} added {'place is' if added == 1 else 'places are'} included.")
    print("A place is up when it answers ping. If ping is silent, HTTPS is tried next.")
    print("Each place is listed as soon as it answers.")
    print()

    done = 0
    lock = threading.Lock()
    name_width = max(len(entry["name"]) for entry in entries)
    address_width = max(len(entry["address"]) for entry in entries)

    def run(entry: dict) -> None:
        nonlocal done
        entry["status"] = check(entry)
        with lock:
            done += 1
            print(f"{done}/{total}  {place_line(entry, name_width, address_width)}", flush=True)

    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = [pool.submit(run, entry) for entry in entries]
        for future in as_completed(futures):
            future.result()

    print()
    try:
        attach_locations(entries)
    except KeyboardInterrupt:
        print("\nStopped looking up locations.")
    remember_added_locations(entries)

    down = [entry for entry in entries if entry["status"] == "down"]
    up_count = total - len(down)
    address_width = max(len(checked_address(entry)) for entry in entries)

    print("Places that are down")
    print("--------------------")
    if not down:
        print("None. Every place answered.")
    else:
        for entry in down:
            print(place_line(entry, name_width, address_width))
    print(f"{up_count} up, {len(down)} down, {total} checked.")
    print()
    print("Results by country")
    print_places_by_location(entries, name_width, address_width)

    print_search_places(entries)
    print()
    return 0


def place_line(entry: dict, name_width: int, address_width: int) -> str:
    if entry.get("status") == "up":
        label = color("UP  ", "32")
    else:
        label = color("DOWN", "1;31")
    location = entry.get("location") or ""
    return (
        f"  {label}  {entry['name']:<{name_width}}    "
        f"{checked_address(entry):<{address_width}}    {location}"
    )


def country_from_location(location: str) -> str:
    if not location or location in {"Local network", "Location not found"} or "," not in location:
        return ""
    return location.rsplit(",", 1)[-1].strip()


def region_from_location(location: str) -> str:
    """State or region from a saved line like 'City, California 94119, United States'."""
    if not location or location in {"Local network", "Location not found"}:
        return ""
    parts = [part.strip() for part in location.split(",") if part.strip()]
    if len(parts) < 3:
        return ""
    tokens = parts[-2].split()
    while tokens and any(char.isdigit() for char in tokens[-1]):
        tokens.pop()
    return " ".join(tokens)


def country_of(entry: dict) -> str:
    country = (entry.get("country") or "").strip()
    if country:
        return country
    return country_from_location(entry.get("location") or "")


def display_country(entry: dict) -> str:
    location = (entry.get("location") or "").strip()
    if location == "Local network":
        return "Local network"
    if not location or location == "Location not found":
        return "Location not found"
    return (entry.get("country") or "").strip() or country_from_location(location) or "Location not found"


def display_state(entry: dict) -> str:
    if display_country(entry) in {"Location not found", "Local network"}:
        return ""
    region = (entry.get("region") or "").strip() or region_from_location(entry.get("location") or "")
    return region or "Unknown"


def term_columns() -> int:
    try:
        return max(40, os.get_terminal_size().columns)
    except OSError:
        return 120


def ascii_fold(text: str) -> str:
    folded = unicodedata.normalize("NFKD", text)
    return "".join(char for char in folded if not unicodedata.combining(char))


def print_big(text: str) -> None:
    """Country name, drawn larger than the result lines."""
    folded = ascii_fold(text)
    try:
        rendered = subprocess.run(
            ["figlet", "-f", "small", "-w", "400", folded],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        rendered = ""
    lines = [line.rstrip() for line in rendered.splitlines() if line.strip()]
    # A wrapped banner is harder to read than the name itself.
    if lines and all(len(line) <= term_columns() for line in lines):
        for line in lines:
            print(color(line, "1;97"))
        if folded != text:
            print(color(text, "1;97"))
        return
    print(color(text, "1;97"))


def location_sort_key(name: str) -> tuple:
    if name in {"Location not found", "Local network"}:
        return (1, name.lower())
    return (0, name.lower())


def print_places_by_location(entries: list[dict], name_width: int, address_width: int) -> None:
    grouped: dict[str, dict[str, list[dict]]] = {}
    for entry in entries:
        country = display_country(entry)
        state = display_state(entry)
        grouped.setdefault(country, {}).setdefault(state, []).append(entry)

    first_country = True
    for country in sorted(grouped, key=location_sort_key):
        if not first_country:
            print()
            print()
        first_country = False
        print()
        print_big(country)
        print()
        states = grouped[country]
        state_names = sorted(states, key=lambda name: (name == "Unknown", name.lower()))
        for index, state in enumerate(state_names):
            if index:
                print()
            if state:
                print(color(f"{state}", "1"))
            for entry in sorted(states[state], key=lambda item: item["name"].lower()):
                print(place_line(entry, name_width, address_width))


def unique_names(names: list[str]) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    for name in names:
        name = name.strip()
        key = name.lower()
        if not name or key in seen:
            continue
        seen.add(key)
        found.append(name)
    return sorted(found, key=str.lower)


def print_name_list(title: str, names: list[str]) -> None:
    print(title)
    if not names:
        print("  None")
        return
    for name in names:
        print(f"  {name}")


def print_search_places(entries: list[dict]) -> None:
    online = sum(1 for entry in entries if entry.get("status") == "up")
    offline = sum(1 for entry in entries if entry.get("status") == "down")
    print("This search")
    print(f"{len(entries)} checked, {online} online, {offline} offline")
    print()
    print_name_list("Countries", unique_names([country_of(entry) for entry in entries]))


def pretty_country(title: str) -> str:
    title = " ".join(title.split())
    if title.upper() == "UNITED STATES OF AMERICA":
        return "United States"
    head, sep, tail = title.partition("(")
    if head.strip().upper() == "NATO":
        return "NATO" + (f" ({tail}" if sep else "")
    if head.isupper() and head.strip():
        titled = head.title()
        return f"{titled}{sep}{tail}" if sep else titled.strip()
    if title.isupper():
        return title.title()
    return title


def world_path() -> Path | None:
    if WORLD_LIST.is_file():
        return WORLD_LIST
    if BUNDLED_WORLD.is_file():
        return BUNDLED_WORLD
    return None


def hosts_in_text(text: str) -> list[str]:
    hosts: list[str] = []
    for url in URL_IN_TEXT.findall(text):
        host = urlparse(url).hostname
        if not host:
            continue
        host = host.lower().rstrip(".")
        if host not in hosts and valid_address(host):
            hosts.append(host)
    leftover = URL_IN_TEXT.sub(" ", text)
    for token in BARE_HOST.findall(leftover):
        host = token.lower().rstrip(".")
        if host in hosts or not valid_address(host):
            continue
        hosts.append(host)
    return hosts


def government_entries(line: str, country: str) -> list[dict]:
    hosts = hosts_in_text(line)
    if not hosts:
        return []
    label = line.lstrip("- ").strip()
    if ":" in label:
        label = label.split(":", 1)[0].strip()
    if not label:
        label = country
    kinds = ["government"]
    lowered = label.lower()
    if "bank" in lowered or "reserve" in lowered:
        kinds.append("banks")
    entries = []
    for index, host in enumerate(hosts):
        name = label if index == 0 else f"{label} ({host})"
        entries.append({
            "name": name,
            "address": host,
            "country": country,
            "kinds": kinds,
            "source": "world",
        })
    return entries


def load_world() -> list[tuple[str, list[dict]]]:
    path = world_path()
    if path is None:
        return []
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    sections: list[tuple[str, list[dict]]] = []
    current = ""
    group: list[dict] = []
    seen: set[str] = set()
    index = 0

    def flush() -> None:
        nonlocal group
        if current and current not in {"SKIP", "ADDITIONAL"} and group:
            sections.append((current, group))
        group = []

    while index < len(lines):
        line = lines[index].strip()
        index += 1
        if not line:
            continue
        if BAR_LINE.match(line):
            look = index
            while look < len(lines) and not lines[look].strip():
                look += 1
            if look >= len(lines) or BAR_LINE.match(lines[look].strip()):
                continue
            title = lines[look].strip()
            look += 1
            while look < len(lines) and not lines[look].strip():
                look += 1
            if look >= len(lines) or not BAR_LINE.match(lines[look].strip()):
                continue
            index = look + 1
            flush()
            seen = set()
            if title.upper().startswith("NOTE"):
                current = "SKIP"
            elif title.upper().startswith("ADDITIONAL COUNTRIES"):
                current = "ADDITIONAL"
            else:
                current = pretty_country(title)
            continue
        if current in {"", "SKIP"}:
            continue
        if current == "ADDITIONAL":
            label = line.split(":", 1)[0].strip() if ":" in line else line
            made = government_entries(line, pretty_country(label) if label else "Unknown")
            if made:
                sections.append((made[0]["country"], made))
            continue
        for entry in government_entries(line, current):
            if entry["address"] in seen:
                continue
            seen.add(entry["address"])
            group.append(entry)
    flush()
    return sections


def institutions_path() -> Path | None:
    if INSTITUTIONS_LIST.is_file():
        return INSTITUTIONS_LIST
    if BUNDLED_INSTITUTIONS.is_file():
        return BUNDLED_INSTITUTIONS
    return None


def country_in_text(text: str) -> str:
    lowered = text.lower()
    for needle, label in COUNTRY_LABELS:
        if re.search(rf"\b{re.escape(needle)}\b", lowered):
            return label
    return ""


def institution_entries(line: str, kind: str) -> list[dict]:
    hosts = [host for host in hosts_in_text(line) if host not in SKIP_HOSTS and not host.endswith(".example")]
    if not hosts:
        return []
    pieces = [piece.strip() for piece in line.split(" - ") if piece.strip()]
    domain_at = 0
    for index, piece in enumerate(pieces):
        if any(host in piece.lower() for host in hosts):
            domain_at = index
            break
    name = " - ".join(pieces[:domain_at]) if domain_at else pieces[0]
    name = re.sub(r"^\d+\.\s*", "", name)
    name = re.sub(r"^-\s*", "", name).strip(" -")
    if not name:
        name = hosts[0]
    country = country_in_text(line)
    entries = []
    for index, host in enumerate(hosts):
        item_name = name if index == 0 else f"{name} ({host})"
        entries.append({
            "name": item_name,
            "address": host,
            "country": country,
            "kinds": [kind],
            "source": "institutions",
        })
    return entries


def load_institutions() -> list[tuple[str, list[dict]]]:
    path = institutions_path()
    if path is None:
        return []
    kind = ""
    title = ""
    group: list[dict] = []
    sections: list[tuple[str, list[dict]]] = []
    seen: set[str] = set()

    def flush() -> None:
        nonlocal group
        if title and group:
            sections.append((title, group))
        group = []

    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line:
            continue
        upper = line.upper()
        if upper.startswith("SECTION 1"):
            flush()
            kind, title = "exchanges", "STOCK EXCHANGES"
            continue
        if upper.startswith("SECTION 2"):
            flush()
            kind, title = "banks", "BANKS"
            continue
        if upper.startswith("SECTION 3"):
            flush()
            kind, title = "education", "EDUCATION"
            continue
        if upper.startswith("SECTION 4"):
            flush()
            kind, title = "medical", "HOSPITALS"
            continue
        if upper.startswith("B. TOP PHARMACEUTICAL"):
            flush()
            kind, title = "medical", "PHARMACEUTICALS"
            continue
        if not kind:
            continue
        # Numbered rows and dash rows are the list. Notes and "continuing" lines are not.
        if not re.match(r"^(?:\d+\.|-)\s+", line):
            continue
        for entry in institution_entries(line, kind):
            if entry["address"] in seen:
                continue
            seen.add(entry["address"])
            group.append(entry)
    flush()
    return sections


def catalog_host(text: str) -> str:
    text = text.strip().lower()
    if "://" in text:
        host = urlparse(text).hostname or ""
        text = host
    return text.rstrip(".")


def load_catalog(path: Path, kind: str, source: str, title: str) -> list[tuple[str, list[dict]]]:
    """Read Name | website | country lines. A sample IP after the country is ignored."""
    if not path.is_file():
        return []
    group = []
    seen: set[str] = set()
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 2 or not parts[0]:
            continue
        host = catalog_host(parts[1])
        if not host or host in seen or not valid_address(host):
            continue
        seen.add(host)
        group.append({
            "name": parts[0],
            "address": host,
            "country": parts[2] if len(parts) > 2 else "",
            "kinds": [kind],
            "source": source,
        })
    if not group:
        return []
    return [(title, group)]


def transportation_path() -> Path | None:
    if TRANSPORT_LIST.is_file():
        return TRANSPORT_LIST
    if BUNDLED_TRANSPORT.is_file():
        return BUNDLED_TRANSPORT
    return None


def load_transportation() -> list[tuple[str, list[dict]]]:
    path = transportation_path()
    if path is None:
        return []
    country = ""
    buckets: dict[str, list[dict]] = {}
    seen: set[str] = set()
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("===") and line.endswith("==="):
            country = line.strip("= ").strip()
            continue
        parts = [part.strip() for part in line.split("|")]
        if len(parts) < 4 or not country:
            continue
        kind_label, name, _city, website = parts[:4]
        host = catalog_host(website)
        if not host or host in seen or not valid_address(host):
            continue
        seen.add(host)
        label = f"{name} ({kind_label})" if kind_label else name
        buckets.setdefault(country, []).append({
            "name": label,
            "address": host,
            "country": country,
            "kinds": ["transportation"],
            "source": "transportation",
        })
    return [(name, group) for name, group in buckets.items() if group]


def load_groups(home: list[tuple[str, list[dict]]], world: list[tuple[str, list[dict]]]) -> dict:
    institutions = merge_sections(
        load_institutions(),
        load_catalog(EXCHANGES_LIST, "exchanges", "exchanges", "STOCK EXCHANGES"),
    )
    return {
        "home": home,
        "world": world,
        "institutions": institutions,
        "services": load_catalog(SERVICES_LIST, "tech", "services", "TECH SERVICES"),
        "transport": load_transportation(),
        "stores": load_catalog(STORES_LIST, "stores", "stores", "STORES"),
        "communications": load_catalog(COMMUNICATIONS_LIST, "communications", "communications", "COMMUNICATIONS"),
        "military": load_catalog(MILITARY_LIST, "military", "military", "MILITARY"),
        "shipping": load_catalog(SHIPPING_LIST, "shipping", "shipping", "SHIPPING"),
        "food": load_catalog(FOOD_LIST, "food", "food", "FOOD"),
        "weather": load_catalog(WEATHER_LIST, "weather", "weather", "WEATHER"),
        "extra_banks": load_catalog(EXTRA_BANKS_LIST, "banks", "banks", "BANKS"),
        "extra_utilities": load_catalog(EXTRA_UTILITIES_LIST, "utilities", "utilities", "UTILITIES"),
        "extra_government": load_catalog(EXTRA_GOVERNMENT_LIST, "government", "government", "GOVERNMENT"),
    }


def merged(groups: dict, *keys: str) -> list[tuple[str, list[dict]]]:
    return merge_sections(*(groups[key] for key in keys))


def of_kinds(sections: list[tuple[str, list[dict]]], *kinds: str) -> list[tuple[str, list[dict]]]:
    return filter_sections(sections, lambda entry: any(has_kind(entry, kind) for kind in kinds))


def tag_list(sections: list[tuple[str, list[dict]]]) -> None:
    for title, group in sections:
        kind = LIST_KINDS.get(title.upper())
        for entry in group:
            if title == "ADDED PLACES":
                entry["kinds"] = ["added"]
                entry["source"] = "added"
            else:
                entry["kinds"] = [kind or "added"]
                entry["source"] = "list"
                entry["country"] = "United States"


def keep_new(entries: list[dict], seen: set[str]) -> list[dict]:
    kept = []
    for entry in entries:
        key = entry["address"].lower()
        if key in seen:
            continue
        seen.add(key)
        kept.append(entry)
    return kept


def merge_sections(*groups: list[tuple[str, list[dict]]]) -> list[tuple[str, list[dict]]]:
    seen: set[str] = set()
    merged: list[tuple[str, list[dict]]] = []
    for sections in groups:
        for title, group in sections:
            kept = keep_new(group, seen)
            if kept:
                merged.append((title, kept))
    return merged


def filter_sections(sections: list[tuple[str, list[dict]]], predicate) -> list[tuple[str, list[dict]]]:
    chosen = []
    for title, group in sections:
        kept = [entry for entry in group if predicate(entry)]
        if kept:
            chosen.append((title, kept))
    return chosen


def has_kind(entry: dict, kind: str) -> bool:
    return kind in entry.get("kinds", [])


def choose_number(highest: int) -> int | None:
    while True:
        raw = ask("Choice: ")
        if raw is None:
            return None
        raw = raw.strip().lower()
        if raw in {"0", "b", "back"}:
            return 0
        if raw.isdigit() and 1 <= int(raw) <= highest:
            return int(raw)
        print(f"Enter a number from 1 to {highest}, or 0.")


def is_united_states(entry: dict) -> bool:
    return entry.get("country") == "United States"


def show_menu(title: str, choices: list[tuple[str, object]], back_label: str) -> None:
    while True:
        print()
        print(title)
        print()
        for number, (label, _action) in enumerate(choices, start=1):
            print(f"{number:2}  {label}")
        print(f" 0  {back_label}")
        print()
        choice = choose_number(len(choices))
        if choice is None or choice == 0:
            return
        choices[choice - 1][1]()


def everything(groups: dict) -> list[tuple[str, list[dict]]]:
    return merged(
        groups,
        "home",
        "world",
        "institutions",
        "services",
        "transport",
        "stores",
        "communications",
        "military",
        "shipping",
        "food",
        "weather",
        "extra_banks",
        "extra_utilities",
        "extra_government",
    )


def banks_and_exchanges(groups: dict) -> list[tuple[str, list[dict]]]:
    return of_kinds(merged(groups, "home", "world", "institutions", "extra_banks"), "banks", "exchanges")


def tech_sites(groups: dict) -> list[tuple[str, list[dict]]]:
    return of_kinds(merged(groups, "home", "services"), "tech")


def utility_sites(groups: dict) -> list[tuple[str, list[dict]]]:
    return of_kinds(merged(groups, "home", "extra_utilities"), "utilities")


def government_sites(groups: dict) -> list[tuple[str, list[dict]]]:
    return of_kinds(merged(groups, "home", "world", "extra_government"), "government")


def united_states_only(sections: list[tuple[str, list[dict]]]) -> list[tuple[str, list[dict]]]:
    return filter_sections(sections, is_united_states)


def united_states_menu(groups: dict) -> None:
    choices = [
        ("Everything in the United States", lambda: run_check(united_states_only(everything(groups)), "United States")),
        ("Banks and stock exchanges", lambda: run_check(united_states_only(banks_and_exchanges(groups)), "United States banks and stock exchanges")),
        ("Tech only", lambda: run_check(united_states_only(tech_sites(groups)), "United States tech")),
        ("Utilities only", lambda: run_check(united_states_only(utility_sites(groups)), "United States utilities")),
        ("Government only", lambda: run_check(united_states_only(government_sites(groups)), "United States government")),
        ("Education", lambda: run_check(united_states_only(of_kinds(groups["institutions"], "education")), "United States education")),
        ("Medical", lambda: run_check(united_states_only(of_kinds(groups["institutions"], "medical")), "United States medical")),
        ("Stock exchanges", lambda: run_check(united_states_only(of_kinds(groups["institutions"], "exchanges")), "United States stock exchanges")),
        ("Transportation", lambda: run_check(united_states_only(groups["transport"]), "United States transportation")),
        ("Stores", lambda: run_check(united_states_only(groups["stores"]), "United States stores")),
        ("Communications", lambda: run_check(united_states_only(groups["communications"]), "United States communications")),
        ("Military", lambda: run_check(united_states_only(groups["military"]), "United States military")),
        ("Shipping", lambda: run_check(united_states_only(groups["shipping"]), "United States shipping")),
        ("Food", lambda: run_check(united_states_only(groups["food"]), "United States food")),
        ("Weather", lambda: run_check(united_states_only(groups["weather"]), "United States weather")),
    ]
    show_menu("United States", choices, "Back")


def country_menu(groups: dict) -> None:
    world = groups["world"]
    countries: list[str] = []
    seen: set[str] = set()
    for title, _group in world:
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        countries.append(title)
    countries.sort(key=str.lower)
    if not countries:
        print("No countries found in the world government list.")
        return
    print()
    print("Choose a country")
    print("The United States opens another menu.")
    print()
    for number, name in enumerate(countries, start=1):
        print(f"{number:3}  {name}")
    print("  0  Back")
    print()
    choice = choose_number(len(countries))
    if choice is None or choice == 0:
        return
    country = countries[choice - 1]
    if country == "United States":
        united_states_menu(groups)
        return
    picked = filter_sections(world, lambda entry, name=country: entry.get("country") == name)
    run_check(picked, country)


def add_place(entries: list[dict]) -> None:
    print()
    print("Add a place")
    name = ask("Name: ")
    if name is None:
        return
    name = " ".join(name.split())
    if not name:
        print("A name is required.")
        return
    if "|" in name:
        print("Leave the | character out of the name.")
        return

    raw = ask("IP or web address: ")
    if raw is None:
        return
    address = normalize_address(raw or "")
    if address is None:
        print("Enter an IP address or a web address, such as 192.168.1.1 or example.com.")
        return

    existing = find_entry(entries, address)
    if existing is not None:
        print(f"Already on the list as {existing['name']} ({existing['address']}).")
        return

    print("Looking up the location...")
    found = locate_host(address)
    entry = {"name": name, "address": address}
    if found and found.get("location"):
        entry["location"] = found["location"]
        entry["lat"] = found.get("lat")
        entry["lon"] = found.get("lon")
        entry["ip"] = found.get("ip")
    elif found and found.get("ip"):
        entry["ip"] = found["ip"]

    saved = load_saved()
    saved.append(entry)
    write_saved(saved)
    print("Saved. This place will be checked from now on.")
    print(name)
    print(f"Address: {checked_address(entry)}")
    if entry.get("location"):
        print(f"Location: {entry['location']}")
    else:
        print("Location: not found")


def main() -> int:
    while True:
        sections, list_error = collect_sections()
        tag_list(sections)
        world = load_world()
        groups = load_groups(sections, world)
        print()
        print("Downtime")
        if list_error:
            print(list_error)
        if world_path() is None:
            print(f"Cannot find the world government list: {WORLD_LIST}")
        else:
            print(f"{len(all_entries(world))} world government sites.")
        if institutions_path() is None:
            print(f"Cannot find the institutions list: {INSTITUTIONS_LIST}")
        if transportation_path() is None:
            print(f"Cannot find the transportation list: {TRANSPORT_LIST}")
        print(f"{len(all_entries(groups['institutions']))} schools, hospitals, banks, and exchanges.")
        print(f"{len(all_entries(groups['transport']))} transportation sites.")
        print(f"{len(all_entries(groups['stores']))} stores.")
        print(f"{len(all_entries(groups['communications']))} TV, phone, radio, and internet sites.")
        print(f"{len(all_entries(groups['military']))} military sites.")
        print()
        choices = [
            ("Search everything", lambda: run_check(everything(groups), "Everything")),
            ("World governments", lambda: run_check(world, "World governments")),
            ("United States", lambda: united_states_menu(groups)),
            ("Banks and stock exchanges", lambda: run_check(banks_and_exchanges(groups), "Banks and stock exchanges")),
            ("Tech only", lambda: run_check(tech_sites(groups), "Tech")),
            ("Utilities only", lambda: run_check(utility_sites(groups), "Utilities")),
            ("Education", lambda: run_check(of_kinds(groups["institutions"], "education"), "Education")),
            ("Medical", lambda: run_check(of_kinds(groups["institutions"], "medical"), "Medical")),
            ("Stock exchanges", lambda: run_check(of_kinds(groups["institutions"], "exchanges"), "Stock exchanges")),
            ("Transportation", lambda: run_check(groups["transport"], "Transportation")),
            ("Stores", lambda: run_check(groups["stores"], "Stores")),
            ("Communications", lambda: run_check(groups["communications"], "Communications")),
            ("Military", lambda: run_check(groups["military"], "Military")),
            ("Shipping", lambda: run_check(groups["shipping"], "Shipping")),
            ("Food", lambda: run_check(groups["food"], "Food")),
            ("Weather", lambda: run_check(groups["weather"], "Weather")),
            ("Choose a country", lambda: country_menu(groups)),
            ("Add a place", lambda: add_place(all_entries(everything(groups)))),
        ]
        for number, (label, _action) in enumerate(choices, start=1):
            print(f"{number:2}  {label}")
        print(" 0  Quit")
        print()
        choice = choose_number(len(choices))
        if choice is None or choice == 0:
            return 0
        choices[choice - 1][1]()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nStopped.")
        raise SystemExit(130)
